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
  (function () {
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
        favourited_at: new Date().toISOString(),
        featured_artist: !!bm.track_id,
        nsfw: bm.nsfw || false,
        preview: 'https://b.ppy.sh/preview/' + bm.id + '.mp3'
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
        favourited_at: new Date().toISOString(),
        nsfw: !!document.querySelector('.beatmapset-badge--nsfw') || false,
        preview: 'https://b.ppy.sh/preview/' + id + '.mp3'
      };
    } catch (e) { return null; }
  }

  // ── Beatmap data extraction (listing cards) ────────────────────
  function getBeatmapDataFromCard(card) {
    if (!card) return null;
    // Skip cards inside pinned scores section
    if (card.closest('[data-page-id="pinnedScores"], .js-sortable--page .title--page-extra-small')) return null;
    try {
      var link = card.querySelector('a[href*="/beatmapsets/"]');
      if (!link) return null;
      var m = link.href.match(/\/beatmapsets\/(\d+)/);
      if (!m) return null;
      var id = m[1];

      // ── Title ──────────────────────────────────────────────────
      // The main panel link holds the beatmapset title
      var title = '';
      var titleEl = card.querySelector(
        '.beatmapset-panel__main-link, ' +
        'a[class*="main-link"], ' +
        '.beatmapset-panel__title, ' +
        '[class*="beatmapset-panel__title"]'
      );
      if (titleEl) {
        // Clone to strip any child badge/icon text
        var titleClone = titleEl.cloneNode(true);
        var titleBadge = titleClone.querySelector('.beatmapset-badge, [class*="badge"], i, svg');
        if (titleBadge) titleBadge.remove();
        title = titleClone.textContent.trim();
      }
      // Fallback: first info-row that isn't a "by"/"mapped by" line
      if (!title) {
        var ml = card.querySelector('a[href*="/beatmapsets/"]');
        if (ml) title = ml.textContent.trim();
      }

      // ── Artist ─────────────────────────────────────────────────
      // osu! cards render "by <artist>" in a dedicated element; grab that
      // element's text and strip the "by " prefix rather than parsing raw rows.
      var artist = '';
      var artistSelectors = [
        '.beatmapset-panel__artist',
        '[class*="beatmapset-panel__artist"]',
        '.beatmapset-panel__info-row--artist',
        '[class*="info-row--artist"]'
      ];
      for (var ai = 0; ai < artistSelectors.length; ai++) {
        var aEl = card.querySelector(artistSelectors[ai]);
        if (aEl) { artist = aEl.textContent.trim(); break; }
      }
      // Fallback: scan info-row text nodes for the "by …" line
      if (!artist) {
        var infoRows = card.querySelectorAll('.beatmapset-panel__info-row, [class*="info-row"]');
        for (var ir = 0; ir < infoRows.length; ir++) {
          var rowClone = infoRows[ir].cloneNode(true);
          // Remove stat icons/numbers — keep only text-node content
          var statEls = rowClone.querySelectorAll(
            '.beatmapset-badge, [class*="badge"], i, svg, ' +
            '[class*="stat"], [class*="count"], [class*="play"], [class*="fav"]'
          );
          for (var si = 0; si < statEls.length; si++) statEls[si].remove();
          var rowText = rowClone.textContent.trim();
          if (rowText.indexOf('by ') === 0) {
            artist = rowText.replace(/^by\s+/, '').replace(/Featured\s*Artist$/i, '').trim();
            break;
          }
        }
      }

      // ── Creator (mapper) ───────────────────────────────────────
      var creator = '';
      var creatorSelectors = [
        '.beatmapset-panel__mapper',
        '[class*="beatmapset-panel__mapper"]',
        '.beatmapset-panel__info-row--mapper',
        '[class*="info-row--mapper"]'
      ];
      for (var ci = 0; ci < creatorSelectors.length; ci++) {
        var cEl = card.querySelector(creatorSelectors[ci]);
        if (cEl) { creator = cEl.textContent.trim(); break; }
      }
      // Fallback: scan for "mapped by …" line in info rows
      if (!creator) {
        var infoRows2 = card.querySelectorAll('.beatmapset-panel__info-row, [class*="info-row"]');
        for (var ir2 = 0; ir2 < infoRows2.length; ir2++) {
          var rowClone2 = infoRows2[ir2].cloneNode(true);
          var statEls2 = rowClone2.querySelectorAll(
            '.beatmapset-badge, [class*="badge"], i, svg, ' +
            '[class*="stat"], [class*="count"], [class*="play"], [class*="fav"]'
          );
          for (var si2 = 0; si2 < statEls2.length; si2++) statEls2[si2].remove();
          var rowText2 = rowClone2.textContent.trim();
          if (rowText2.indexOf('mapped by ') === 0) {
            creator = rowText2.replace(/^mapped by\s+/, '').trim();
            break;
          }
        }
      }
      // Last resort: user links in card header area
      if (!creator) {
        var mapperLink = card.querySelector(
          'a[href*="/users/"], ' +
          '.beatmapset-panel__mapper a, ' +
          '[class*="mapper"] a'
        );
        if (mapperLink) creator = mapperLink.textContent.trim();
      }

      // source is not available in listing card DOM — leave blank rather
      // than accidentally capturing stats/date text as source
      var source = '';

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
        favourited_at: new Date().toISOString(),
        is_artist_featured: !!card.querySelector('.beatmapset-badge--featured_artist'),
        nsfw: !!card.querySelector('.beatmapset-badge--nsfw') || false,
        preview: 'https://b.ppy.sh/preview/' + id + '.mp3'
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

    // Primary: use closest() to find the nearest .beatmapset-panel card wrapper.
    // This avoids the bug where walking up parents and using querySelector on
    // a multi-card container would pick the first card's link instead of this one.
    var card = button.closest('.beatmapset-panel');
    if (card) {
      var link = card.querySelector('a[href*="/beatmapsets/"]');
      if (link) {
        var m = link.href.match(/\/beatmapsets\/(\d+)/);
        if (m) return { beatmapId: m[1], card: card, pageType: 'listing' };
      }
    }

    // Fallback: walk up the DOM for cases where .beatmapset-panel doesn't exist
    // (e.g. alternative card structures, older osu! pages)
    var el = button.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      var cls = (el.className || '').toString();
      // Skip menu containers — they have beatmap links but no metadata
      if (cls.indexOf('beatmapset-panel__menu') !== -1) {
        el = el.parentElement;
        continue;
      }
      // Only check direct children for links to avoid cross-card contamination
      var dlink = el.querySelector(':scope > a[href*="/beatmapsets/"]');
      if (dlink) {
        var dm = dlink.href.match(/\/beatmapsets\/(\d+)/);
        if (dm) return { beatmapId: dm[1], card: el, pageType: 'listing' };
      }
      el = el.parentElement;
    }

    return { beatmapId: null, card: null, pageType: 'unknown' };
  }

  // ── Storage ────────────────────────────────────────────────────
  // In-memory cache to avoid chrome.storage race conditions on fast toggles
  var _favCache = null;

  function getFavorites() {
    return chrome.storage.local.get(STORAGE_KEY).then(function (r) {
      _favCache = r[STORAGE_KEY] || {};
      return _favCache;
    }).catch(function () { return {}; });
  }

  function setFavorites(favs) {
    _favCache = favs;
    var obj = {};
    obj[STORAGE_KEY] = favs;
    return chrome.storage.local.set(obj).catch(function () { });
  }

  function updateBadge() {
    var count = _favCache ? Object.keys(_favCache).length : 0;
    chrome.runtime.sendMessage({ action: 'updateBadge' }).catch(function () { });
  }

  function isFavorited(id) {
    if (_favCache !== null) return Promise.resolve(!!_favCache[id]);
    return getFavorites().then(function (favs) { return !!favs[id]; });
  }

  // ── Background enrichment ──────────────────────────────────────
  // Fetches the beatmapset detail page and merges full JSON data into storage.
  // Called fire-and-forget after storing minimal card data, so the toggle is
  // always instant. Uses credentials so logged-in users get the full payload.
  function enrichBeatmapData(beatmapId) {
    return fetch('https://osu.ppy.sh/beatmapsets/' + beatmapId, { credentials: 'include' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (!html) return;
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');
        var el = doc.getElementById('json-beatmapset');
        if (!el) return;
        var raw;
        try { raw = JSON.parse(el.textContent); } catch (e) { return; }
        var bm = raw.beatmapset || raw;
        if (!bm || !bm.id) return;
        var enriched = {
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
          genre: (bm.genre && bm.genre.name) || '',
          language: (bm.language && bm.language.name) || '',
          url: 'https://osu.ppy.sh/beatmapsets/' + bm.id,
          is_artist_featured: !!bm.track_id,
          nsfw: bm.nsfw || false,
          preview: 'https://b.ppy.sh/preview/' + bm.id + '.mp3'
        };
        return getFavorites().then(function (favs) {
          var sid = String(bm.id);
          if (!favs[sid]) return; // Removed before enrichment finished — skip
          enriched.favourited_at = favs[sid].favourited_at || new Date().toISOString();
          favs[sid] = enriched;
          return setFavorites(favs);
        });
      })
      .catch(function () { });
  }

  // Sequentially enriches a list of IDs with a delay between each request
  // to avoid hammering osu!'s servers during bulk imports.
  function enrichBeatmapsSequential(ids, delayMs) {
    var i = 0;
    function next() {
      if (i >= ids.length) return;
      var id = ids[i++];
      enrichBeatmapData(id).then(function () { setTimeout(next, delayMs); });
    }
    setTimeout(next, delayMs);
  }

  function toggleFavorite(beatmapId, card) {
    // Use in-memory cache for instant toggle detection (avoids stale storage reads)
    return getFavorites().then(function (favs) {
      var wasFav = !!favs[beatmapId];
      var needsEnrich = false;
      if (wasFav) {
        delete favs[beatmapId];
      } else {
        var jsonData = getBeatmapDataFromJSON();
        if (jsonData) {
          favs[beatmapId] = jsonData;
        } else {
          // Not on a detail page — store card data immediately for instant feedback,
          // then enrich in the background with a full page fetch
          needsEnrich = true;
          var data = getBeatmapDataFromDetailDOM() || getBeatmapDataFromCard(card);
          favs[beatmapId] = data || {
            id: beatmapId,
            url: 'https://osu.ppy.sh/beatmapsets/' + beatmapId,
            favourited_at: new Date().toISOString()
          };
        }
      }
      return setFavorites(favs).then(function () {
        updateBadge();
        if (needsEnrich) enrichBeatmapData(beatmapId);
        return !wasFav;
      });
    }).catch(function () {
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

  // ── Copy-all button ("Favourite Beatmaps" section) ────────────
  function addCopyAllButton() {
    // Find the "Favourite Beatmaps" heading inside the Beatmaps section
    // Works on profile pages: /users/* (any user)
    var favHeading = document.querySelector('.js-sortable--page[data-page-id="beatmaps"] h3.title--page-extra-small');
    if (!favHeading) return;
    var ht = favHeading.textContent || '';
    if (ht.indexOf('Favourite') === -1 && ht.indexOf('Favorite') === -1) return;
    // Guard: don't add the button twice
    if (favHeading.querySelector('.osu-fav-all-btn')) return;

    var btn = document.createElement('button');
    btn.className = 'osu-fav-all-btn';
    btn.textContent = 'Favorite all';
    btn.style.cssText = 'margin-left:10px;padding:2px 10px;font-size:11px;background:#ff66aa;color:#fff;border:none;border-radius:3px;cursor:pointer;font-weight:600;transform:scale(1);transition:transform 0.1s';

    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      btn.textContent = 'Loading all...';
      btn.disabled = true;

      // The grid that holds beatmap panels in the Favourite Beatmaps section
      var grid = document.querySelector('.js-sortable--page[data-page-id="beatmaps"] .page-extra__beatmapsets.js-audio--group');

      // Click "show more" once and wait for new cards to appear.
      // Returns a Promise that resolves when cards finish loading.
      function clickShowMoreOnce() {
        var showMore = document.querySelector('.show-more-link--profile-page-beatmapsets');
        if (!showMore) return Promise.resolve();
        if (showMore.offsetParent === null || showMore.disabled) return Promise.resolve();

        var before = grid ? grid.querySelectorAll('.beatmapset-panel').length : 0;
        showMore.click();

        return new Promise(function (resolve) {
          var attempts = 0;
          function check() {
            attempts++;
            var after = grid ? grid.querySelectorAll('.beatmapset-panel').length : 0;
            var sm = document.querySelector('.show-more-link--profile-page-beatmapsets');
            // Resolve when new cards appear OR show-more button disappears
            if (after > before || !sm || sm.offsetParent === null || attempts > 30) {
              resolve();
            } else {
              setTimeout(check, 400);
            }
          }
          setTimeout(check, 500);
        });
      }

      // Recursively click "show more" until all beatmaps are loaded
      function loadAllBeatmaps() {
        return clickShowMoreOnce().then(function () {
          var sm = document.querySelector('.show-more-link--profile-page-beatmapsets');
          if (sm && sm.offsetParent !== null && !sm.disabled) {
            return loadAllBeatmaps();
          }
        });
      }

      loadAllBeatmaps().then(function () {
        return getFavorites();
      }).then(function (favs) {
        if (!grid) return;
        var cards = grid.querySelectorAll('.beatmapset-panel, .beatmapsets__item');
        // Use a decreasing base timestamp so top-to-bottom DOM order is preserved
        // (panel sorts by favourited_at descending)
        var baseTime = Date.now();
        var count = 0;
        var newIds = [];
        cards.forEach(function (card, i) {
          var data = getBeatmapDataFromCard(card);
          if (data && !favs[data.id]) {
            // Subtract i seconds so first card (top) gets newest timestamp
            data.favourited_at = new Date(baseTime - i * 1000).toISOString();
            favs[data.id] = data;
            newIds.push(data.id);
            count++;
          }
        });

        return setFavorites(favs).then(function () {
          updateBadge();
          // Refresh the favorites panel if it's already open
          if (document.getElementById('osu-local-fav-panel')) {
            document.getElementById('osu-local-fav-panel').remove();
            showFavoritesPanel();
          }
          btn.textContent = 'Added ' + count + ', enriching...';
          // Enrich each card with full page data sequentially (400ms between requests)
          enrichBeatmapsSequential(newIds, 400);
          setTimeout(function () { btn.textContent = 'Favorite all'; btn.disabled = false; }, 2000);
        });
      }).catch(function () {
        btn.textContent = 'Error';
        setTimeout(function () { btn.textContent = 'Favorite all'; btn.disabled = false; }, 2000);
      });
    });

    // Append button inside the heading element
    favHeading.appendChild(btn);
  }

  // ── Floating indicator (all pages) ─────────────────────────────
  function ensureHeartIndicator() {
    if (document.getElementById('osu-local-fav-indicator')) return;
    var ind = document.createElement('div');
    ind.id = 'osu-local-fav-indicator';
    ind.title = 'View local favorites';
    ind.style.cssText = 'position:fixed;bottom:40px;right:100px;z-index:99999;width:50px;height:50px;border-radius:50%;background:rgba(22,33,62,0.95);border:2px solid #ff66aa;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:26px;line-height:1;transition:all 0.2s ease;box-shadow:0 2px 16px rgba(255,102,170,0.3);user-select:none;-webkit-user-select:none;';
    ind.textContent = '🤍';
    ind.addEventListener('click', function (e) {
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

    var currentSort = 'date', sortAsc = false, searchQuery = '';

    // ── Inject CSS ──────────────────────────────────────────────────────────
    if (!document.getElementById('osu-fav-panel-style')) {
      var s = document.createElement('style');
      s.id = 'osu-fav-panel-style';
      s.textContent = [
        '#osu-local-fav-panel{--bg:#111;--bg-surface:#1a1a1a;--bg-card:#222;--bg-card-hover:#2a2a2a;--bg-input:#1a1a1a;--text:#ddd;--text-secondary:#999;--text-muted:#666;--border:#333;--border-hover:#555;--pink:#ff66aa;--pink-dim:rgba(255,102,170,.12);--radius:4px;position:fixed;top:0;right:0;z-index:100000;width:360px;height:100vh;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;border-left:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;box-shadow:-2px 0 16px rgba(0,0,0,.5)}',
        '#osu-local-fav-panel *{box-sizing:border-box;margin:0;padding:0}',
        '#osu-fav-header{padding:12px 14px 8px;background:var(--bg-surface);border-bottom:2px solid var(--pink);flex-shrink:0}',
        '#osu-fav-header-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
        '.osu-fav-logo{width:28px;height:28px;border-radius:50%;flex-shrink:0}',
        '#osu-fav-title{flex:1;font-size:15px;font-weight:600;letter-spacing:-.2px}',
        '#osu-fav-title span{color:var(--pink)}',
        '.osu-fav-count{font-size:11px;color:var(--pink);background:var(--pink-dim);padding:2px 8px;border-radius:10px}',
        '.osu-fav-close{background:none;border:1px solid var(--border);color:var(--text-muted);cursor:pointer;padding:2px 8px;border-radius:3px;font-size:12px;flex-shrink:0}',
        '.osu-fav-close:hover{border-color:var(--border-hover);color:var(--text)}',
        '#osu-fav-search{width:100%;padding:7px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:12px;outline:none}',
        '#osu-fav-search::placeholder{color:var(--text-muted)}',
        '#osu-fav-search:focus{border-color:var(--pink)}',
        '#osu-fav-toolbar{display:flex;align-items:center;gap:6px;padding:6px 14px;background:var(--bg-surface);border-bottom:1px solid var(--border);flex-shrink:0}',
        '.osu-fav-sort-group{display:flex;gap:2px;flex:1}',
        '.osu-fav-sort-btn{font-size:10px;font-weight:500;padding:3px 8px;border:1px solid transparent;border-radius:3px;background:transparent;color:var(--text-muted);cursor:pointer;user-select:none}',
        '.osu-fav-sort-btn:hover{color:var(--text-secondary)}',
        '.osu-fav-sort-btn.active{background:var(--pink);color:#fff}',
        '.osu-fav-actions{display:flex;gap:3px;flex-shrink:0}',
        '.osu-fav-action-btn{font-size:10px;padding:3px 8px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--text-secondary);cursor:pointer}',
        '.osu-fav-action-btn:hover{border-color:var(--pink);color:var(--pink)}',
        '#osu-fav-list{flex:1;overflow-y:auto}',
        '#osu-fav-list::-webkit-scrollbar{width:4px}',
        '#osu-fav-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}',
        '#osu-fav-list::-webkit-scrollbar-thumb:hover{background:var(--pink)}',
        '.osu-fav-card{display:flex;gap:8px;padding:8px 14px;border-bottom:1px solid #1e1e1e;align-items:center;transition:background .1s}',
        '.osu-fav-card:hover{background:var(--bg-card-hover)}',
        '.osu-fav-cover{width:56px;height:42px;border-radius:2px;overflow:hidden;flex-shrink:0;background:var(--bg-input);display:flex;align-items:center;justify-content:center}',
        '.osu-fav-cover img{width:100%;height:100%;object-fit:cover}',
        '.osu-fav-cover-empty{font-size:10px;color:var(--text-muted)}',
        '.osu-fav-info{flex:1;min-width:0}',
        '.osu-fav-card-title{font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}',
        '.osu-fav-card-artist{font-size:10px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;display:flex;align-items:center;gap:4px}',
        '.osu-fav-card-artist span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.osu-fav-card-meta{display:flex;gap:5px;font-size:10px;color:var(--text-muted);margin-top:2px;align-items:center}',
        '.osu-fav-card-mapper{color:var(--pink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px}',
        '.osu-fav-card-status{font-weight:700;text-transform:uppercase;font-size:8px;letter-spacing:.3px}',
        '.osu-fav-card-bpm{font-size:9px}',
        '.osu-fav-card-date{font-size:9px;color:var(--text-muted);margin-top:1px}',
        '.osu-fav-nsfw-badge{font-size:8px;color:#f6c243;border:1px solid #f6c243;border-radius:2px;padding:0 3px;vertical-align:middle;font-weight:600;margin-left:3px;flex-shrink:0}',
        '.osu-fav-fa-badge{font-size:8px;color:#66ccff;border:1px solid #66ccff;border-radius:2px;padding:0 3px;vertical-align:middle;font-weight:600;flex-shrink:0}',
        '.osu-fav-card-actions{display:flex;flex-direction:column;gap:2px;flex-shrink:0}',
        '.osu-fav-open{font-size:10px;padding:2px 6px;border:1px solid var(--border);border-radius:2px;color:var(--text-muted);text-decoration:none;text-align:center;display:block}',
        '.osu-fav-open:hover{border-color:var(--pink);color:var(--pink)}',
        '.osu-fav-remove{font-size:10px;padding:2px 6px;border:1px solid var(--border);border-radius:2px;background:none;color:var(--text-muted);cursor:pointer}',
        '.osu-fav-remove:hover{border-color:#e55;color:#e55}',
        '.osu-fav-preview{font-size:11px;padding:2px 6px;border:1px solid var(--border);border-radius:2px;background:none;color:var(--text-muted);cursor:pointer;text-align:center;line-height:1}',
        '.osu-fav-preview:hover{border-color:var(--pink);color:var(--pink)}',
        '.osu-fav-preview.playing{border-color:var(--pink);color:var(--pink);background:var(--pink-dim)}',
        '.osu-fav-progress{height:2px;background:var(--border);border-radius:1px;margin-top:3px;overflow:hidden;display:none}',
        '.osu-fav-progress.active{display:block}',
        '.osu-fav-progress-bar{height:100%;width:0%;background:var(--pink);border-radius:1px}',
        '#osu-fav-footer{padding:6px 14px;background:var(--bg-surface);border-top:1px solid var(--border);flex-shrink:0}',
        '.osu-fav-remove-all{width:100%;font-size:10px;padding:4px 10px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--text-muted);cursor:pointer;transition:background .1s,color .1s,border-color .1s}',
        '.osu-fav-remove-all:hover{border-color:#e55;color:#e55}',
        '.osu-fav-remove-all.confirming{background:#e55;color:#fff;border-color:#e55;font-weight:600}',
        '.osu-fav-empty{text-align:center;color:var(--text-muted);padding:40px 20px;font-size:12px}',
        '.osu-fav-toast{position:fixed;bottom:20px;right:380px;z-index:100001;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:7px 14px;font-size:12px;color:var(--text-secondary);box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none}'
      ].join('');
      document.head.appendChild(s);
    }

    // ── Panel shell ─────────────────────────────────────────────────────────
    var panel = document.createElement('div');
    panel.id = 'osu-local-fav-panel';

    // ── Header ──────────────────────────────────────────────────────────────
    var header = document.createElement('div');
    header.id = 'osu-fav-header';

    var headerRow = document.createElement('div');
    headerRow.id = 'osu-fav-header-row';

    var logoEl = document.createElement('img');
    logoEl.className = 'osu-fav-logo';
    logoEl.src = chrome.runtime.getURL('icons/icon48.png');
    logoEl.alt = '';

    var titleEl = document.createElement('h2');
    titleEl.id = 'osu-fav-title';
    titleEl.innerHTML = 'osu! <span>Favorites</span>';

    var countBadge = document.createElement('span');
    countBadge.className = 'osu-fav-count';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'osu-fav-close';
    closeBtn.textContent = '\u00d7 Close';
    closeBtn.addEventListener('click', function () { panel.remove(); });

    headerRow.appendChild(logoEl);
    headerRow.appendChild(titleEl);
    headerRow.appendChild(countBadge);
    headerRow.appendChild(closeBtn);

    var searchInput = document.createElement('input');
    searchInput.id = 'osu-fav-search';
    searchInput.type = 'text';
    searchInput.placeholder = 'Search title, artist, mapper...';
    searchInput.addEventListener('input', function () { searchQuery = searchInput.value; renderList(); });

    header.appendChild(headerRow);
    header.appendChild(searchInput);

    // ── Toolbar ─────────────────────────────────────────────────────────────
    var toolbar = document.createElement('div');
    toolbar.id = 'osu-fav-toolbar';

    var sortGroup = document.createElement('div');
    sortGroup.className = 'osu-fav-sort-group';

    var SORTS = ['date', 'title', 'artist', 'status'];
    var sortBtns = {};
    SORTS.forEach(function (s) {
      var btn = document.createElement('button');
      btn.className = 'osu-fav-sort-btn';
      btn.dataset.sort = s;
      btn.addEventListener('click', function () {
        if (currentSort === s) { sortAsc = !sortAsc; }
        else { currentSort = s; sortAsc = false; }
        updateSortBtns();
        renderList();
      });
      sortGroup.appendChild(btn);
      sortBtns[s] = btn;
    });

    function updateSortBtns() {
      SORTS.forEach(function (s) {
        var btn = sortBtns[s];
        var isActive = currentSort === s;
        btn.textContent = s[0].toUpperCase() + s.slice(1) + (isActive ? (sortAsc ? ' \u2191' : ' \u2193') : '');
        btn.classList.toggle('active', isActive);
      });
    }

    var exportBtn = document.createElement('button');
    exportBtn.className = 'osu-fav-action-btn'; exportBtn.textContent = 'Export';
    var importBtn = document.createElement('button');
    importBtn.className = 'osu-fav-action-btn'; importBtn.textContent = 'Import';
    var importFile = document.createElement('input');
    importFile.type = 'file'; importFile.accept = '.json'; importFile.style.display = 'none';

    var actionsGroup = document.createElement('div');
    actionsGroup.className = 'osu-fav-actions';
    actionsGroup.appendChild(exportBtn);
    actionsGroup.appendChild(importBtn);
    actionsGroup.appendChild(importFile);

    toolbar.appendChild(sortGroup);
    toolbar.appendChild(actionsGroup);

    // ── List ────────────────────────────────────────────────────────────────
    var listEl = document.createElement('div');
    listEl.id = 'osu-fav-list';

    // ── Footer ──────────────────────────────────────────────────────────────
    var footer = document.createElement('div');
    footer.id = 'osu-fav-footer';
    var removeAllBtn = document.createElement('button');
    removeAllBtn.className = 'osu-fav-remove-all';
    removeAllBtn.textContent = 'Remove all';
    footer.appendChild(removeAllBtn);

    // ── Helpers ─────────────────────────────────────────────────────────────
    function statusColor(s) {
      return ({
        ranked: '#4caf50', loved: '#ff66aa', qualified: '#4fc3f7',
        approved: '#4caf50', pending: '#ff9800', wip: '#f44336',
        graveyard: '#666', vip: '#f6c243'
      }[s] || '#888');
    }
    function formatDate(iso) {
      if (!iso) return '';
      var d = new Date(iso), diff = Date.now() - d;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
      return d.toLocaleDateString();
    }
    function showToast(msg) {
      var t = document.createElement('div');
      t.className = 'osu-fav-toast'; t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 2500);
    }

    // ── Render ──────────────────────────────────────────────────────────────
    function renderList() {
      getFavorites().then(function (favs) {
        var entries = Object.entries(favs);
        countBadge.textContent = Object.keys(favs).length;

        if (searchQuery.trim()) {
          var q = searchQuery.toLowerCase();
          entries = entries.filter(function (e) {
            var f = e[1];
            return (f.title || '').toLowerCase().includes(q) ||
              (f.artist || '').toLowerCase().includes(q) ||
              (f.creator || '').toLowerCase().includes(q) ||
              (f.tags || '').toLowerCase().includes(q) ||
              (f.source || '').toLowerCase().includes(q) ||
              (f.id || '').includes(q);
          });
        }

        entries.sort(function (a, b) {
          var fa = a[1], fb = b[1], cmp = 0;
          if (currentSort === 'date') cmp = (fa.favourited_at || '').localeCompare(fb.favourited_at || '');
          if (currentSort === 'title') cmp = (fa.title || '').localeCompare(fb.title || '');
          if (currentSort === 'artist') cmp = (fa.artist || '').localeCompare(fb.artist || '');
          if (currentSort === 'status') cmp = (fa.status || '').localeCompare(fb.status || '');
          if (cmp === 0) cmp = b[0].localeCompare(a[0]);
          return sortAsc ? cmp : -cmp;
        });

        listEl.innerHTML = '';

        if (Object.keys(favs).length === 0) {
          listEl.innerHTML = '<p class="osu-fav-empty">No favorites yet.</p>';
          return;
        }
        if (entries.length === 0) {
          listEl.innerHTML = '<p class="osu-fav-empty">No matches.</p>';
          return;
        }

        var frag = document.createDocumentFragment();

        // Singleton audio player so only one preview plays at a time
        if (!window._osuFavAudio) {
          window._osuFavAudio = new Audio();
          window._osuFavAudio._activeBtn = null;
          window._osuFavAudio._activeBar = null;
          window._osuFavAudio.addEventListener('ended', function () {
            if (window._osuFavAudio._activeBtn) {
              window._osuFavAudio._activeBtn.textContent = '\u25b6';
              window._osuFavAudio._activeBtn.classList.remove('playing');
            }
            if (window._osuFavAudio._activeBar) {
              window._osuFavAudio._activeBar.parentElement.classList.remove('active');
              window._osuFavAudio._activeBar.style.width = '0%';
            }
            window._osuFavAudio._activeBtn = null;
            window._osuFavAudio._activeBar = null;
          });
          window._osuFavAudio.addEventListener('timeupdate', function () {
            if (window._osuFavAudio._activeBar && window._osuFavAudio.duration) {
              var pct = (window._osuFavAudio.currentTime / window._osuFavAudio.duration) * 100;
              window._osuFavAudio._activeBar.style.width = pct + '%';
            }
          });
        }

        entries.forEach(function (entry) {
          var id = entry[0], f = entry[1];
          var card = document.createElement('div');
          card.className = 'osu-fav-card';

          // Cover
          var coverEl = document.createElement('div');
          coverEl.className = 'osu-fav-cover';
          var coverUrl = (f.covers && (f.covers.card || f.covers['card@2x'] || f.covers.list || f.covers.cover)) || '';
          if (coverUrl) {
            var img = document.createElement('img');
            img.src = coverUrl; img.loading = 'lazy';
            img.addEventListener('error', function () {
              img.remove();
              var empty = document.createElement('span');
              empty.className = 'osu-fav-cover-empty'; empty.textContent = 'No cover';
              coverEl.appendChild(empty);
            });
            coverEl.appendChild(img);
          } else {
            var empty2 = document.createElement('span');
            empty2.className = 'osu-fav-cover-empty'; empty2.textContent = 'No cover';
            coverEl.appendChild(empty2);
          }

          // Info
          var info = document.createElement('div');
          info.className = 'osu-fav-info';

          var titleDiv = document.createElement('div');
          titleDiv.className = 'osu-fav-card-title';
          titleDiv.textContent = f.title || f.title_unicode || 'Unknown';
          if (f.nsfw) {
            var nsfwBadge = document.createElement('span');
            nsfwBadge.className = 'osu-fav-nsfw-badge'; nsfwBadge.textContent = 'EXPLICIT';
            titleDiv.appendChild(nsfwBadge);
          }

          var artistDiv = document.createElement('div');
          artistDiv.className = 'osu-fav-card-artist';
          var artistText = document.createElement('span');
          artistText.textContent = f.artist || f.artist_unicode || '';
          artistDiv.appendChild(artistText);
          if (f.is_artist_featured) {
            var faBadge = document.createElement('span');
            faBadge.className = 'osu-fav-fa-badge'; faBadge.textContent = 'FEATURED ARTIST';
            artistDiv.appendChild(faBadge);
          }

          var metaDiv = document.createElement('div');
          metaDiv.className = 'osu-fav-card-meta';
          if (f.creator) {
            var m = document.createElement('span');
            m.className = 'osu-fav-card-mapper'; m.textContent = f.creator;
            metaDiv.appendChild(m);
          }
          if (f.status) {
            var st = document.createElement('span');
            st.className = 'osu-fav-card-status';
            st.textContent = f.status.toUpperCase();
            st.style.color = statusColor(f.status);
            metaDiv.appendChild(st);
          }
          if (f.bpm) {
            var bpm = document.createElement('span');
            bpm.className = 'osu-fav-card-bpm'; bpm.textContent = f.bpm + ' BPM';
            metaDiv.appendChild(bpm);
          }

          var dateDiv = document.createElement('div');
          dateDiv.className = 'osu-fav-card-date';
          dateDiv.textContent = formatDate(f.favourited_at);

          // Progress bar (shown when playing)
          var progressWrap = document.createElement('div');
          progressWrap.className = 'osu-fav-progress';
          var progressBar = document.createElement('div');
          progressBar.className = 'osu-fav-progress-bar';
          progressWrap.appendChild(progressBar);

          info.appendChild(titleDiv);
          info.appendChild(artistDiv);
          info.appendChild(metaDiv);
          info.appendChild(dateDiv);
          info.appendChild(progressWrap);

          // Actions
          var actions = document.createElement('div');
          actions.className = 'osu-fav-card-actions';

          var openLink = document.createElement('a');
          openLink.className = 'osu-fav-open';
          openLink.href = f.url || 'https://osu.ppy.sh/beatmapsets/' + id;
          openLink.target = '_blank'; openLink.textContent = 'Open';

          var removeBtn2 = document.createElement('button');
          removeBtn2.className = 'osu-fav-remove'; removeBtn2.textContent = 'Remove';
          (function (rid) {
            removeBtn2.addEventListener('click', function () {
              getFavorites().then(function (favs2) {
                delete favs2[rid];
                var obj = {}; obj[STORAGE_KEY] = favs2;
                chrome.storage.local.set(obj).then(function () {
                  _favCache = favs2;
                  updateBadge();
                  renderList();
                });
              });
            });
          })(id);

          actions.appendChild(openLink);

          // Preview button (always present — URL is derived from ID)
          var previewUrl = f.preview || ('https://b.ppy.sh/preview/' + id + '.mp3');
          var previewBtn = document.createElement('button');
          previewBtn.className = 'osu-fav-preview';
          previewBtn.textContent = '\u25b6';
          previewBtn.title = 'Preview audio';
          (function (pUrl, pBtn, pBar, pWrap) {
            pBtn.addEventListener('click', function () {
              var audio = window._osuFavAudio;
              var isSame = (audio.src === pUrl || audio.src.replace('https://', '') === pUrl.replace('https://', ''));
              if (isSame) {
                if (!audio.paused) {
                  audio.pause();
                  pBtn.textContent = '\u25b6';
                  pBtn.classList.remove('playing');
                } else {
                  audio.play();
                  pBtn.textContent = '\u23f8';
                  pBtn.classList.add('playing');
                }
                return;
              }
              // Stop current track
              if (audio._activeBtn) {
                audio._activeBtn.textContent = '\u25b6';
                audio._activeBtn.classList.remove('playing');
              }
              if (audio._activeBar) {
                audio._activeBar.parentElement.classList.remove('active');
                audio._activeBar.style.width = '0%';
              }
              audio.pause();
              // Start new track
              audio.src = pUrl;
              audio._activeBtn = pBtn;
              audio._activeBar = pBar;
              pWrap.classList.add('active');
              pBtn.textContent = '\u23f8';
              pBtn.classList.add('playing');
              audio.play().catch(function () {
                pBtn.textContent = '\u25b6';
                pBtn.classList.remove('playing');
              });
            });
          })(previewUrl, previewBtn, progressBar, progressWrap);
          actions.appendChild(previewBtn);

          actions.appendChild(removeBtn2);
          card.appendChild(coverEl);
          card.appendChild(info);
          card.appendChild(actions);
          frag.appendChild(card);
        });

        listEl.appendChild(frag);
      });
    }

    // ── Assemble ────────────────────────────────────────────────────────────
    panel.appendChild(header);
    panel.appendChild(toolbar);
    panel.appendChild(listEl);
    panel.appendChild(footer);
    document.body.appendChild(panel);
    updateSortBtns();
    renderList();

    // ── Events ──────────────────────────────────────────────────────────────
    exportBtn.addEventListener('click', function () {
      getFavorites().then(function (favs) {
        var data = JSON.stringify(favs, null, 2);
        var blob = new Blob([data], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'osu-favorites-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click(); URL.revokeObjectURL(a.href);
        showToast('Exported!');
      });
    });

    importBtn.addEventListener('click', function () { importFile.click(); });
    importFile.addEventListener('change', function (e) {
      if (!e.target.files[0]) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var data = JSON.parse(ev.target.result);
          if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected JSON object');
          getFavorites().then(function (existing) {
            var added = 0;
            for (var fid in data) {
              if (!existing[fid]) { existing[fid] = data[fid]; added++; }
            }
            var obj2 = {}; obj2[STORAGE_KEY] = existing;
            chrome.storage.local.set(obj2).then(function () {
              _favCache = existing;
              updateBadge();
              renderList();
              showToast('Added ' + added + '. Total: ' + Object.keys(existing).length);
            });
          });
        } catch (err) { showToast('Import failed: ' + err.message); }
      };
      reader.readAsText(e.target.files[0]);
      e.target.value = '';
    });

    var confirming = false;
    removeAllBtn.addEventListener('click', function () {
      if (!confirming) {
        confirming = true;
        removeAllBtn.textContent = 'You sure?';
        removeAllBtn.classList.add('confirming');
        setTimeout(function () {
          if (confirming) {
            confirming = false;
            removeAllBtn.textContent = 'Remove all';
            removeAllBtn.classList.remove('confirming');
          }
        }, 3000);
      } else {
        var obj3 = {}; obj3[STORAGE_KEY] = {};
        chrome.storage.local.set(obj3).then(function () {
          _favCache = {};
          updateBadge();
          panel.remove();
        });
      }
    });
  }

  // ── Capture-phase click interception ───────────────────────────
  document.addEventListener('click', function (e) {
    var button = e.target.closest('button, a');
    if (!button) return;
    if (!isFavButton(button)) return;
    var ctx = resolveBeatmapContext(button);
    if (!ctx.beatmapId) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    toggleFavorite(ctx.beatmapId, ctx.card).then(function (nowFav) {
      if (nowFav === null) return;
      updateHeartVisual(button, nowFav);
      button.style.transform = 'scale(1.2)';
      button.style.transition = 'transform 0.1s ease';
      setTimeout(function () { button.style.transform = 'scale(1)'; }, 120);
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
          isFavorited(ctx.beatmapId).then(function (id, b) {
            return function (fav) { updateHeartVisual(b, fav); };
          }(ctx.beatmapId, btn));
        }
      }
    } catch (e) { }
  }

  // ── Observer ───────────────────────────────────────────────────
  var observerTimer = null;
  var observer = new MutationObserver(function () {
    if (observerTimer) return;
    observerTimer = setTimeout(function () {
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
