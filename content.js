// osu! Local Favorites - Content Script v2.2
// Intercepts osu! favorite buttons via network-level blocking
// Does NOT clone DOM elements — fully compatible with React

(() => {
  'use strict';

  var STORAGE_KEY = 'favorites';
  var _JSON = { parse: JSON.parse, stringify: JSON.stringify };

  // ── Network interceptor ────────────────────────────────────────
  // Inject interceptor.js into the page's MAIN world via <script src>
  // This intercepts jQuery's $.ajax XHR/fetch calls to /favourites
  (function() {
    var script = document.createElement('script');
    script.src = chrome.runtime.getURL('interceptor.js');
    (document.head || document.documentElement).appendChild(script);
  })();

  // ── Beatmap data extraction (detail page) ──────────────────────
  function getBeatmapDataFromJSON() {
    try {
      var el = document.getElementById('json-beatmapset');
      if (!el) return null;
      var raw = _JSON.parse(el.textContent);
      var bm = raw.beatmapset || raw;
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
        beatmaps: (bm.beatmaps || []).map(function(b) { return {
          id: String(b.id), version: b.version || '',
          difficulty_rating: b.difficulty_rating || 0,
          mode: b.mode || '', status: b.status || ''
        };}),
        favourited_at: new Date().toISOString()
      };
    } catch (e) { return null; }
  }

  // ── Beatmap data extraction (detail page, DOM scraping fallback) ─
  function getBeatmapDataFromDetailDOM() {
    try {
      var id = getBeatmapId();
      if (!id) return null;

      // Try to get title from heading elements
      var titleEl = document.querySelector('.beatmapset-header__details-text--title, ' +
        '.beatmapset-header__details-text, h1[class*="beatmapset"], ' +
        '.beatmapset-info__title');
      var title = titleEl ? titleEl.textContent.trim() : '';

      // Look for artist link ("by ..." in header details)
      var byEl = document.querySelector('.beatmapset-header__details-text a[href*="/beatmapsets/"]');
      var artistText = '';
      if (byEl) {
        artistText = byEl.textContent.trim();
        // Strip "by " prefix
        if (artistText.indexOf('by ') === 0) artistText = artistText.slice(3).trim();
      }

      // Look for mapper (user links in header, last one is usually mapper)
      var allDetailLinks = document.querySelectorAll('.beatmapset-header__details-text a[href*="/users/"]');
      var mapperText = '';
      if (allDetailLinks.length > 0) {
        mapperText = allDetailLinks[allDetailLinks.length - 1].textContent.trim();
      }

      // Try to get status
      var statusEl = document.querySelector('.beatmapset-status, [class*="beatmapset-status"]');
      var status = statusEl ? statusEl.textContent.trim().toLowerCase() : '';

      // Try to get BPM
      var bpm = 0;
      var bpmEl = document.querySelector('[class*="bpm"]');
      if (bpmEl) {
        var bpmMatch = bpmEl.textContent.trim().match(/(\d+)/);
        if (bpmMatch) bpm = parseInt(bpmMatch[1], 10);
      }

      // Try to get source
      var sourceEl = document.querySelector('.beatmapset-header__source, .beatmapset-info__source');
      var source = sourceEl ? sourceEl.textContent.trim() : '';

      // Try to get cover image
      var coverImg = document.querySelector('.beatmapset-header__cover img, ' +
        '.beatmapset-cover img, .beatmapset-header img[src*="cover"], ' +
        '[class*="beatmapset-header"] img');
      var coverUrl = '';
      if (coverImg) {
        coverUrl = coverImg.src || coverImg.getAttribute('data-src') || '';
      }
      if (coverUrl && coverUrl.indexOf('http') !== 0) {
        if (coverUrl.charAt(0) === '/') coverUrl = 'https://osu.ppy.sh' + coverUrl;
      }

      return {
        id: id,
        artist: artistText,
        artist_unicode: artistText,
        title: title,
        title_unicode: title,
        creator: mapperText,
        user_id: '',
        covers: { list: coverUrl, card: coverUrl, cover: coverUrl },
        status: status,
        favourite_count: 0,
        play_count: 0,
        bpm: bpm,
        source: source,
        tags: '',
        genre: '',
        language: '',
        url: 'https://osu.ppy.sh/beatmapsets/' + id,
        beatmaps: [],
        favourited_at: new Date().toISOString()
      };
    } catch (e) { return null; }
  }

  // ── Beatmap data extraction (listing cards) ────────────────────
  function getBeatmapDataFromCard(card) {
    if (!card) return null;
    try {
      var link = card.querySelector('a[href*="/beatmapsets/"]');
      if (!link) return null;
      var m = link.href.match(/\/beatmapsets\/(\d+)/);
      if (!m) return null;
      var id = m[1];

      var rows = card.querySelectorAll('.beatmapset-panel__info-row, [class*="info-row"]');
      var texts = [];
      for (var i = 0; i < rows.length; i++) {
        var t = rows[i].textContent.trim();
        if (t) texts.push(t);
      }

      var title = '', artist = '', creator = '', source = '';
      for (var j = 0; j < texts.length; j++) {
        var txt = texts[j];
        if (txt.indexOf('by ') === 0 && !artist) {
          artist = txt.replace(/^by\s+/, '').replace(/Featured\s*Artist$/i, '').trim();
        } else if (txt.indexOf('mapped by ') === 0) {
          creator = txt.replace(/^mapped by\s+/, '').trim();
        } else if (!title) {
          title = txt;
        } else if (artist && creator && !source) {
          source = txt;
        }
      }
      if (!title) {
        var ml = card.querySelector('.beatmapset-panel__main-link, a[class*="main-link"]');
        if (ml) title = ml.textContent.trim();
      }

      // Extract cover URLs from CSS custom properties or background-image on cover divs
      var coverList = card.querySelector('.beatmapset-cover--full, [class*="beatmapset-cover"]');
      var listUrl = '';
      if (coverList) {
        // Try CSS custom property --bg
        var bg = coverList.style.getPropertyValue('--bg') || '';
        var m2 = bg.match(/url\("([^"]+)"\)/) || bg.match(/url\(([^)]+)\)/);
        if (!m2) {
          // Try computed background-image
          var computed = window.getComputedStyle(coverList);
          var bgImg = computed.getPropertyValue('background-image') || '';
          var m3 = bgImg.match(/url\("([^"]+)"\)/) || bgImg.match(/url\(([^)]+)\)/);
          if (m3) listUrl = m3[1];
        } else {
          listUrl = m2[1];
        }
      }
      // Try img element inside cover
      if (!listUrl) {
        var coverImg = card.querySelector('.beatmapset-cover img, [class*="beatmapset-cover"] img, .beatmapset-panel__cover-container img');
        if (coverImg) listUrl = coverImg.src || coverImg.getAttribute('data-src') || '';
      }
      // Make URL absolute if relative
      if (listUrl && listUrl.indexOf('http') !== 0) {
        if (listUrl.charAt(0) === '/') {
          listUrl = 'https://osu.ppy.sh' + listUrl;
        } else if (listUrl.indexOf('//') === 0) {
          listUrl = 'https:' + listUrl;
        }
      }
      var cardUrl = listUrl.replace('/list.jpg', '/card.jpg').replace('/list@2x.jpg', '/card@2x.jpg');
      var coverUrl = cardUrl || listUrl;

      return {
        id: id, artist: artist, artist_unicode: artist,
        title: title, title_unicode: title, creator: creator,
        user_id: '', covers: { list: coverUrl, card: coverUrl, cover: coverUrl },
        status: '', favourite_count: 0, play_count: 0, bpm: 0,
        source: source, tags: '', genre: '', language: '',
        url: 'https://osu.ppy.sh/beatmapsets/' + id,
        beatmaps: [], favourited_at: new Date().toISOString()
      };
    } catch (e) { return null; }
  }

  function getBeatmapId() {
    var m = window.location.pathname.match(/\/beatmapsets\/(\d+)/);
    return m ? m[1] : null;
  }

  function resolveBeatmapContext(button) {
    var urlId = getBeatmapId();
    if (urlId) return { beatmapId: urlId, card: null, pageType: 'detail' };

    // Walk up the DOM from the button to find the beatmap card wrapper.
    // Skip menu-related containers — they may contain beatmap links but NOT
    // the metadata (title, artist, mapper) needed for data extraction.
    // Prefer .beatmapset-panel (the actual card wrapper) over sub-containers.
    var el = button.parentElement;
    var bestEl = null;
    var bestId = null;
    while (el && el !== document.body && el !== document.documentElement) {
      var cls = (el.className || '').toString();
      // Skip menu containers and menu items
      if (cls.indexOf('beatmapset-panel__menu') !== -1) {
        el = el.parentElement;
        continue;
      }
      // Check for beatmap link
      var link = el.querySelector('a[href*="/beatmapsets/"]');
      if (link) {
        var m = link.href.match(/\/beatmapsets\/(\d+)/);
        if (m) {
          bestEl = el;
          bestId = m[1];
          // If this is the actual .beatmapset-panel card, stop — it has everything
          if (cls.indexOf('beatmapset-panel ') !== -1 || cls === 'beatmapset-panel' || cls.indexOf('beatmapset-panel--') !== -1) {
            break;
          }
        }
      }
      el = el.parentElement;
    }
    if (bestId) return { beatmapId: bestId, card: bestEl, pageType: 'listing' };
    // Fallback: look for .beatmapset-panel directly
    var card = button.closest('.beatmapset-panel');
    if (card) {
      var flink = card.querySelector('a[href*="/beatmapsets/"]');
      if (flink) {
        var fm = flink.href.match(/\/beatmapsets\/(\d+)/);
        if (fm) return { beatmapId: fm[1], card: card, pageType: 'listing' };
      }
    }
    return { beatmapId: null, card: null, pageType: 'unknown' };
  }

  // ── Storage ────────────────────────────────────────────────────
  // In-memory cache to avoid chrome.storage race conditions on fast toggles
  var _favCache = null;

  function getFavorites() {
    return chrome.storage.local.get(STORAGE_KEY).then(function(r) {
      _favCache = r[STORAGE_KEY] || {};
      return _favCache;
    }).catch(function() { return {}; });
  }

  function setFavorites(favs) {
    _favCache = favs;
    var obj = {};
    obj[STORAGE_KEY] = favs;
    return chrome.storage.local.set(obj).catch(function(){});
  }

  function updateBadge() {
    var count = _favCache ? Object.keys(_favCache).length : 0;
    chrome.runtime.sendMessage({ action: 'updateBadge' }).catch(function(){});
  }

  function isFavorited(id) {
    if (_favCache !== null) return Promise.resolve(!!_favCache[id]);
    return getFavorites().then(function(favs) { return !!favs[id]; });
  }

  function toggleFavorite(beatmapId, card) {
    // Use in-memory cache for instant toggle detection (avoids stale storage reads)
    return getFavorites().then(function(favs) {
      var wasFav = !!favs[beatmapId];
      if (wasFav) {
        delete favs[beatmapId];
      } else {
        var data = getBeatmapDataFromJSON() || getBeatmapDataFromDetailDOM() || getBeatmapDataFromCard(card);
        favs[beatmapId] = data || {
          id: beatmapId,
          url: 'https://osu.ppy.sh/beatmapsets/' + beatmapId,
          favourited_at: new Date().toISOString()
        };
      }
      return setFavorites(favs).then(function() {
        updateBadge();
        return !wasFav;
      });
    }).catch(function() {
      return null;
    });
  }

  // ── Button detection ───────────────────────────────────────────
  function isFavButton(el) {
    if (el.tagName !== 'BUTTON' && el.tagName !== 'A') return false;

    // FontAwesome heart icons (all variants)
    if (el.querySelector('.fa-heart, .fas.fa-heart, .far.fa-heart, .fal.fa-heart, .fa-solid.fa-heart, .fa-regular.fa-heart')) return true;

    // SVG heart icons (osu! may use inline SVGs)
    var svg = el.querySelector('svg');
    if (svg) {
      var svgPath = svg.querySelector('path');
      if (svgPath) {
        var d = svgPath.getAttribute('d') || '';
        // Heart path: M...C... common heart shape paths
        if (d.indexOf('M') === 0 && (d.indexOf('C') !== -1) && d.length > 20) {
          var svgClass = (svg.getAttribute('class') || '').toLowerCase();
          if (svgClass.indexOf('heart') !== -1) return true;
        }
      }
    }

    // Check title/aria-label for "favourite"/"favorite"
    var title = (el.getAttribute('title') || el.getAttribute('data-orig-title') || el.getAttribute('aria-label') || '').toLowerCase();
    if (title.indexOf('avourite') !== -1 || title.indexOf('avorite') !== -1) return true;

    // Check button text content (case-insensitive, trimmed)
    var text = (el.textContent || '').toLowerCase().trim();
    if (text.indexOf('avourite') !== -1 || text.indexOf('avorite') !== -1) return true;

    // Check classes for favourite/favorite
    var cls = (el.className || '').toLowerCase();
    if (typeof cls === 'string' && (cls.indexOf('avourite') !== -1 || cls.indexOf('avorite') !== -1)) return true;

    // Detect osu! beatmap panel menu favourite button by structure:
    // Button inside .beatmapset-panel__menu-container -- check for heart icon in any child
    // (covers FontAwesome fas/far, emoji hearts, and data attributes)
    if (el.closest('.beatmapset-panel__menu-container')) {
      var iconEl = el.querySelector('i, span[class*="icon"], span[class*="heart"]');
      if (iconEl) {
        var iconClass = (iconEl.className || '').toLowerCase();
        if (iconClass.indexOf('heart') !== -1 || iconClass.indexOf('fa-') !== -1) return true;
      }
      // Check for data attributes indicating favourite button
      if (el.getAttribute('data-action') === 'favourite' || el.getAttribute('data-method') === 'favourite') return true;
      // Check for heart emoji
      if (/[\u{2764}\u{1F493}\u{1F494}\u{1F495}\u{1F496}\u{1F497}\u{1F498}\u{1F499}\u{1F49A}\u{1F49B}\u{1F49C}\u{1F5A4}\u{1F90D}\u{1F90E}\u{2661}\u{2665}]/u.test(el.textContent || '')) return true;
    }

    return false;
  }

  // ── Visual helpers ─────────────────────────────────────────────
  function updateHeartVisual(el, isFav) {
    var heart = el.querySelector('.fa-heart, .fas.fa-heart, .far.fa-heart');
    if (heart) {
      heart.classList.toggle('far', !isFav);
      heart.classList.toggle('fas', isFav);
    }
  }

  // ── Copy-all button ("Beatmaps" heading) ──────────────────────
  function addCopyAllButton() {
    var container = document.querySelector('.js-sortable--page[data-page-id="beatmaps"] .page-extra');
    if (!container || container.dataset.osuFavBtn) return;
    container.dataset.osuFavBtn = '1';

    var heading = container.querySelector('h2.title--page-extra');

    var btn = document.createElement('button');
    btn.textContent = 'Favorite all';
    btn.style.cssText = 'margin-left:10px;padding:2px 10px;font-size:11px;background:#ff66aa;color:#fff;border:none;border-radius:3px;cursor:pointer;font-weight:600';
    btn.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      btn.textContent = 'Working...';
      btn.disabled = true;

      getFavorites().then(function(favs) {
        var cards = document.querySelectorAll('.beatmapset-panel');
        var count = 0;
        var promises = [];

        cards.forEach(function(card) {
          var data = getBeatmapDataFromCard(card);
          if (data && !favs[data.id]) {
            favs[data.id] = data;
            count++;
          }
        });

        return setFavorites(favs).then(function() {
          updateBadge();
          btn.textContent = 'Added ' + count;
          setTimeout(function() { btn.textContent = 'Favorite all'; btn.disabled = false; }, 2000);
        });
      }).catch(function() {
        btn.textContent = 'Error';
        setTimeout(function() { btn.textContent = 'Favorite all'; btn.disabled = false; }, 2000);
      });
    });

    // Insert after the heading
    if (heading && heading.nextSibling) {
      heading.parentNode.insertBefore(btn, heading.nextSibling);
    } else {
      container.appendChild(btn);
    }
  }

  // ── Floating indicator (all pages) ─────────────────────────────
  function ensureHeartIndicator() {
    if (document.getElementById('osu-local-fav-indicator')) return;
    var ind = document.createElement('div');
    ind.id = 'osu-local-fav-indicator';
    ind.title = 'View local favorites';
    ind.style.cssText = 'position:fixed;bottom:40px;right:100px;z-index:99999;width:50px;height:50px;border-radius:50%;background:rgba(22,33,62,0.95);border:2px solid #ff66aa;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:26px;line-height:1;transition:all 0.2s ease;box-shadow:0 2px 16px rgba(255,102,170,0.3);user-select:none;-webkit-user-select:none;';
    ind.textContent = '🤍';
    ind.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      showFavoritesPanel();
    });
    document.body.appendChild(ind);
  }

  // ── Favorites side panel ──────────────────────────────────────
  function showFavoritesPanel() {
    if (document.getElementById('osu-local-fav-panel')) {
      document.getElementById('osu-local-fav-panel').remove();
      return;
    }

    getFavorites().then(function(favs) {
      var entries = Object.entries(favs).sort(function(a, b) {
        return (b[1].favourited_at || '').localeCompare(a[1].favourited_at || '');
      });

      var panel = document.createElement('div');
      panel.id = 'osu-local-fav-panel';
      panel.style.cssText = 'position:fixed;top:0;right:0;z-index:100000;width:360px;height:100vh;background:#111;color:#ddd;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;border-left:1px solid #333;display:flex;flex-direction:column;overflow:hidden;box-shadow:-2px 0 16px rgba(0,0,0,0.5);';

      // Header
      var header = document.createElement('div');
      header.style.cssText = 'padding:12px 14px;background:#1a1a1a;border-bottom:2px solid #ff66aa;display:flex;justify-content:space-between;align-items:center;flex-shrink:0';
      header.innerHTML = '<span style="font-weight:600;font-size:14px">Local Favorites <span style="color:#ff66aa">' + entries.length + '</span></span><button id="osu-fav-panel-close" style="background:none;border:1px solid #333;color:#999;cursor:pointer;padding:2px 8px;border-radius:3px;font-size:12px">&times; Close</button>';

      // List
      var list = document.createElement('div');
      list.style.cssText = 'flex:1;overflow-y:auto;padding:4px 0';
      if (entries.length === 0) {
        list.innerHTML = '<p style="text-align:center;color:#666;padding:40px 20px;font-size:12px">No favorites yet.</p>';
      }

      entries.forEach(function(entry) {
        var id = entry[0], f = entry[1];
        var card = document.createElement('div');
        card.style.cssText = 'display:flex;gap:8px;padding:8px 14px;border-bottom:1px solid #222;align-items:center';
        card.onmouseenter = function() { card.style.background = '#1e1e1e'; };
        card.onmouseleave = function() { card.style.background = ''; };

        var coverUrl = (f.covers && f.covers.card) || (f.covers && f.covers.list) || (f.covers && f.covers.cover) || '';

        card.innerHTML =
          (coverUrl
            ? '<div style="width:50px;height:38px;border-radius:2px;overflow:hidden;flex-shrink:0;background:#1a1a1a"><img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.parentElement.innerHTML=\'?\'"></div>'
            : '<div style="width:50px;height:38px;border-radius:2px;flex-shrink:0;background:#1a1a1a;display:flex;align-items:center;justify-content:center;font-size:18px;color:#666">?</div>') +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (f.title || f.title_unicode || 'Unknown') + '</div>' +
            '<div style="font-size:10px;color:#999">' + (f.artist || f.artist_unicode || '') + '</div>' +
            '<div style="font-size:9px;color:#666">' + (f.creator || '') + (f.bpm ? ' · ' + f.bpm + ' BPM' : '') + '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:2px;flex-shrink:0">' +
            '<a href="' + (f.url || 'https://osu.ppy.sh/beatmapsets/' + id) + '" target="_blank" style="font-size:9px;padding:2px 6px;border:1px solid #333;border-radius:2px;color:#999;text-decoration:none;text-align:center">Open</a>' +
            '<button data-remove="' + id + '" style="font-size:9px;padding:2px 6px;border:1px solid #333;border-radius:2px;background:none;color:#999;cursor:pointer">Remove</button>' +
          '</div>';

        card.querySelector('[data-remove]').addEventListener('click', function() {
          getFavorites().then(function(favs) {
            delete favs[id];
            var obj2 = {}; obj2[STORAGE_KEY] = favs;
            chrome.storage.local.set(obj2).then(function() {
              _favCache = favs;
              updateBadge();
              showFavoritesPanel();
            });
          });
        });

        list.appendChild(card);
      });

      // Footer
      var footer = document.createElement('div');
      footer.style.cssText = 'padding:8px 14px;border-top:1px solid #333;background:#1a1a1a;display:flex;gap:6px;flex-shrink:0';
      footer.innerHTML = '<button id="osu-fav-export" style="font-size:10px;padding:4px 10px;border:1px solid #333;border-radius:3px;background:none;color:#999;cursor:pointer">Export</button><button id="osu-fav-import" style="font-size:10px;padding:4px 10px;border:1px solid #333;border-radius:3px;background:none;color:#999;cursor:pointer">Import</button><input type="file" id="osu-fav-import-file" accept=".json" style="display:none">';

      panel.appendChild(header);
      panel.appendChild(list);
      panel.appendChild(footer);
      document.body.appendChild(panel);

      document.getElementById('osu-fav-panel-close').addEventListener('click', function() { panel.remove(); });
      document.getElementById('osu-fav-export').addEventListener('click', function() {
        var data = JSON.stringify(favs, null, 2);
        var blob = new Blob([data], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'osu-favorites-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
      });
      document.getElementById('osu-fav-import').addEventListener('click', function() {
        document.getElementById('osu-fav-import-file').click();
      });
      document.getElementById('osu-fav-import-file').addEventListener('change', function(e) {
        if (!e.target.files[0]) return;
        var reader = new FileReader();
        reader.onload = function(ev) {
          try {
            var data = JSON.parse(ev.target.result);
            if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected JSON object');
            getFavorites().then(function(existing) {
              var added = 0;
              for (var id in data) {
                if (!existing[id]) { existing[id] = data[id]; added++; }
              }
              var obj3 = {}; obj3[STORAGE_KEY] = existing;
              chrome.storage.local.set(obj3).then(function() {
                _favCache = existing;
                updateBadge();
                showFavoritesPanel();
              });
            });
          } catch (err) { alert('Import failed: ' + err.message); }
        };
        reader.readAsText(e.target.files[0]);
      });
    });
  }

  // ── Capture-phase click interception ───────────────────────────
  document.addEventListener('click', function(e) {
    var button = e.target.closest('button, a');
    if (!button) return;
    if (!isFavButton(button)) return;
    var ctx = resolveBeatmapContext(button);
    if (!ctx.beatmapId) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    toggleFavorite(ctx.beatmapId, ctx.card).then(function(nowFav) {
      if (nowFav === null) return;
      updateHeartVisual(button, nowFav);
      button.style.transform = 'scale(1.2)';
      button.style.transition = 'transform 0.1s ease';
      setTimeout(function() { button.style.transform = 'scale(1)'; }, 120);
    });
  }, true);

  // ── Mark and update visible buttons ────────────────────────────
  function refreshButtons() {
    try {
      var buttons = document.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        if (!isFavButton(btn)) continue;
        if (btn.dataset.osuFavChecked) continue;
        btn.dataset.osuFavChecked = '1';
        var ctx = resolveBeatmapContext(btn);
        if (ctx.beatmapId) {
          isFavorited(ctx.beatmapId).then(function(id, b) {
            return function(fav) { updateHeartVisual(b, fav); };
          }(ctx.beatmapId, btn));
        }
      }
    } catch(e) {}
  }

  // ── Observer ───────────────────────────────────────────────────
  var observerTimer = null;
  var observer = new MutationObserver(function() {
    if (observerTimer) return;
    observerTimer = setTimeout(function() {
      observerTimer = null;
      ensureHeartIndicator();
      addCopyAllButton();
      refreshButtons();
    }, 600);
  });

  // ── Init ───────────────────────────────────────────────────────
  function init() {
    getFavorites();
    ensureHeartIndicator();
    addCopyAllButton();

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    var attempts = 0;
    function poll() {
      refreshButtons();
      if (attempts < 12) { attempts++; setTimeout(poll, 400); }
    }
    setTimeout(poll, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
