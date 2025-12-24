// Memuat library yang diperlukan
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const winston = require('winston');
const YTDlpWrap = require('yt-dlp-wrap').default;
const axios = require('axios');

// --- KONFIGURASI UTAMA ---
const app = express();
const PORT = process.env.PORT || 8000;
const MAX_CONCURRENT_DOWNLOADS = 2; 

// Konfigurasi direktori temp
const TEMP_DIR = path.join(os.tmpdir(), 'yt_downloader_nodejs_');
const CLEANUP_INTERVAL = 3600 * 1000;
const COOKIE_PATH = path.join(TEMP_DIR, 'cookies.txt');
const CACHE_TTL = 10 * 60 * 1000; 

// --- PATH BINARY YTDLP ---
const YTDLP_BINARY_PATH = path.join(os.tmpdir(), 'yt-dlp'); 
const NODE_RUNTIME_PATH = 'node'; 

// --- INISIALISASI ---
let ytDlpWrap;
let isCookieReady = false;
let ffmpegAvailable = false;

// Konfigurasi logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'youtube-hybrid-server' },
  transports: [
    new winston.transports.Console({
        format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
        )
    })
  ],
});

// Buat direktori jika tidak ada
fs.mkdir(TEMP_DIR, { recursive: true }).catch(err => {
  if (err.code !== 'EEXIST') logger.error('Failed to create TEMP_DIR:', err);
});

const cache = new Map();
const cookieTxt = process.env.YOUTUBE_COOKIES || '';

// --- FUNGSI HELPER ---

async function checkFFmpeg() {
    try {
        await execPromise('ffmpeg -version', 5000);
        ffmpegAvailable = true;
        logger.info('FFmpeg is available');
        return true;
    } catch (e) {
        ffmpegAvailable = false;
        logger.warn('FFmpeg not found.');
        return false;
    }
}

async function initializeCookie() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
        if (cookieTxt.trim()) {
            // PERBAIKAN KRUSIAL: Sanitasi format cookie
            let cleanCookies = cookieTxt.trim();
            cleanCookies = cleanCookies.replace(/\\t/g, '\t');
            cleanCookies = cleanCookies.replace(/\\n/g, '\n');
            
            await fs.writeFile(COOKIE_PATH, cleanCookies + '\n');
            logger.info(`Cookie file created and sanitized at: ${COOKIE_PATH}`);
            isCookieReady = true;
        } else {
            logger.warn('YOUTUBE_COOKIES env var is missing. YouTube might block requests.');
        }
    } catch (e) {
        logger.error(`Cookie write error: ${e.message}`);
    }
}

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
            if (error) return reject(error);
            resolve({ stdout, stderr });
        });
    });
}

async function downloadYtDlpBinary() {
    try {
        try {
            const stats = await fs.stat(YTDLP_BINARY_PATH);
            if (stats.size > 1000) return; 
        } catch (e) {}

        logger.info('Downloading yt-dlp binary...');
        const arch = os.arch();
        let binaryUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
        
        if (arch === 'arm64') {
            binaryUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64';
        }

        const response = await axios({ method: 'GET', url: binaryUrl, responseType: 'stream' });
        const writer = require('fs').createWriteStream(YTDLP_BINARY_PATH);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        await fs.chmod(YTDLP_BINARY_PATH, '755');
        logger.info('yt-dlp binary downloaded and made executable.');
    } catch (error) {
        logger.error('Failed to download yt-dlp binary:', error.message);
        throw error;
    }
}

let ytDlpOptions = {
    noCallHome: true,
    noCacheDir: true,
    addHeader: [
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ]
};

// Simple Semaphore implementation
class Semaphore {
  constructor(maxConcurrency) {
    this.maxConcurrency = maxConcurrency;
    this.currentConcurrency = 0;
    this.queue = [];
  }
  async acquire() {
    return new Promise((resolve) => {
      if (this.currentConcurrency < this.maxConcurrency) {
        this.currentConcurrency++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }
  release() {
    this.currentConcurrency--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      this.currentConcurrency++;
      next();
    }
  }
  async execute(task) {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

const downloadLimit = new Semaphore(MAX_CONCURRENT_DOWNLOADS);

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.url} ${res.statusCode} - ${duration}ms - ${clientIp}`);
  });
  next();
});

// --- ROUTES ---

app.get('/', (req, res) => {
    res.json({ 
        message: "YouTube API Vercel (Cookie Fix)", 
        status: {
            yt_dlp: YTDLP_BINARY_PATH,
            ffmpeg: ffmpegAvailable ? "available" : "not available",
            cookie: isCookieReady ? "loaded" : "MISSING (CRITICAL)",
            node_runtime: NODE_RUNTIME_PATH
        }
    });
});

async function getInfo(url) {
    const cached = getCachedData(url);
    if (cached) return cached;

    const options = { ...ytDlpOptions };
    
    if (isCookieReady) options.cookies = COOKIE_PATH;
    options.jsRuntime = NODE_RUNTIME_PATH;

    try {
        const info = await ytDlpWrap.getVideoInfo(url, options);
        setCachedData(url, info);
        return info;
    } catch (e) {
        logger.warn("Wrapper failed, attempting manual exec...");
        return getVideoInfoManual(url);
    }
}

async function getVideoInfoManual(url) {
    const cookieOption = isCookieReady ? `--cookies "${COOKIE_PATH}"` : '';
    const jsRuntimeOption = `--js-runtime ${NODE_RUNTIME_PATH}`;
    const extractorArgs = '--extractor-args "youtube:player_client=android"'; 
    
    const command = `"${YTDLP_BINARY_PATH}" ${cookieOption} ${jsRuntimeOption} ${extractorArgs} --dump-json "${url}"`;
    
    try {
        const { stdout } = await execPromise(command);
        const info = JSON.parse(stdout);
        setCachedData(url, info);
        return info;
    } catch (e) {
        throw new Error(`Manual exec failed: ${e.message}`);
    }
}

function getCachedData(key) {
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) return cached.data;
    cache.delete(key);
    return null;
}

function setCachedData(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
}

app.get('/info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ detail: "Query 'url' diperlukan" });
    try {
        const info = await getInfo(url);
        res.json({ title: info.title, author: info.uploader, duration: info.duration, thumbnail: info.thumbnail });
    } catch (e) {
        logger.error(`/info error: ${e.message}`);
        res.status(500).json({ detail: e.message });
    }
});

app.get('/search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ detail: "Query 'query' diperlukan" });
    try {
        const cookieOption = isCookieReady ? `--cookies "${COOKIE_PATH}"` : '';
        const jsRuntimeOption = `--js-runtime ${NODE_RUNTIME_PATH}`;
        const extractorArgs = '--extractor-args "youtube:player_client=android"';
        
        const command = `"${YTDLP_BINARY_PATH}" ${cookieOption} ${jsRuntimeOption} ${extractorArgs} --dump-json "ytsearch5:${query}"`;
        const { stdout } = await execPromise(command);
        const lines = stdout.trim().split('\n');
        const videos = lines.filter(line => line.trim()).map(line => JSON.parse(line));
        res.json({ results: videos.map(v => ({
            id: v.id, title: v.title, channel: v.uploader, duration: v.duration, thumbnail: v.thumbnail
        }))});
    } catch (e) {
        logger.error(`/search error: ${e.message}`);
        res.status(500).json({ detail: e.message });
    }
});

// --- STREAMING ---

function getBestVideoStreamUrl(info, resolution) {
    const formats = info.formats || [];
    const targetResolution = parseInt(resolution, 10) || Infinity;
    
    const progressiveFormats = formats.filter(f => 
        f.vcodec !== 'none' && f.acodec !== 'none' && 
        f.protocol !== 'hls' && f.protocol !== 'dash' && 
        f.height && f.height <= targetResolution
    );

    const mp4Formats = progressiveFormats.filter(f => f.ext === 'mp4');
    if (mp4Formats.length > 0) {
        mp4Formats.sort((a, b) => (b.height || 0) - (a.height || 0));
        return mp4Formats[0].url;
    }
    return progressiveFormats[0]?.url || null;
}

function getBestAudioStreamUrl(info) {
    const formats = info.formats || [];
    const audioFormats = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none');
    if (audioFormats.length > 0) {
        audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
        return audioFormats[0].url;
    }
    return null;
}

async function proxyStream(req, res, streamUrl, mediaType) {
    try {
        const response = await axios({ 
            method: 'GET', url: streamUrl, responseType: 'stream', 
            headers: { 'User-Agent': req.get('User-Agent'), 'Range': req.get('Range') } 
        });
        res.status(response.status);
        res.header('Content-Type', response.headers['content-type'] || mediaType);
        if (response.headers['content-length']) res.header('Content-Length', response.headers['content-length']);
        if (response.headers['content-range']) res.header('Content-Range', response.headers['content-range']);
        if (response.headers['accept-ranges']) res.header('Accept-Ranges', response.headers['accept-ranges']);
        response.data.pipe(res);
    } catch (error) {
        logger.error(`Proxy error: ${error.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
    }
}

app.get('/stream-video', async (req, res) => {
    const { url, resolution = '1080' } = req.query;
    if (!url) return res.status(400).json({ detail: "Query 'url' diperlukan" });
    try {
        const info = await getInfo(url);
        const streamUrl = getBestVideoStreamUrl(info, resolution);
        if (!streamUrl) return res.status(404).json({ detail: 'Stream tidak ditemukan' });
        await proxyStream(req, res, streamUrl, 'video/mp4');
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

app.get('/stream-audio', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ detail: "Query 'url' diperlukan" });
    try {
        const info = await getInfo(url);
        const streamUrl = getBestAudioStreamUrl(info);
        if (!streamUrl) return res.status(404).json({ detail: 'Stream tidak ditemukan' });
        await proxyStream(req, res, streamUrl, 'audio/mpeg');
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// --- DOWNLOAD ---

async function handleDownload(req, res, ydlOptions, fileExtensions, tempDirPrefix) {
    const { url } = req.query;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    const downloadType = tempDirPrefix.includes('audio') ? 'audio' : 'video';
    const downloadId = `${downloadType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    if (!url) return res.status(400).json({ detail: "Query 'url' diperlukan" });

    const tempDir = path.join(TEMP_DIR, `${tempDirPrefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    logger.info(`[${downloadId}] Processing download...`);

    const outputPath = path.join(tempDir, '%(title)s.%(ext)s');
    const cookieOption = isCookieReady ? `--cookies "${COOKIE_PATH}"` : '';
    const jsRuntimeOption = `--js-runtime ${NODE_RUNTIME_PATH}`;
    const extractorArgs = '--extractor-args "youtube:player_client=android"';
    
    const command = `"${YTDLP_BINARY_PATH}" ${cookieOption} ${jsRuntimeOption} ${extractorArgs} -f "${ydlOptions}" -o "${outputPath}" "${url}"`;

    try {
        await downloadLimit.execute(() => execPromise(command));
        const mediaFile = await fs.readdir(tempDir).then(files => {
            for (const ext of fileExtensions) {
                const file = files.find(f => f.endsWith(`.${ext}`));
                if (file) return path.join(tempDir, file);
            }
            return null;
        });
        
        if (!mediaFile) throw new Error("File tidak ditemukan");

        const stats = await fs.stat(mediaFile);
        const title = path.basename(mediaFile, path.extname(mediaFile));
        const contentType = fileExtensions.includes('mp3') ? 'audio/mpeg' : 'video/mp4';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(title + path.extname(mediaFile))}`);
        res.setHeader('Content-Length', stats.size);
        
        require('fs').createReadStream(mediaFile).pipe(res);

        res.on('finish', async () => {
            try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
        });

    } catch (e) {
        logger.error(`[${downloadId}] Error: ${e.message}`);
        try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
        if (!res.headersSent) res.status(500).json({ detail: e.message });
    }
}

app.get('/download', (req, res) => {
    const quality = req.query.quality || "1080";
    const formatSelector = `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
    handleDownload(req, res, formatSelector, ["mp4"], "download_video");
});

app.get('/download-audio', (req, res) => {
    handleDownload(req, res, "bestaudio[ext=m4a]/bestaudio", ["mp3", "m4a"], "download_audio");
});

// --- STARTUP ---

async function startServer() {
    await initializeCookie();
    await checkFFmpeg();
    await downloadYtDlpBinary();

    ytDlpWrap = new YTDlpWrap(YTDLP_BINARY_PATH);
    
    setInterval(async () => {
        try {
            const dirs = await fs.readdir(TEMP_DIR);
            for (const dir of dirs) {
                const dirPath = path.join(TEMP_DIR, dir);
                await fs.rm(dirPath, { recursive: true, force: true });
            }
        } catch (e) {}
    }, CLEANUP_INTERVAL);

    app.listen(PORT, () => {
        logger.info(`Server started on port ${PORT}`);
        logger.info(`Cookie Loaded: ${isCookieReady}`);
    });
}

startServer();
process.on('SIGINT', () => process.exit(0));