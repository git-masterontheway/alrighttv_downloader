const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3030;
const API_BASE = process.env.API_BASE || 'https://alright-tv-premium.wasmer.app/api.php';
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(__dirname, 'downloads');

// Cross-platform FFmpeg resolver (Render Linux + local Windows)
let FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
try {
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    FFMPEG_PATH = ffmpegStatic;
    try {
      fs.chmodSync(FFMPEG_PATH, 0o755);
    } catch (_) {}
  }
} catch (e) {
  console.warn('ffmpeg-static not found, falling back to system ffmpeg');
}

console.log(`[FFmpeg] Configured binary path: ${FFMPEG_PATH}`);

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Origin', 'Accept']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health checks for Render
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

// In-memory active job tracker & cache
const jobs = new Map();
let featuredCache = { data: null, timestamp: 0 };

// Server Single-Job Lock & Cooldown to prevent Render memory crashes
let activeJobId = null;
let activeJobStartedAt = 0;
let lastJobCompletedAt = 0;
const COOLDOWN_MINUTES = 5; // 5-minute interval between heavy downloads
const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30-minute safety timeout

// Helper: Run FFmpeg process with memory-safe arguments and detailed error/signal reporting
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    // Add memory and stability flags: single thread to prevent OOM on Render 512MB RAM
    const safeArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      ...args
    ];

    const proc = spawn(FFMPEG_PATH, safeArgs, { 
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const errorDetail = stderr.trim() || `Process terminated with signal: ${signal || 'none'}`;
        reject(new Error(`FFmpeg exited with code ${code} (signal: ${signal}): ${errorDetail}`));
      }
    });
    proc.on('error', (err) => {
      // Fallback attempt with system 'ffmpeg' if ffmpeg-static fails
      if (FFMPEG_PATH !== 'ffmpeg') {
        console.warn(`[FFmpeg] Failed with ${FFMPEG_PATH}, retrying with system ffmpeg...`);
        FFMPEG_PATH = 'ffmpeg';
        runFFmpeg(args).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
}

// Helper: Fetch with retry
async function fetchWithRetry(url, retries = 5, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Helper: Stream HLS directly to local disk with Node.js fetch (completely avoids FFmpeg glibc DNS/TLS SIGSEGV crashes on Render)
async function downloadHlsToMp4(m3u8Url, outFile, tempDir) {
  // 1. Fetch master or media m3u8 playlist with native Node.js fetch
  const masterRes = await fetch(m3u8Url);
  if (!masterRes.ok) throw new Error(`Failed to load m3u8: HTTP ${masterRes.status}`);
  let m3u8Text = await masterRes.text();

  let mediaUrl = m3u8Url;
  const lines = m3u8Text.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const next = lines[i + 1];
      if (next && !next.startsWith('#')) {
        mediaUrl = next.startsWith('http') ? next : new URL(next, m3u8Url).href;
      }
    }
  }

  if (mediaUrl !== m3u8Url) {
    const subRes = await fetch(mediaUrl);
    if (!subRes.ok) throw new Error(`Failed to load sub-m3u8: HTTP ${subRes.status}`);
    m3u8Text = await subRes.text();
  }

  // 2. Extract segment URLs
  const segLines = m3u8Text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (segLines.length === 0) throw new Error('No video segments found in m3u8 playlist');

  const segmentUrls = segLines.map(line => line.startsWith('http') ? line : new URL(line, mediaUrl).href);

  // 3. Download segments sequentially to local temp .ts file (minimal memory footprint)
  const tempTs = path.join(tempDir, `stream_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.ts`);
  const outStream = fs.createWriteStream(tempTs);

  for (let s = 0; s < segmentUrls.length; s++) {
    const sUrl = segmentUrls[s];
    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const segRes = await fetch(sUrl);
        if (!segRes.ok) throw new Error(`HTTP ${segRes.status}`);
        const buf = Buffer.from(await segRes.arrayBuffer());
        outStream.write(buf);
        success = true;
        break;
      } catch (err) {
        if (attempt === 2) throw new Error(`Segment ${s + 1}/${segmentUrls.length} failed: ${err.message}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  await new Promise((resolve, reject) => {
    outStream.end(resolve);
    outStream.on('error', reject);
  });

  // 4. Remux local .ts file to .mp4 using FFmpeg locally (no network calls, zero DNS, zero SIGSEGV)
  try {
    await runFFmpeg([
      '-y',
      '-threads', '1',
      '-i', tempTs,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      outFile
    ]);
  } finally {
    try { if (fs.existsSync(tempTs)) fs.unlinkSync(tempTs); } catch (_) {}
  }
}

// API: Featured / Home content (New Releases, Trending, Dramas)
app.get('/api/featured', async (req, res) => {
  const now = Date.now();
  // Return cached data if fresh (5 minutes cache)
  if (featuredCache.data && (now - featuredCache.timestamp < 300000)) {
    return res.json(featuredCache.data);
  }

  try {
    const data = await fetchWithRetry(`${API_BASE}?action=homev2&tab=&lang=&_=${now}`);
    if (!data.status) throw new Error(data.error || 'Failed to fetch featured content');

    // Organize sections into clean, curated collections
    const rawSections = data.sections || [];
    const curated = [];

    // 1. Trending & Popular
    const popularSec = rawSections.find(s => /popular/i.test(s.title)) || rawSections.find(s => /trending/i.test(s.title));
    if (popularSec && popularSec.items?.length) {
      curated.push({
        id: 'trending',
        title: '🔥 Trending & Most Watched',
        badge: 'TRENDING',
        items: popularSec.items
      });
    }

    // 2. New Releases
    const newSec = rawSections.find(s => /new release/i.test(s.title)) || rawSections.find(s => /new/i.test(s.title));
    if (newSec && newSec.items?.length) {
      curated.push({
        id: 'new_releases',
        title: '⭐ New Releases & Daily Drops',
        badge: 'NEW',
        items: newSec.items
      });
    }

    // 3. Romance & Love Dramas
    const romanceSec = rawSections.find(s => /romance/i.test(s.title)) || rawSections.find(s => /dil se/i.test(s.title));
    if (romanceSec && romanceSec.items?.length) {
      curated.push({
        id: 'romance',
        title: '💖 Romantic & Emotional Dramas',
        badge: 'ROMANCE',
        items: romanceSec.items
      });
    }

    // 4. CEO & Billionaire Dramas
    const ceoSec = rawSections.find(s => /ceo|billionaire|betrayal/i.test(s.title));
    if (ceoSec && ceoSec.items?.length) {
      curated.push({
        id: 'ceo',
        title: '👑 CEO & High Stakes Dramas',
        badge: 'DRAMA',
        items: ceoSec.items
      });
    }

    // 5. Binge-worthy Series / Other rails
    const bingeSec = rawSections.find(s => /binge/i.test(s.title)) || rawSections.find(s => /recommended/i.test(s.title));
    if (bingeSec && bingeSec.items?.length) {
      curated.push({
        id: 'binge',
        title: '🍿 Binge-Worthy Web Series',
        badge: 'BINGE',
        items: bingeSec.items
      });
    }

    // Fallback: Add all non-empty sections if curated list is small
    if (curated.length === 0) {
      rawSections.filter(s => s.items?.length).forEach((s, idx) => {
        curated.push({
          id: `sec_${idx}`,
          title: s.title || 'Featured Shows',
          badge: 'FEATURED',
          items: s.items
        });
      });
    }

    const payload = {
      status: true,
      hero: data.hero || null,
      categories: curated
    };

    featuredCache = { data: payload, timestamp: now };
    res.json(payload);
  } catch (err) {
    res.status(500).json({ status: false, error: err.message });
  }
});

// API: Search
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ status: false, error: 'Search query is required' });

  try {
    const data = await fetchWithRetry(`${API_BASE}?action=search&q=${encodeURIComponent(query)}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ status: false, error: err.message });
  }
});

// API: Series Detail & Seasons
app.get('/api/detail', async (req, res) => {
  const id = req.query.id;
  const season = req.query.season || 1;
  if (!id) return res.status(400).json({ status: false, error: 'Series ID required' });

  try {
    const data = await fetchWithRetry(`${API_BASE}?action=detail&id=${encodeURIComponent(id)}&season=${season}&_=${Date.now()}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ status: false, error: err.message });
  }
});

// API: Server Queue & Health Status
app.get('/api/server-queue-status', (req, res) => {
  const isBusy = !!activeJobId && jobs.has(activeJobId);
  const activeJob = isBusy ? jobs.get(activeJobId) : null;
  const now = Date.now();
  let remainingCooldownSec = 0;

  if (!isBusy && lastJobCompletedAt > 0) {
    const elapsed = now - lastJobCompletedAt;
    if (elapsed < COOLDOWN_MS) {
      remainingCooldownSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    }
  }

  res.json({
    status: true,
    isBusy,
    activeJob: activeJob ? {
      title: activeJob.seriesTitle,
      season: activeJob.season,
      progress: activeJob.progress,
      status: activeJob.status
    } : null,
    inCooldown: remainingCooldownSec > 0,
    remainingCooldownSec
  });
});

// API: Start Season Download Job (strictly 1 active job at a time + 5-min stability interval)
app.post('/api/download-season', async (req, res) => {
  const { movieId, seriesTitle, season } = req.body;
  if (!movieId || !season) {
    return res.status(400).json({ status: false, error: 'movieId and season are required' });
  }

  const cleanTitle = (seriesTitle || 'Show').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  const finalFileName = `${cleanTitle} S${season}.mp4`;
  const finalFilePath = path.join(DOWNLOADS_DIR, finalFileName);

  // 1. Instant Cache: Check if already downloaded on server
  if (fs.existsSync(finalFilePath) && fs.statSync(finalFilePath).size > 1000000) {
    const sizeMB = (fs.statSync(finalFilePath).size / 1024 / 1024).toFixed(1);
    const cachedJobId = `job_cached_${Date.now()}`;
    jobs.set(cachedJobId, {
      jobId: cachedJobId,
      movieId,
      seriesTitle: cleanTitle,
      season: Number(season),
      status: 'completed',
      progress: 100,
      totalEpisodes: 1,
      currentEpisode: 1,
      message: `Completed! Instant download from server cache (${sizeMB} MB)`,
      finalFileName,
      fileUrl: `/api/download-file/${encodeURIComponent(finalFileName)}`,
      fileSizeMB: sizeMB,
      error: null
    });
    return res.json({ status: true, jobId: cachedJobId, cached: true });
  }

  const now = Date.now();

  // 2. Mutual Exclusion: Check if another download is currently processing
  if (activeJobId) {
    const activeJob = jobs.get(activeJobId);
    // Timeout safeguard: If active job ran over 30 mins, unlock
    if (activeJobStartedAt && (now - activeJobStartedAt > JOB_TIMEOUT_MS)) {
      console.warn(`[Queue] Active job ${activeJobId} timed out. Resetting lock.`);
      activeJobId = null;
    } else if (activeJob && ['fetching_episodes', 'downloading', 'merging', 'queued'].includes(activeJob.status)) {
      // If user requested the same show & season, return active job to track
      if (String(activeJob.movieId) === String(movieId) && Number(activeJob.season) === Number(season)) {
        return res.json({ status: true, jobId: activeJob.jobId, inProgress: true });
      }

      return res.status(429).json({
        status: false,
        error: `Server is currently processing "${activeJob.seriesTitle} Season ${activeJob.season}" (${activeJob.progress}%). To prevent server crashes, only 1 download is processed at a time. Please wait until it completes.`
      });
    } else {
      activeJobId = null;
    }
  }

  // 3. Stability Interval: Check 5-minute cool-down interval after last completed job
  if (lastJobCompletedAt > 0) {
    const elapsed = now - lastJobCompletedAt;
    if (elapsed < COOLDOWN_MS) {
      const remainingSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      const remainingMin = Math.ceil(remainingSec / 60);
      return res.status(429).json({
        status: false,
        error: `Server is cooling down to ensure stability after the previous download. Next download will be accepted in ${remainingMin}m (${remainingSec}s).`
      });
    }
  }

  // 4. Accept New Job and acquire lock
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  activeJobId = jobId;
  activeJobStartedAt = Date.now();

  jobs.set(jobId, {
    jobId,
    movieId,
    seriesTitle: cleanTitle,
    season: Number(season),
    status: 'queued',
    progress: 0,
    totalEpisodes: 0,
    currentEpisode: 0,
    message: 'Queued for processing...',
    finalFileName,
    fileUrl: null,
    fileSizeMB: null,
    error: null
  });

  // Return jobId immediately
  res.json({ status: true, jobId });

  // Execute job asynchronously in background
  executeDownloadJob(jobId, movieId, cleanTitle, Number(season), finalFilePath, finalFileName);
});

// Background Worker for Job
async function executeDownloadJob(jobId, movieId, title, season, finalFilePath, finalFileName) {
  const job = jobs.get(jobId);
  const tempDir = path.join(__dirname, `temp_${jobId}`);

  try {
    job.status = 'fetching_episodes';
    job.message = `Loading episodes for Season ${season}...`;

    const detailData = await fetchWithRetry(`${API_BASE}?action=detail&id=${movieId}&season=${season}&_=${Date.now()}`);
    if (!detailData.status || !detailData.episodes || detailData.episodes.length === 0) {
      throw new Error(`No episodes found for Season ${season}`);
    }

    const episodes = detailData.episodes;
    job.totalEpisodes = episodes.length;
    job.status = 'downloading';
    job.message = `Downloading 0 / ${episodes.length} episodes...`;

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const downloadedFiles = new Array(episodes.length);
    // Sequential download to avoid Render Free Tier 512MB RAM OOM limits
    const CONCURRENCY = 1;

    for (let i = 0; i < episodes.length; i += CONCURRENCY) {
      const chunk = episodes.slice(i, i + CONCURRENCY);
      for (let idx = 0; idx < chunk.length; idx++) {
        const ep = chunk[idx];
        const overallIdx = i + idx;
        const epPad = String(ep.episodeNumber || (overallIdx + 1)).padStart(2, '0');
        const outFile = path.join(tempDir, `ep_${epPad}.mp4`);

        // Fetch signed stream URL
        const streamData = await fetchWithRetry(
          `${API_BASE}?action=stream&movieId=${movieId}&episodeId=${ep.id}&hlsFileName=${ep.hlsFileName}&seasonNumber=${season}&episodeNumber=${ep.episodeNumber}`
        );

        if (!streamData.status || !streamData.streams || !streamData.streams[0]?.signedVideoUrl) {
          throw new Error(`Failed to fetch signed stream URL for episode ${ep.episodeNumber}`);
        }

        const m3u8Url = streamData.streams[0].signedVideoUrl;

        // Stream segments directly via native Node.js fetch, then remux locally (zero SIGSEGV)
        await downloadHlsToMp4(m3u8Url, outFile, tempDir);

        downloadedFiles[overallIdx] = outFile;
        job.currentEpisode++;
        job.progress = Math.round((job.currentEpisode / episodes.length) * 85);
        job.message = `Downloaded ${job.currentEpisode} / ${episodes.length} episodes...`;
      }
    }

    // Step: Concatenate all episodes into single video
    job.status = 'merging';
    job.message = `Losslessly merging all ${episodes.length} episodes into ${finalFileName}...`;
    job.progress = 90;

    const concatListPath = path.join(tempDir, 'concat_list.txt');
    const fileLines = downloadedFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(concatListPath, fileLines, 'utf-8');

    if (fs.existsSync(finalFilePath)) {
      fs.unlinkSync(finalFilePath);
    }

    await runFFmpeg([
      '-y',
      '-threads', '1',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      finalFilePath
    ]);

    if (!fs.existsSync(finalFilePath) || fs.statSync(finalFilePath).size < 1000000) {
      throw new Error('Merged video file verification failed or file is too small');
    }

    const sizeMB = (fs.statSync(finalFilePath).size / 1024 / 1024).toFixed(1);

    // Mark Job Complete
    job.status = 'completed';
    job.progress = 100;
    job.message = `Successfully completed! File size: ${sizeMB} MB`;
    job.fileUrl = `/api/download-file/${encodeURIComponent(finalFileName)}`;
    job.fileSizeMB = sizeMB;

    // Release lock and start 5-minute cool-down period for stability
    activeJobId = null;
    lastJobCompletedAt = Date.now();
    console.log(`[Queue] Job ${jobId} completed successfully. Server entered ${COOLDOWN_MINUTES}-minute stability cooldown.`);

    // Clean up temporary files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    job.message = `Download failed: ${err.message}`;

    // Release lock on error, allow retry after 1 minute
    activeJobId = null;
    lastJobCompletedAt = Date.now() - (COOLDOWN_MS - 60000);
    console.warn(`[Queue] Job ${jobId} failed: ${err.message}. Lock released.`);

    try {
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// API: Job Status
app.get('/api/job-status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: false, error: 'Job not found' });
  res.json({ status: true, job });
});

// API: File Download Attachment Stream
app.get('/api/download-file/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found or expired.');
  }

  res.download(filePath, filename);
});

// API: File Media Player Stream with HTTP 206 Partial Content (Range) Support
app.get('/api/stream-file/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found or expired.');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes'
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Alright TV Downloader server running on 0.0.0.0:${PORT} (env: ${process.env.NODE_ENV || 'production'})`);
});

// Graceful termination for Render deployments
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received. Closing gracefully...');
  server.close(() => {
    console.log('[Server] Process closed.');
    process.exit(0);
  });
});
