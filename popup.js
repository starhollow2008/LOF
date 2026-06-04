// osu! Local Favorites — Popup Script

const STORAGE_KEY = 'favorites';
const template = document.getElementById('cardTemplate');
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const searchInput = document.getElementById('search');
const countEl = document.getElementById('count');

let allFavorites = {};
let currentSort = 'date';
let sortAsc = false;

// ── Render ───────────────────────────────────────────────────
function render(filter = '') {
  let entries = Object.entries(allFavorites);

  if (filter.trim()) {
    const q = filter.toLowerCase();
    entries = entries.filter(([, f]) =>
      (f.title || '').toLowerCase().includes(q) ||
      (f.artist || '').toLowerCase().includes(q) ||
      (f.creator || '').toLowerCase().includes(q) ||
      (f.tags || '').toLowerCase().includes(q) ||
      (f.source || '').toLowerCase().includes(q) ||
      (f.id || '').includes(q)
    );
  }

  entries.sort(([, a], [, b]) => {
    let cmp = 0;
    switch (currentSort) {
      case 'date':
        cmp = (a.favourited_at || '').localeCompare(b.favourited_at || '');
        break;
      case 'title':
        cmp = (a.title || '').localeCompare(b.title || '');
        break;
      case 'artist':
        cmp = (a.artist || '').localeCompare(b.artist || '');
        break;
      case 'status':
        cmp = (a.status || '').localeCompare(b.status || '');
        break;
    }
    return sortAsc ? cmp : -cmp;
  });

  const total = Object.keys(allFavorites).length;
  countEl.textContent = total;

  if (total === 0) {
    empty.style.display = 'flex';
    list.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  list.style.display = 'block';

  if (entries.length === 0 && filter.trim()) {
    list.innerHTML = '<div class="empty-state" style="min-height:100px"><p>No matches for that search.</p></div>';
    return;
  }

  list.innerHTML = '';

  for (const [id, f] of entries) {
    const card = template.content.cloneNode(true);

    card.querySelector('.card-title').innerHTML = (f.title || f.title_unicode || 'Unknown') + (f.nsfw ? ' <span class="nsfw-badge">EXPLICIT</span>' : '');
    card.querySelector('.card-artist').textContent = f.artist || f.artist_unicode || '';
    card.querySelector('.card-mapper').textContent = f.creator || '';
    card.querySelector('.card-bpm').textContent = f.bpm ? `${f.bpm} BPM` : '';
    card.querySelector('.card-date').textContent = formatDate(f.favourited_at);
    card.querySelector('.card-link').href = f.url || `https://osu.ppy.sh/beatmapsets/${id}`;
    card.querySelector('.card-remove').addEventListener('click', () => removeFavorite(id));

    // Status
    const statusEl = card.querySelector('.card-status');
    if (f.status) {
      statusEl.textContent = f.status;
      statusEl.style.color = statusColor(f.status);
    } else {
      statusEl.textContent = '';
    }

    // Cover
    const coverUrl = f.covers?.card || f.covers?.list || f.covers?.cover || '';
    const img = card.querySelector('.card-cover img');
    if (coverUrl) {
      img.src = coverUrl;
    } else {
      img.style.display = 'none';
      const noCover = card.querySelector('.no-cover');
      if (noCover) noCover.style.display = 'flex';
    }

    // Tooltip from beatmap data
    if (f.beatmaps && f.beatmaps.length > 0) {
      const diffs = f.beatmaps.map(b => `${b.version} [${b.difficulty_rating.toFixed(1)}★]`).join(', ');
      card.querySelector('.card').title = `Difficulties: ${diffs}`;
    }

    list.appendChild(card);
  }
}

function statusColor(status) {
  const map = {
    ranked: '#4caf50',
    loved: '#ff66aa',
    qualified: '#2196f3',
    pending: '#ff9800',
    wip: '#f44336',
    graveyard: '#777',
  };
  return map[status] || '#888';
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString();
}

// ── Actions ──────────────────────────────────────────────────
async function removeFavorite(id) {
  const favs = await getFavorites();
  delete favs[id];
  await chrome.storage.local.set({ [STORAGE_KEY]: favs });
  allFavorites = favs;
  render(searchInput.value);
  chrome.runtime.sendMessage({ action: 'updateBadge' }).catch(() => {});
}

async function getFavorites() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

// ── Sort ─────────────────────────────────────────────────────
function updateSortButtons() {
  const buttons = document.querySelectorAll('#sortBar .sort-btn');
  buttons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === currentSort);
    const arrow = sortAsc ? ' ↑' : ' ↓';
    btn.textContent = btn.dataset.sort.charAt(0).toUpperCase() + btn.dataset.sort.slice(1) + arrow;
  });
}

// ── Export / Import ──────────────────────────────────────────
async function exportFavorites() {
  const data = JSON.stringify(allFavorites, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `osu-favorites-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importFavorites(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Expected a JSON object.');
    }

    const existing = await getFavorites();
    let merged = { ...existing };
    let added = 0;

    for (const [id, fav] of Object.entries(data)) {
      if (!merged[id]) {
        merged[id] = fav;
        added++;
      }
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
    allFavorites = merged;
    render(searchInput.value);
    chrome.runtime.sendMessage({ action: 'updateBadge' }).catch(() => {});
    showToast(`Added ${added}. Total: ${Object.keys(merged).length}`);
  } catch (e) {
    showToast(`Import failed: ${e.message}`);
  }
}

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

// ── Event Listeners ──────────────────────────────────────────
searchInput.addEventListener('input', () => render(searchInput.value));

document.getElementById('sortBar').addEventListener('click', (e) => {
  const btn = e.target.closest('.sort-btn');
  if (!btn) return;
  const sort = btn.dataset.sort;
  if (currentSort === sort) {
    sortAsc = !sortAsc;
  } else {
    currentSort = sort;
    sortAsc = false;
  }
  updateSortButtons();
  render(searchInput.value);
});

document.getElementById('exportBtn').addEventListener('click', exportFavorites);
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', (e) => {
  if (e.target.files[0]) {
    importFavorites(e.target.files[0]);
    e.target.value = '';
  }
});

// ── Init ──────────────────────────────────────────────────────
(async () => {
  allFavorites = await getFavorites();
  countEl.textContent = Object.keys(allFavorites).length;
  updateSortButtons();
  render();
})();
