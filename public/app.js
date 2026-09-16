'use strict';

// Backend API configuration:
// Defaults to current origin when hosted unified on Render, or auto-routes to Render when hosted on free.nf
const DEFAULT_RENDER_BACKEND = 'https://alrighttv-downloader.onrender.com';
const BACKEND_URL = window.ALRIGHT_BACKEND_URL 
  || localStorage.getItem('ALRIGHT_BACKEND_URL') 
  || (window.location.hostname.includes('free.nf') ? DEFAULT_RENDER_BACKEND : '');

function apiUrl(endpoint) {
  if (!BACKEND_URL) return endpoint;
  return `${BACKEND_URL.replace(/\/+$/, '')}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
}

// Elements
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const categoryChips = document.getElementById('categoryChips');
const loadingSpinner = document.getElementById('loadingSpinner');
const spinnerText = document.getElementById('spinnerText');
const emptyState = document.getElementById('emptyState');

// Search Mode Elements
const searchHeaderRow = document.getElementById('searchHeaderRow');
const searchResultsHeading = document.getElementById('searchResultsHeading');
const searchResultsCount = document.getElementById('searchResultsCount');
const searchResultsGrid = document.getElementById('searchResultsGrid');
const backToFeaturedBtn = document.getElementById('backToFeaturedBtn');

// Featured Container
const featuredSectionsContainer = document.getElementById('featuredSectionsContainer');

// Job Card Elements
const jobCard = document.getElementById('jobCard');
const jobBadge = document.getElementById('jobBadge');
const jobTitle = document.getElementById('jobTitle');
const jobPercentage = document.getElementById('jobPercentage');
const progressBar = document.getElementById('progressBar');
const jobStatusText = document.getElementById('jobStatusText');
const downloadFileBtn = document.getElementById('downloadFileBtn');

// Modal Elements
const seasonModal = document.getElementById('seasonModal');
const modalShowTitle = document.getElementById('modalShowTitle');
const modalMeta = document.getElementById('modalMeta');
const seasonsList = document.getElementById('seasonsList');
const closeModalBtn = document.getElementById('closeModalBtn');
const toastEl = document.getElementById('toast');

let activePollTimer = null;
let featuredData = null;

// Helper: Toast
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
}

// Format views count (e.g., 10466816 -> 1.0Cr)
function fmtViews(n) {
  n = Number(n) || 0;
  if (n >= 1e7) return (n / 1e7).toFixed(1).replace('.0', '') + 'Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(1).replace('.0', '') + 'L';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'K';
  return String(n);
}

// Load Featured Content on Page Load
async function loadFeaturedContent() {
  loadingSpinner.classList.remove('hidden');
  spinnerText.textContent = 'Loading new releases, trending shows & dramas...';
  featuredSectionsContainer.innerHTML = '';
  emptyState.classList.add('hidden');

  try {
    const res = await fetch(apiUrl('/api/featured'));
    const data = await res.json();
    loadingSpinner.classList.add('hidden');

    if (!data.status || !data.categories || data.categories.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    featuredData = data.categories;
    renderFeaturedSections(featuredData);
  } catch (err) {
    loadingSpinner.classList.add('hidden');
    showToast(`Error loading featured shows: ${err.message}`);
  }
}

// Render Featured Sections / Rails
function renderFeaturedSections(categories) {
  featuredSectionsContainer.innerHTML = categories.map((cat) => {
    const items = cat.items || [];
    if (!items.length) return '';

    return `
      <section class="featured-section" id="section_${cat.id}">
        <div class="sec-head-row">
          <div class="sec-title-group">
            <h3 class="sec-title">${escapeHtml(cat.title)}</h3>
            <span class="sec-badge">${escapeHtml(cat.badge)}</span>
          </div>
          <span class="sec-count">${items.length} Shows</span>
        </div>
        <div class="results-grid">
          ${items.map(show => renderSingleShowCard(show)).join('')}
        </div>
      </section>
    `;
  }).join('');
}

// Render a single show card
function renderSingleShowCard(show) {
  const poster = show.poster || show.vertical || show.landscape || '';
  const totalSeasons = Math.max(show.totalSeasons || 1, 1);
  const views = show.views ? `👁 ${fmtViews(show.views)} views` : '';

  return `
    <div class="show-card" onclick="openShowModal('${show.id}', '${escapeAttr(show.title)}')">
      <div class="show-poster-wrap">
        <img src="${poster}" alt="${escapeAttr(show.title)}" class="show-poster" loading="lazy" onerror="this.src='https://placehold.co/360x640/14161d/f5b50a?text=Alright+TV'">
        <span class="show-seasons-badge">📅 ${totalSeasons} Season${totalSeasons > 1 ? 's' : ''}</span>
      </div>
      <div class="show-details">
        <div class="show-name" title="${escapeAttr(show.title)}">${escapeHtml(show.title)}</div>
        <div class="show-meta">${views}</div>
        <div class="card-actions">
          <button class="card-download-btn" onclick="event.stopPropagation(); openShowModal('${show.id}', '${escapeAttr(show.title)}')">
            ⬇ Download Seasons
          </button>
        </div>
      </div>
    </div>
  `;
}

// Category Chips Click Filter
categoryChips.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;

  categoryChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');

  const catId = btn.dataset.cat;
  if (catId === 'all') {
    if (featuredData) renderFeaturedSections(featuredData);
  } else {
    if (featuredData) {
      const filtered = featuredData.filter(c => c.id === catId);
      renderFeaturedSections(filtered.length ? filtered : featuredData);
    }
  }

  // If currently in search mode, switch back to featured
  if (!searchHeaderRow.classList.contains('hidden')) {
    resetToFeatured();
  }
});

// Search Form Submit
searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;

  // Switch to search view
  featuredSectionsContainer.classList.add('hidden');
  categoryChips.classList.add('hidden');
  searchResultsGrid.classList.remove('hidden');
  searchHeaderRow.classList.remove('hidden');
  clearSearchBtn.classList.remove('hidden');
  emptyState.classList.add('hidden');
  loadingSpinner.classList.remove('hidden');

  searchResultsHeading.textContent = `Search: "${query}"`;
  searchResultsCount.textContent = 'Searching...';
  searchResultsGrid.innerHTML = '';

  try {
    const res = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(query)}`));
    const data = await res.json();
    loadingSpinner.classList.add('hidden');

    if (!data.status || !data.items || data.items.length === 0) {
      emptyState.classList.remove('hidden');
      searchResultsCount.textContent = '0 shows found';
      return;
    }

    searchResultsCount.textContent = `${data.items.length} shows found`;
    searchResultsGrid.innerHTML = data.items.map(show => renderSingleShowCard(show)).join('');
  } catch (err) {
    loadingSpinner.classList.add('hidden');
    showToast(`Search error: ${err.message}`);
  }
});

// Input change: show/hide clear button
searchInput.addEventListener('input', () => {
  if (searchInput.value.trim()) {
    clearSearchBtn.classList.remove('hidden');
  } else {
    clearSearchBtn.classList.add('hidden');
    if (!searchHeaderRow.classList.contains('hidden')) {
      resetToFeatured();
    }
  }
});

// Clear Search button
clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearSearchBtn.classList.add('hidden');
  resetToFeatured();
});

// Back to featured button
backToFeaturedBtn.addEventListener('click', () => {
  resetToFeatured();
});

function resetToFeatured() {
  searchInput.value = '';
  clearSearchBtn.classList.add('hidden');
  searchHeaderRow.classList.add('hidden');
  searchResultsGrid.classList.add('hidden');
  emptyState.classList.add('hidden');
  categoryChips.classList.remove('hidden');
  featuredSectionsContainer.classList.remove('hidden');

  categoryChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  categoryChips.querySelector('.chip[data-cat="all"]').classList.add('active');

  if (featuredData) {
    renderFeaturedSections(featuredData);
  } else {
    loadFeaturedContent();
  }
}

// Open Season Selector Modal
async function openShowModal(movieId, title) {
  modalShowTitle.textContent = title;
  modalMeta.textContent = 'Loading available seasons...';
  seasonsList.innerHTML = '<div class="spinner-container"><div class="spinner"></div><p>Fetching season details...</p></div>';
  seasonModal.classList.remove('hidden');

  try {
    const res = await fetch(apiUrl(`/api/detail?id=${encodeURIComponent(movieId)}&season=1`));
    const data = await res.json();

    if (!data.status || !data.movie) {
      throw new Error(data.error || 'Failed to fetch series details');
    }

    const totalSeasons = Math.max(data.movie.totalSeasons || 1, 1);
    modalMeta.textContent = `Available: ${totalSeasons} Season${totalSeasons > 1 ? 's' : ''}`;

    // Generate cards for each season
    let listHtml = '';
    for (let s = 1; s <= totalSeasons; s++) {
      listHtml += `
        <div class="season-row-card">
          <div class="season-row-left">
            <div class="season-number-title">Season ${s}</div>
            <div class="season-ep-count">Full season merged into 1 continuous 1080p MP4</div>
          </div>
          <button class="download-season-action-btn" onclick="startSeasonDownload('${movieId}', '${escapeAttr(title)}', ${s})">
            ⬇ Download Season ${s}
          </button>
        </div>
      `;
    }
    seasonsList.innerHTML = listHtml;
  } catch (err) {
    seasonsList.innerHTML = `<p style="color:#ef4444;text-align:center;">Error loading seasons: ${err.message}</p>`;
  }
}

// Start Download Job
async function startSeasonDownload(movieId, seriesTitle, season) {
  seasonModal.classList.add('hidden');
  showToast(`Starting 1080p download for ${seriesTitle} Season ${season}...`);

  // Show Active Job Tracker
  jobCard.classList.remove('hidden');
  jobBadge.textContent = 'STARTING';
  jobBadge.className = 'job-badge';
  jobTitle.textContent = `${seriesTitle} — Season ${season}`;
  jobPercentage.textContent = '0%';
  progressBar.style.width = '0%';
  jobStatusText.textContent = 'Contacting server and queuing stream downloads...';
  downloadFileBtn.classList.add('hidden');

  window.scrollTo({ top: 0, behavior: 'smooth' });

  try {
    const res = await fetch(apiUrl('/api/download-season'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movieId, seriesTitle, season })
    });

    const data = await res.json();
    if (!data.status || !data.jobId) {
      throw new Error(data.error || 'Failed to start download job');
    }

    // Start Polling Job Status
    pollJobProgress(data.jobId);
  } catch (err) {
    jobStatusText.textContent = `Error: ${err.message}`;
    jobBadge.textContent = 'FAILED';
    showToast(err.message);
  }
}

// Poll Job Status
function pollJobProgress(jobId) {
  clearInterval(activePollTimer);

  activePollTimer = setInterval(async () => {
    try {
      const res = await fetch(apiUrl(`/api/job-status/${jobId}`));
      const data = await res.json();

      if (!data.status || !data.job) return;

      const job = data.job;
      jobPercentage.textContent = `${job.progress || 0}%`;
      progressBar.style.width = `${job.progress || 0}%`;
      jobStatusText.textContent = job.message || 'Processing...';

      if (job.status === 'downloading') {
        jobBadge.textContent = 'DOWNLOADING (1080p)';
      } else if (job.status === 'merging') {
        jobBadge.textContent = 'MERGING EPISODES';
      } else if (job.status === 'completed') {
        clearInterval(activePollTimer);
        jobBadge.textContent = 'COMPLETED';
        jobBadge.className = 'job-badge done';
        jobPercentage.textContent = '100%';
        progressBar.style.width = '100%';
        jobStatusText.textContent = `Ready! ${job.finalFileName} (${job.fileSizeMB} MB)`;

        // Show save button
        const fileUrl = apiUrl(job.fileUrl);
        downloadFileBtn.href = fileUrl;
        downloadFileBtn.setAttribute('download', job.finalFileName);
        downloadFileBtn.classList.remove('hidden');

        showToast(`🎉 ${job.finalFileName} ready! Triggering download...`);

        // Trigger automatic browser file download
        window.location.href = fileUrl;
      } else if (job.status === 'failed') {
        clearInterval(activePollTimer);
        jobBadge.textContent = 'FAILED';
        showToast(`Download failed: ${job.error}`);
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }, 1500);
}

// Close Modal Events
closeModalBtn.addEventListener('click', () => seasonModal.classList.add('hidden'));
seasonModal.addEventListener('click', (e) => {
  if (e.target === seasonModal) seasonModal.classList.add('hidden');
});

// Escape Helpers
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

function escapeAttr(str) {
  return String(str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Init: Load Featured Shows directly
window.addEventListener('DOMContentLoaded', () => {
  loadFeaturedContent();
});
