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
const MAX_CONCURRENT_DOWNLOADS = 5;
const TEMP_DIR = path.join(os.tmpdir(), 'yt_downloader_nodejs_');
const CLEANUP_INTERVAL = 3600 * 1000; // 1 jam
const COOKIE_PATH = path.join(TEMP_DIR, 'cookies.txt');
const CACHE_TTL = 10 * 60 * 1000; // Cache aktif selama 10 menit

// --- INISIALISASI ---

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
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Buat direktori logs jika tidak ada
const logsDir = path.join(process.cwd(), 'logs');
fs.mkdir(logsDir, { recursive: true }).catch(err => {
  if (err.code !== 'EEXIST') logger.error('Failed to create logs directory:', err);
});

// Inisialisasi Cache
const cache = new Map();

// Inisialisasi yt-dlp-wrap
const ytDlpWrap = new YTDlpWrap();

// Inisialisasi Cookie
const cookieTxt = process.env.YOUTUBE_COOKIES || '';
let isCookieReady = false;
async function initializeCookie() {
    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
        if (cookieTxt.trim()) {
            await fs.writeFile(COOKIE_PATH, cookieTxt.trim() + '\n');
            logger.info(`Cookie file created at: ${COOKIE_PATH}`);
            isCookieReady = true;
        }
    } catch (e) {
        logger.error(`Cookie write error: ${e.message}`);
    }
}

// Opsi yt-dlp untuk streaming dan info
let ytDlpOptions = {
    noCallHome: true,
    noCacheDir: true, // Kita gunakan cache kita sendiri
    addHeader: [
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
    ]
};

// Simple semaphore implementation untuk mengontrol konkurensi
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

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// Middleware untuk logging request
app.use((req, res, next) => {
  const start = Date.now();
  const clientIp = getClientIp(req);
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = { method: req.method, url: req.url, statusCode: res.statusCode, duration: `${duration}ms`, ip: clientIp, userAgent: req.get('User-Agent') };
    if (res.statusCode >= 400) logger.warn('HTTP Request', logData);
    else logger.info('HTTP Request', logData);
  });
  next();
});

// --- FUNGSI PEMBANTU ---

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || (req.connection.socket ? req.connection.socket.remoteAddress : null);
}

function createContentDispositionHeader(filename) {
    const encodedFilename = encodeURIComponent(filename);
    return `attachment; filename*=UTF-8''${encodedFilename}`;
}

// Fungsi untuk menjalankan yt-dlp via shell (untuk unduhan berat) dengan progress logging
function execYtdlp(command, clientIp, downloadId) {
    return new Promise((resolve, reject) => {
        logger.info(`Executing yt-dlp command: ${command.substring(0, 100)}...`);
        
        // Tambahkan flag --newline untuk memastikan setiap update progress ada di baris baru
        const commandWithProgress = command.replace('yt-dlp', 'yt-dlp --newline --progress');
        
        const child = exec(commandWithProgress, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                logger.error(`yt-dlp error: ${stderr}`);
                return reject(new Error(`Gagal menjalankan yt-dlp: ${stderr}`));
            }
            resolve(stdout);
        });
        
        // Logging progress dari stderr
        let lastProgressLog = 0;
        child.stderr.on('data', (data) => {
            const now = Date.now();
            // Log progress setiap 5 detik untuk menghindari spam log
            if (now - lastProgressLog > 5000) {
                const progressData = data.toString();
                
                // Parse progress dari yt-dlp
                const progressMatch = progressData.match(/(\d+\.?\d*)%/);
                const speedMatch = progressData.match(/(\d+\.?\d*\w*\/s)/);
                const etaMatch = progressData.match(/ETA (\d+:\d+)/);
                
                if (progressMatch) {
                    const progress = progressMatch[1];
                    const speed = speedMatch ? speedMatch[1] : 'Unknown';
                    const eta = etaMatch ? etaMatch[1] : 'Unknown';
                    
                    logger.info(`Download progress [${downloadId}] from ${clientIp}: ${progress}% at ${speed}, ETA: ${eta}`);
                    lastProgressLog = now;
                }
            }
        });
    });
}

// Fungsi helper untuk menjalankan exec dengan Promise
function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                return reject(error);
            }
            resolve({ stdout, stderr });
        });
    });
}

async function findFileInDir(directory, extensions) {
    try {
        const files = await fs.readdir(directory);
        for (const ext of extensions) {
            const file = files.find(f => f.endsWith(`.${ext}`));
            if (file) return path.join(directory, file);
        }
    } catch (e) {
        logger.error(`Error reading temp directory: ${e.message}`);
    }
    return null;
}

// Fungsi Cache
function getCachedData(key) {
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return cached.data;
    }
    cache.delete(key);
    return null;
}
function setCachedData(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
}

// Fungsi Pencarian Stream Terbaik
function getBestVideoStreamUrl(info, resolution) {
    const formats = info.formats || [];
    const targetResolution = parseInt(resolution, 10) || Infinity;
    // Cari format video+audio terbaik yang <= target resolusi
    let validFormats = formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.height && f.height <= targetResolution);
    if (validFormats.length === 0) validFormats = formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none');
    if (validFormats.length > 0) {
        validFormats.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0));
        return validFormats[0].url;
    }
    return null;
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

// Fungsi Proxy Streaming
async function proxyStream(req, res, streamUrl, mediaType) {
    try {
        const response = await axios({ 
            method: 'GET', 
            url: streamUrl, 
            responseType: 'stream', 
            headers: { 
                'User-Agent': req.get('User-Agent'), 
                'Range': req.get('Range') // Penting untuk seek video
            } 
        });
        res.status(response.status);
        res.header('Content-Type', response.headers['content-type'] || mediaType);
        ['content-range', 'accept-ranges', 'content-length'].forEach(h => { 
            if (response.headers[h]) res.header(h, response.headers[h]); 
        });
        response.data.pipe(res);
    } catch (error) {
        logger.error(`Proxy stream error: ${error.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to proxy stream.' });
    }
}

// Fungsi Utama untuk Unduhan Langsung dengan progress logging
async function handleDownload(req, res, ydlOptions, fileExtensions, tempDirPrefix) {
    const { url } = req.query;
    const clientIp = getClientIp(req);
    const downloadType = tempDirPrefix.includes('audio') ? 'audio' : 'video';
    const downloadId = `${downloadType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    if (!url) return res.status(400).json({ detail: "Query 'url' diperlukan" });

    const tempDir = path.join(TEMP_DIR, `${tempDirPrefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    logger.info(`Processing ${downloadType} download [${downloadId}] from ${clientIp} to ${tempDir}`);

    const outputPath = path.join(tempDir, '%(title)s.%(ext)s');
    const cookieOption = isCookieReady ? `--cookies ${COOKIE_PATH}` : '';
    const command = `yt-dlp ${cookieOption} ${ydlOptions} -o "${outputPath}" "${url}"`;

    try {
        const startTime = Date.now();
        await downloadLimit.execute(() => execYtdlp(command, clientIp, downloadId));
        const mediaFile = await findFileInDir(tempDir, fileExtensions);
        if (!mediaFile) throw new Error("File media tidak ditemukan setelah pemrosesan");

        const title = path.basename(mediaFile, path.extname(mediaFile));
        const stats = await fs.stat(mediaFile);
        const contentType = fileExtensions.includes('mp3') ? 'audio/mpeg' : 'video/mp4';
        const downloadTime = (Date.now() - startTime) / 1000;
        
        logger.info(`${downloadType} download [${downloadId}] completed: ${title}, Size: ${(stats.size / 1024 / 1024).toFixed(2)}MB, Time: ${downloadTime}s, IP: ${clientIp}`);

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', createContentDispositionHeader(`${title}${path.extname(mediaFile)}`));
        res.setHeader('Content-Length', stats.size);
        require('fs').createReadStream(mediaFile).pipe(res);

        res.on('finish', async () => {
            logger.info(`Response sent for ${downloadType} download [${downloadId}], cleaning up: ${tempDir}`);
            try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (e) { logger.error(`Cleanup error: ${e.message}`); }
        });

    } catch (e) {
        logger.error(`${downloadType} download [${downloadId}] failed: ${e.message} from ${clientIp}`);
        try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (cleanupError) { logger.error(`Error cleanup: ${cleanupError.message}`); }
        if (!res.headersSent) res.status(500).json({ detail: `Unduhan gagal: ${e.message}` });
    }
}

// --- ENDPOINTS ---

app.get('/', (req, res) => {
    res.json({ 
        message: "Server YouTube Hybrid aktif!", 
        version: "2.0.0 (Download & Streaming)",
        features: ["info", "get-formats", "search", "download", "download-audio", "stream-video", "stream-audio"],
        cookies: isCookieReady ? "loaded" : "none"
    });
});

// Endpoint Info (menggunakan yt-dlp-wrap untuk efisiensi dan cache)
app.get('/info', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ detail: "Query 'url' diperlukan" });
    try {
        let info = getCachedData(url);
        if (info) logger.info(`Cache hit for info: ${url}`);
        else {
            logger.info(`Fetching info for: ${url}`);
            info = await ytDlpWrap.getVideoInfo(url, ytDlpOptions);
            setCachedData(url, info);
        }
        res.json({ title: info.title, author: info.uploader, duration: info.duration, thumbnail: info.thumbnail });
    } catch (e) {
        logger.error(`Failed to fetch info: ${e.message}`);
        res.status(400).json({ detail: `Gagal mengekstrak info: ${e.message}` });
    }
});

// Endpoint Format (menggunakan yt-dlp-wrap untuk efisiensi dan cache)
app.get('/get-formats', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ detail: "Query 'url' diperlukan" });
    try {
        let info = getCachedData(url);
        if (!info) {
            info = await ytDlpWrap.getVideoInfo(url, ytDlpOptions);
            setCachedData(url, info);
        }
        const resolutions = [...new Set(info.formats.filter(f => f.vcodec !== 'none' && f.height).map(f => String(f.height)))].sort((a, b) => parseInt(a) - parseInt(b));
        res.json({ formats: resolutions });
    } catch (e) {
        logger.error(`Failed to fetch formats: ${e.message}`);
        res.status(400).json({ detail: `Gagal mengekstrak format: ${e.message}` });
    }
});

// Endpoint Pencarian (PERBAIKAN)
app.get('/search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ detail: "Query 'query' diperlukan" });
    try {
        logger.info(`Searching for: ${query}`);
        
        // PERBAIKAN: Gunakan exec untuk menjalankan yt-dlp search
        const command = `yt-dlp --dump-json "ytsearch10:${query}"`;
        const { stdout } = await execPromise(command);
        
        // Parse output JSON
        const lines = stdout.trim().split('\n');
        const videos = lines.map(line => JSON.parse(line));
        
        // Format hasil pencarian
        const formattedResults = videos.map(video => ({
            id: video.id,
            title: video.title,
            channel: video.uploader || video.channel,
            duration: video.duration,
            thumbnail: video.thumbnail
        }));
        
        res.json({ results: formattedResults });
    } catch (e) {
        logger.error(`Search failed: ${e.message}`);
        res.status(500).json({ detail: `Pencarian gagal: ${e.message}` });
    }
});

// --- ENDPOINT UNDUHAN ---
app.get('/download', (req, res) => {
    const quality = req.query.quality || "1080";
    const ydlOptions = `-f "best[height<=${quality}]+bestaudio/best[height<=${quality}]/best" --merge-output-format mp4 --retries 3`;
    handleDownload(req, res, ydlOptions, ["mp4", "webm", "mkv"], "download_video");
});

app.get('/download-audio', (req, res) => {
    const quality = req.query.quality || "best";
    const formatSelector = quality === "best" ? 'bestaudio/best' : `bestaudio[abr<=${quality}]/bestaudio`;
    const ydlOptions = `-f "${formatSelector}" -x --audio-format mp3 --audio-quality ${quality === "best" ? 0 : quality} --embed-thumbnail --retries 3`;
    handleDownload(req, res, ydlOptions, ["mp3"], "download_audio");
});

// --- ENDPOINT STREAMING ---
app.get('/stream-video', async (req, res) => {
    const { url, resolution = '1080' } = req.query;
    if (!url) return res.status(400).json({ detail: "Query 'url' diperlukan" });
    try {
        let info = getCachedData(url);
        if (!info) { info = await ytDlpWrap.getVideoInfo(url, ytDlpOptions); setCachedData(url, info); }
        const streamUrl = getBestVideoStreamUrl(info, resolution);
        if (!streamUrl) return res.status(404).json({ detail: 'Tidak dapat menemukan URL stream video yang sesuai' });
        await proxyStream(req, res, streamUrl, 'video/mp4');
    } catch (e) {
        logger.error(`Video streaming failed: ${e.message}`);
        if (!res.headersSent) res.status(500).json({ detail: `Video streaming gagal: ${e.message}` });
    }
});

app.get('/stream-audio', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ detail: "Query 'url' diperlukan" });
    try {
        let info = getCachedData(url);
        if (!info) { info = await ytDlpWrap.getVideoInfo(url, ytDlpOptions); setCachedData(url, info); }
        const streamUrl = getBestAudioStreamUrl(info);
        if (!streamUrl) return res.status(404).json({ detail: 'Tidak dapat menemukan URL stream audio yang sesuai' });
        await proxyStream(req, res, streamUrl, 'audio/mpeg');
    } catch (e) {
        logger.error(`Audio streaming failed: ${e.message}`);
        if (!res.headersSent) res.status(500).json({ detail: `Audio streaming gagal: ${e.message}` });
    }
});

// --- TUGAS PEMBERSIHAN & STARTUP ---
async function cleanupTask() {
    logger.info("Running periodic cleanup...");
    try {
        const dirs = await fs.readdir(TEMP_DIR);
        let cleanedDirs = 0;
        for (const dir of dirs) {
            const dirPath = path.join(TEMP_DIR, dir);
            const stats = await fs.stat(dirPath);
            if (Date.now() - stats.mtimeMs > CLEANUP_INTERVAL) {
                await fs.rm(dirPath, { recursive: true, force: true });
                cleanedDirs++;
            }
        }
        logger.info(`Periodic cleanup completed. Cleaned ${cleanedDirs} directories.`);
    } catch (e) {
        logger.error(`Error during periodic cleanup: ${e.message}`);
    }
}

async function startServer() {
    await initializeCookie();
    // Perbarui opsi yt-dlp-wrap setelah cookie siap
    if (isCookieReady) {
        ytDlpOptions.cookies = COOKIE_PATH;
    }
    setInterval(cleanupTask, CLEANUP_INTERVAL);
    app.listen(PORT, () => {
        logger.info(`Server is running on http://localhost:${PORT}`);
        logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
        logger.info(`Cookie status: ${isCookieReady ? 'loaded' : 'none'}`);
        logger.info(`Max concurrent downloads: ${MAX_CONCURRENT_DOWNLOADS}`);
        logger.info(`Temporary directory: ${TEMP_DIR}`);
    }); 
}

startServer();

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info("Shutting down gracefully...");
    try {
        await fs.rm(TEMP_DIR, { recursive: true, force: true });
        logger.info("Cleaned up temporary directory on shutdown");
    } catch (e) {
        logger.error(`Error during shutdown cleanup: ${e.message}`);
    }
    process.exit(0);
});