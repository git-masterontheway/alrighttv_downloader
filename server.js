const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3030;

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
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory active job tracker & cache
const jobs = new Map();
let featuredCache = { data: null, timestamp: 0 };

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

// API: Start Season Download Job
app.post('/api/download-season', async (req, res) => {
  const { movieId, seriesTitle, season } = req.body;
  if (!movieId || !season) {
    return res.status(400).json({ status: false, error: 'movieId and season are required' });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const cleanTitle = (seriesTitle || 'Show').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  const finalFileName = `${cleanTitle} S${season}.mp4`;
  const finalFilePath = path.join(DOWNLOADS_DIR, finalFileName);

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

        // Download stream memory-safely with reconnection and AAC bitstream fix
        await runFFmpeg([
          '-y',
          '-threads', '1',
          '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
          '-reconnect', '1',
          '-reconnect_at_eof', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
          '-i', m3u8Url,
          '-c', 'copy',
          '-bsf:a', 'aac_adtstoasc',
          '-movflags', '+faststart',
          '-f', 'mp4',
          outFile
        ]);

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

    // Clean up temporary files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    job.message = `Download failed: ${err.message}`;
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

// API: File Download Stream
app.get('/api/download-file/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found or expired.');
  }

  res.download(filePath, filename);
});

app.listen(PORT, () => {
  console.log(`Alright TV Downloader server running at http://localhost:${PORT}`);
});
