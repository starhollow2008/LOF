// ==UserScript==
// @name         osu! Local Favorites
// @namespace    https://github.com/vyroxat/Local-osu-Favorites
// @version      2.1.1
// @description  Store osu! beatmap favorites locally instead of on osu!'s servers.
// @author       vyroxat
// @match        https://osu.ppy.sh/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/* === osu! Local Favorites — Tampermonkey Edition === */
(() => {
  'use strict';

  const STORAGE_KEY = 'osu_local_favorites';

  // ═══ Page-world XHR/fetch interceptor ═══
  function injectInterceptor() {
    const script = document.createElement('script');
    script.textContent = `(${function() {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string' && url.includes('/favourites')) {
          this.__blocked = true;
        }
        return origOpen.apply(this, arguments);
      };
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function() {
        if (this.__blocked) {
          try {
            Object.defineProperty(this, 'readyState', {value:4,writable:true,configurable:true});
            Object.defineProperty(this, 'status', {value:200,writable:true,configurable:true});
            Object.defineProperty(this, 'responseText', {value:'{}',writable:true,configurable:true});
          } catch(e) {}
          setTimeout(() => { if (this.onload) this.onload(); if (this.onreadystatechange) this.onreadystatechange(); }, 0);
          return;
        }
        return origSend.apply(this, arguments);
      };
      const origFetch = window.fetch;
      window.fetch = function(url, options) {
        const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
        if (urlStr.includes('/favourites')) {
          return Promise.resolve(new Response('{}', {status:200,headers:{'Content-Type':'application/json'}}));
        }
        return origFetch.apply(this, arguments);
      };
    }})();`;
    (document.head || document.documentElement).appendChild(script);
  }

  // ═══ Storage ═══
  let favCache = null;

  function getFavorites() {
    if (favCache) return favCache;
    favCache = GM_getValue(STORAGE_KEY, {});
    return favCache;
  }

  function setFavorites(favs) {
    favCache = favs;
    GM_setValue(STORAGE_KEY, favs);
  }

  function isFavorited(id) {
    return !!getFavorites()[id];
  }

  // ═══ Beatmap data extraction ═══
  function getBeatmapDataFromJSON() {
    try {
      const el = document.getElementById('json-beatmapset');
      if (!el) return null;
      const raw = JSON.parse(el.textContent);
      const bm = raw.beatmapset || raw;
      return {
        id: String(bm.id),
        artist: bm.artist || '',
        artist_unicode: bm.artist_unicode || bm.artist || '',
        title: bm.title || '',
        title_unicode: bm.title_unicode || bm.title || '',
        creator: bm.creator || '',
        user_id: String(bm.user_id || ''),
        covers: bm.covers || {},
        status: bm.status || '',
        favourite_count: bm.favourite_count || 0,
        play_count: bm.play_count || 0,
        bpm: bm.bpm || 0,
        source: bm.source || '',
        tags: bm.tags || '',
        genre: bm.genre && bm.genre.name || '',
        language: bm.language && bm.language.name || '',
        url: 'https://osu.ppy.sh/beatmapsets/' + bm.id,
        beatmaps: (bm.beatmaps || []).map(b => ({
          id: String(b.id), version: b.version || '',
          difficulty_rating: b.difficulty_rating || 0,
          mode: b.mode || '', status: b.status || ''
        })),
        favourited_at: new Date().toISOString()
      };
    } catch (e) { return null; }
  }

  function getBeatmapDataFromCard(card) {
    if (!card) return null;
    try {
      const link = card.querySelector('a[href*="/beatmapsets/"]');
      if (!link) return null;
      const m = link.href.match(/\/beatmapsets\/(\d+)/);
      if (!m) return null;
      const id = m[1];

      let title = '', artist = '', creator = '', source = '';
      const rows = card.querySelectorAll('.beatmapset-panel__info-row, [class*="info-row"]');
      const texts = [];
      rows.forEach(r => { const t = r.textContent.trim(); if (t) texts.push(t); });

      texts.forEach(txt => {
        if (txt.startsWith('by ') && !artist) artist = txt.replace(/^by\s+/, '').replace(/Featured\s*Artist$/i, '').trim();
        else if (txt.startsWith('mapped by ')) creator = txt.replace(/^mapped by\s+/, '').trim();
        else if (!title) title = txt;
        else if (artist && creator && !source) source = txt;
      });
      if (!title) {
        const ml = card.querySelector('.beatmapset-panel__main-link, a[class*="main-link"]');
        if (ml) title = ml.textContent.trim();
      }

      // Extract cover URL — try multiple methods
      let coverUrl = '';

      // Method 1: computed style --bg custom property on cover element
      const coverEl = card.querySelector('[class*="beatmapset-cover"]');
      if (coverEl) {
        const cs = getComputedStyle(coverEl);
        let bg = cs.getPropertyValue('--bg') || '';
        if (!bg) bg = cs.backgroundImage || '';
        const m2 = bg.match(/url\("([^"]+)"\)/) || bg.match(/url\(([^)]+)\)/);
        if (m2) coverUrl = m2[1];
      }

      // Method 2: img inside cover
      if (!coverUrl) {
        const coverImg = card.querySelector('img[src*="cover"], [class*="cover"] img, .beatmapset-cover img');
        if (coverImg) coverUrl = coverImg.src || coverImg.getAttribute('data-src') || '';
      }

      // Method 3: any img in card that looks like a cover
      if (!coverUrl) {
        const imgs = card.querySelectorAll('img');
        for (const img of imgs) {
          const src = img.src || '';
          if (src.includes('cover') || src.includes('thumb')) { coverUrl = src; break; }
        }
        if (!coverUrl && imgs.length > 0) {
          // First image that's not an icon
          for (const img of imgs) {
            if (img.width > 40) { coverUrl = img.src; break; }
          }
        }
      }

      // Normalize URL
      if (coverUrl && !coverUrl.startsWith('http')) {
        if (coverUrl.startsWith('//')) coverUrl = 'https:' + coverUrl;
        else if (coverUrl.startsWith('/')) coverUrl = 'https://osu.ppy.sh' + coverUrl;
      }

      return {
        id, artist, artist_unicode: artist, title, title_unicode: title, creator,
        user_id: '', covers: { list: coverUrl, card: coverUrl, cover: coverUrl },
        status: '', favourite_count: 0, play_count: 0, bpm: 0,
        source, tags: '', genre: '', language: '',
        url: 'https://osu.ppy.sh/beatmapsets/' + id,
        beatmaps: [], favourited_at: new Date().toISOString()
      };
    } catch (e) { return null; }
  }

  function getBeatmapId() {
    const m = location.pathname.match(/\/beatmapsets\/(\d+)/);
    return m ? m[1] : null;
  }

  function resolveBeatmapContext(button) {
    const urlId = getBeatmapId();
    if (urlId) return { beatmapId: urlId, card: null, pageType: 'detail' };

    let el = button.parentElement;
    let bestEl = null, bestId = null;
    while (el && el !== document.body && el !== document.documentElement) {
      const cls = (el.className || '').toString();
      if (cls.includes('beatmapset-panel__menu')) { el = el.parentElement; continue; }
      const link = el.querySelector('a[href*="/beatmapsets/"]');
      if (link) {
        const m = link.href.match(/\/beatmapsets\/(\d+)/);
        if (m) { bestEl = el; bestId = m[1]; }
        if (cls.includes('beatmapset-panel')) break;
      }
      el = el.parentElement;
    }
    if (bestId) return { beatmapId: bestId, card: bestEl, pageType: 'listing' };
    return { beatmapId: null, card: null, pageType: 'unknown' };
  }

  // ═══ Favorite button detection ═══
  function isFavButton(el) {
    if (el.tagName !== 'BUTTON' && el.tagName !== 'A') return false;
    if (el.querySelector('.fa-heart, .fas.fa-heart, .far.fa-heart, .fal.fa-heart, .fa-solid.fa-heart, .fa-regular.fa-heart')) return true;

    const svg = el.querySelector('svg');
    if (svg) {
      const path = svg.querySelector('path');
      if (path) {
        const d = path.getAttribute('d') || '';
        const svgClass = (svg.getAttribute('class') || '').toLowerCase();
        if (d.startsWith('M') && d.includes('C') && d.length > 20 && svgClass.includes('heart')) return true;
      }
    }

    const title = (el.getAttribute('title') || el.getAttribute('data-orig-title') || el.getAttribute('aria-label') || '').toLowerCase();
    if (title.includes('avourite') || title.includes('avorite')) return true;

    const text = (el.textContent || '').toLowerCase().trim();
    if (text.includes('avourite') || text.includes('avorite')) return true;

    const cls = (el.className || '').toLowerCase();
    if (typeof cls === 'string' && (cls.includes('avourite') || cls.includes('avorite'))) return true;

    if (el.closest('.beatmapset-panel__menu-container')) {
      const iconEl = el.querySelector('i, span[class*="icon"], span[class*="heart"]');
      if (iconEl) {
        const ic = (iconEl.className || '').toLowerCase();
        if (ic.includes('heart') || ic.includes('fa-')) return true;
      }
      if (el.getAttribute('data-action') === 'favourite' || el.getAttribute('data-method') === 'favourite') return true;
      if (/[\u{2764}\u{1F493}-\u{1F49C}\u{1F5A4}\u{1F90D}\u{1F90E}\u{2661}\u{2665}]/u.test(el.textContent || '')) return true;
    }
    return false;
  }

  // ═══ Visual helpers ═══
  function updateHeartVisual(el, isFav) {
    const heart = el.querySelector('.fa-heart, .fas.fa-heart, .far.fa-heart');
    if (heart) {
      heart.classList.toggle('far', !isFav);
      heart.classList.toggle('fas', isFav);
    }
  }

  // ═══ Toggle favorite ═══
  function toggleFavorite(beatmapId, card) {
    if (!beatmapId) return null;
    const favs = getFavorites();
    const wasFav = !!favs[beatmapId];

    if (wasFav) {
      delete favs[beatmapId];
    } else {
      const data = getBeatmapDataFromJSON() ||
        (card ? getBeatmapDataFromCard(card) : null) ||
        {
          id: beatmapId,
          url: 'https://osu.ppy.sh/beatmapsets/' + beatmapId,
          favourited_at: new Date().toISOString()
        };
      favs[beatmapId] = data;
    }

    setFavorites(favs);
    updateFloatingHeart();
    return !wasFav;
  }

  // ═══ Copy-all button ("Beatmaps" heading) ═══
  function addCopyAllButton() {
    const container = document.querySelector('.js-sortable--page[data-page-id="beatmaps"] .page-extra');
    if (!container || container.dataset.osuFavBtn) return;
    container.dataset.osuFavBtn = '1';

    const btn = document.createElement('button');
    btn.textContent = 'Favorite all';
    Object.assign(btn.style, {
      marginLeft: '10px', padding: '2px 10px', fontSize: '11px',
      background: '#ff66aa', color: '#fff', border: 'none',
      borderRadius: '3px', cursor: 'pointer', fontWeight: '600'
    });
    btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      btn.textContent = 'Working...';
      btn.disabled = true;

      const favs = getFavorites();
      const cards = document.querySelectorAll('.beatmapset-panel');
      let count = 0;

      cards.forEach(card => {
        const data = getBeatmapDataFromCard(card);
        if (data && !favs[data.id]) {
          favs[data.id] = data;
          count++;
        }
      });

      setFavorites(favs);
      updateFloatingHeart();
      btn.textContent = 'Added ' + count;
      setTimeout(() => { btn.textContent = 'Favorite all'; btn.disabled = false; }, 2000);
    });

    container.appendChild(btn);
  }

  // ═══ Floating heart — always visible on all osu! pages ═══
  function ensureHeartIndicator() {
    if (document.getElementById('osu-local-fav-ind')) return;

    const ind = document.createElement('div');
    ind.id = 'osu-local-fav-ind';
    Object.assign(ind.style, {
      position: 'fixed', bottom: '40px', right: '100px', zIndex: '99999',
      width: '50px', height: '50px', borderRadius: '50%',
      background: 'rgba(22,33,62,0.95)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', fontSize: '26px', lineHeight: '1',
      transition: 'all 0.15s ease',
      userSelect: 'none'
    });

    const update = () => {
      const bmid = getBeatmapId();
      const fav = bmid ? isFavorited(bmid) : false;
      ind.textContent = fav ? '❤️' : '🤍';
      ind.style.border = fav ? '2px solid #ff3377' : '2px solid #ff66aa';
      ind.style.boxShadow = fav ? '0 2px 20px rgba(255,51,119,0.6)' : '0 2px 16px rgba(255,102,170,0.3)';
      // Clicking heart always opens favorites panel
      ind.title = 'View local favorites';
    };

    ind.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      showFavoritesPanel();
    });

    document.body.appendChild(ind);
    update();
  }

  function updateFloatingHeart() {
    const ind = document.getElementById('osu-local-fav-ind');
    if (!ind) return;
    const bmid = getBeatmapId();
    const fav = bmid ? isFavorited(bmid) : false;
    ind.textContent = fav ? '❤️' : '🤍';
    ind.style.border = fav ? '2px solid #ff3377' : '2px solid #ff66aa';
    ind.style.boxShadow = fav ? '0 2px 20px rgba(255,51,119,0.6)' : '0 2px 16px rgba(255,102,170,0.3)';
  }

  // ═══ Click interception ═══
  document.addEventListener('click', function(e) {
    const button = e.target.closest('button, a');
    if (!button || !isFavButton(button)) return;

    const ctx = resolveBeatmapContext(button);
    if (!ctx.beatmapId) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const nowFav = toggleFavorite(ctx.beatmapId, ctx.card);
    updateHeartVisual(button, nowFav);

    button.style.transform = 'scale(1.2)';
    button.style.transition = 'transform 0.1s ease';
    setTimeout(() => { button.style.transform = 'scale(1)'; }, 120);
  }, true);

  // ═══ Refresh visible buttons ═══
  function refreshButtons() {
    const buttons = document.querySelectorAll('button');
    buttons.forEach(btn => {
      if (!isFavButton(btn) || btn.dataset.osuFavChecked) return;
      btn.dataset.osuFavChecked = '1';
      const ctx = resolveBeatmapContext(btn);
      if (ctx.beatmapId) {
        updateHeartVisual(btn, isFavorited(ctx.beatmapId));
      }
    });
  }

  // ═══ Favorites panel ═══
  function showFavoritesPanel() {
    const existing = document.getElementById('osu-local-fav-panel');
    if (existing) { existing.remove(); return; }

    const favs = getFavorites();
    const entries = Object.entries(favs).sort(([,a], [,b]) =>
      (b.favourited_at || '').localeCompare(a.favourited_at || '')
    );

    const panel = document.createElement('div');
    panel.id = 'osu-local-fav-panel';
    Object.assign(panel.style, {
      position: 'fixed', top: '0', right: '0', zIndex: '100000',
      width: '360px', height: '100vh',
      background: '#111', color: '#ddd',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      fontSize: '13px',
      borderLeft: '1px solid #333',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      boxShadow: '-2px 0 16px rgba(0,0,0,0.5)'
    });

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '12px 14px', background: '#1a1a1a',
      borderBottom: '2px solid #ff66aa',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      flexShrink: '0'
    });
    header.innerHTML = `
      <span style="font-weight:600;font-size:14px">Local Favorites <span style="color:#ff66aa">${entries.length}</span></span>
      <button id="osu-fav-panel-close" style="background:none;border:1px solid #333;color:#999;cursor:pointer;padding:2px 8px;border-radius:3px;font-size:12px">&times; Close</button>
    `;

    // List
    const list = document.createElement('div');
    Object.assign(list.style, {
      flex: '1', overflowY: 'auto', padding: '4px 0'
    });

    if (entries.length === 0) {
      list.innerHTML = '<p style="text-align:center;color:#666;padding:40px 20px;font-size:12px">No favorites yet.</p>';
    }

    entries.forEach(([id, f]) => {
      const card = document.createElement('div');
      Object.assign(card.style, {
        display: 'flex', gap: '8px', padding: '8px 14px',
        borderBottom: '1px solid #222', alignItems: 'center',
        transition: 'background 0.1s'
      });
      card.onmouseenter = () => card.style.background = '#1e1e1e';
      card.onmouseleave = () => card.style.background = '';

      const coverUrl = f.covers?.card || f.covers?.list || f.covers?.cover || '';

      card.innerHTML = `
        ${coverUrl
          ? `<div style="width:50px;height:38px;border-radius:2px;overflow:hidden;flex-shrink:0;background:#1a1a1a"><img src="${coverUrl}" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.parentElement.innerHTML='<div style=width:50px;height:38px;border-radius:2px;flex-shrink:0;background:#1a1a1a;display:flex;align-items:center;justify-content:center;font-size:18px;color:#666>?</div>'"></div>`
          : `<div style="width:50px;height:38px;border-radius:2px;flex-shrink:0;background:#1a1a1a;display:flex;align-items:center;justify-content:center;font-size:18px;color:#666">?</div>`
        }
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.title || f.title_unicode || 'Unknown'}</div>
          <div style="font-size:10px;color:#999">${f.artist || f.artist_unicode || ''}</div>
          <div style="font-size:9px;color:#666">${f.creator || ''}${f.bpm ? ' · ' + f.bpm + ' BPM' : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;flex-shrink:0">
          <a href="${f.url || 'https://osu.ppy.sh/beatmapsets/' + id}" target="_blank" style="font-size:9px;padding:2px 6px;border:1px solid #333;border-radius:2px;color:#999;text-decoration:none;text-align:center">Open</a>
          <button data-remove="${id}" style="font-size:9px;padding:2px 6px;border:1px solid #333;border-radius:2px;background:none;color:#999;cursor:pointer">Remove</button>
        </div>
      `;

      card.querySelector('[data-remove]').addEventListener('click', () => {
        const favs = getFavorites();
        delete favs[id];
        setFavorites(favs);
        updateFloatingHeart();
        showFavoritesPanel();
      });

      list.appendChild(card);
    });

    // Footer
    const footer = document.createElement('div');
    Object.assign(footer.style, {
      padding: '8px 14px', borderTop: '1px solid #333',
      background: '#1a1a1a', display: 'flex', gap: '6px', flexShrink: '0'
    });
    footer.innerHTML = `
      <button id="osu-fav-export" style="font-size:10px;padding:4px 10px;border:1px solid #333;border-radius:3px;background:none;color:#999;cursor:pointer">Export</button>
      <button id="osu-fav-import" style="font-size:10px;padding:4px 10px;border:1px solid #333;border-radius:3px;background:none;color:#999;cursor:pointer">Import</button>
      <input type="file" id="osu-fav-import-file" accept=".json" style="display:none">
    `;

    panel.appendChild(header);
    panel.appendChild(list);
    panel.appendChild(footer);
    document.body.appendChild(panel);

    // Events
    document.getElementById('osu-fav-panel-close').addEventListener('click', () => panel.remove());
    document.getElementById('osu-fav-export').addEventListener('click', () => {
      const data = JSON.stringify(getFavorites(), null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'osu-favorites-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    document.getElementById('osu-fav-import').addEventListener('click', () => {
      document.getElementById('osu-fav-import-file').click();
    });
    document.getElementById('osu-fav-import-file').addEventListener('change', async (e) => {
      if (!e.target.files[0]) return;
      try {
        const text = await e.target.files[0].text();
        const data = JSON.parse(text);
        if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected JSON object');
        const existing = getFavorites();
        let added = 0;
        for (const [id, fav] of Object.entries(data)) {
          if (!existing[id]) { existing[id] = fav; added++; }
        }
        setFavorites(existing);
        showFavoritesPanel();
      } catch (err) {
        alert('Import failed: ' + err.message);
      }
    });
  }

  // ═══ Menu command ═══
  GM_registerMenuCommand('View Local Favorites', showFavoritesPanel);

  // ═══ Init ═══
  function init() {
    injectInterceptor();
    getFavorites();
    ensureHeartIndicator();
    addCopyAllButton();

    // Debounced observer — runs at most once per 600ms to avoid freezing the page
    let timer = null;
    const debouncedRefresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshButtons();
        if (!document.getElementById('osu-local-fav-ind')) ensureHeartIndicator();
        addCopyAllButton();
        updateFloatingHeart();
      }, 600);
    };

    if (document.body) {
      new MutationObserver(debouncedRefresh)
        .observe(document.body, { childList: true, subtree: true });
    }

    // Polling for SPA navigation (low overhead)
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        ensureHeartIndicator();
        debouncedRefresh();
      }
    }, 800);

    // Initial refresh after page settles
    setTimeout(refreshButtons, 800);
    setTimeout(refreshButtons, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
