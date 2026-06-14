// ==UserScript==
// @name         osu! Local Favorites
// @namespace    https://github.com/vyroxat/Local-osu-Favorites
// @version      3.6.1
// @icon         https://github.com/vyroxat/Local-osu-Favorites/blob/main/icons/icon48.png?raw=true
// @description  Store osu! beatmap favorites locally instead of on osu!'s servers. Works without sign-in.
// @author       vyroxat
// @match        https://osu.ppy.sh/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @run-at       document-start
// ==/UserScript==

/* === osu! Local Favorites — Tampermonkey Edition === */
(() => {
  "use strict";

  const STORAGE_KEY = "osu_local_favorites";

  // ═══ Page-world XHR/fetch interceptor ═══
  // Also blocks login redirects triggered by unauthenticated favourite actions.
  function injectInterceptor() {
    const script = document.createElement("script");
    script.textContent = `(${function () {
      // ── XHR intercept: block /favourites requests ──
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === "string" && url.includes("/favourites")) {
          this.__blocked = true;
        }
        return origOpen.apply(this, arguments);
      };
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        if (this.__blocked) {
          try {
            Object.defineProperty(this, "readyState", {
              value: 4,
              writable: true,
              configurable: true,
            });
            Object.defineProperty(this, "status", {
              value: 200,
              writable: true,
              configurable: true,
            });
            Object.defineProperty(this, "responseText", {
              value: "{}",
              writable: true,
              configurable: true,
            });
          } catch (e) {}
          setTimeout(() => {
            if (this.onload) this.onload();
            if (this.onreadystatechange) this.onreadystatechange();
          }, 0);
          return;
        }
        return origSend.apply(this, arguments);
      };

      // ── Fetch intercept: block /favourites and auth-error responses ──
      const origFetch = window.fetch;
      window.fetch = function (url, options) {
        const urlStr = typeof url === "string" ? url : (url && url.url) || "";
        if (urlStr.includes("/favourites")) {
          return Promise.resolve(
            new Response("{}", {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return origFetch.apply(this, arguments);
      };

      // ── Navigation intercept: block login redirects from favourite clicks ──
      // osu! SPA navigates via history.pushState when not logged in for some actions.
      // We trap pushState/replaceState and location.href assignments that redirect to /login.
      // Only redirects that originate within 500ms of a favourite-click are blocked.
      let _favClickPending = false;
      document.addEventListener("click", function (e) {
        const btn = e.target && e.target.closest && e.target.closest("button, a");
        if (!btn) return;
        // Check if this looks like a favourite button
        const title = (btn.getAttribute("title") || btn.getAttribute("aria-label") || "").toLowerCase();
        const cls = (btn.className || "").toLowerCase();
        const text = (btn.textContent || "").toLowerCase();
        const href = (btn.getAttribute("href") || "");
        const isFavLike =
          title.includes("avourite") || title.includes("avorite") ||
          cls.includes("avourite") || cls.includes("avorite") ||
          text.includes("avourite") || text.includes("avorite") ||
          btn.querySelector(".fa-heart, .fas.fa-heart, .far.fa-heart") ||
          href.includes("/favourites");
        if (isFavLike) {
          _favClickPending = true;
          setTimeout(() => { _favClickPending = false; }, 800);
        }
      }, true);

      const _origPushState = history.pushState.bind(history);
      history.pushState = function (state, title, url) {
        if (_favClickPending && typeof url === "string" && url.includes("/login")) {
          return; // block login redirect
        }
        return _origPushState(state, title, url);
      };

      const _origReplaceState = history.replaceState.bind(history);
      history.replaceState = function (state, title, url) {
        if (_favClickPending && typeof url === "string" && url.includes("/login")) {
          return; // block login redirect
        }
        return _origReplaceState(state, title, url);
      };

      // Intercept anchor navigation to /login triggered by favourite actions
      document.addEventListener("click", function (e) {
        const a = e.target && e.target.closest && e.target.closest("a");
        if (!a) return;
        const href = a.getAttribute("href") || "";
        if (href.includes("/login") && _favClickPending) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }, true);
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
      const el = document.getElementById("json-beatmapset");
      if (!el) return null;
      const raw = JSON.parse(el.textContent);
      const bm = raw.beatmapset || raw;
      return {
        id: String(bm.id),
        artist: bm.artist || "",
        artist_unicode: bm.artist_unicode || bm.artist || "",
        title: bm.title || "",
        title_unicode: bm.title_unicode || bm.title || "",
        creator: bm.creator || "",
        user_id: String(bm.user_id || ""),
        covers: bm.covers || {},
        status: bm.status || "",
        favourite_count: bm.favourite_count || 0,
        play_count: bm.play_count || 0,
        bpm: bm.bpm || 0,
        source: bm.source || "",
        tags: bm.tags || "",
        genre: (bm.genre && bm.genre.name) || "",
        language: (bm.language && bm.language.name) || "",
        url: "https://osu.ppy.sh/beatmapsets/" + bm.id,
        favourited_at: new Date().toISOString(),
        is_artist_featured: !!bm.track_id,
        nsfw: bm.nsfw || false,
        preview: "https://b.ppy.sh/preview/" + bm.id + ".mp3",
      };
    } catch (e) {
      return null;
    }
  }

  function getBeatmapDataFromCard(card) {
    if (!card) return null;
    // Skip cards inside pinned scores section
    if (
      card.closest(
        '[data-page-id="pinnedScores"], .js-sortable--page .title--page-extra-small',
      )
    )
      return null;
    try {
      const link = card.querySelector('a[href*="/beatmapsets/"]');
      if (!link) return null;
      const m = link.href.match(/\/beatmapsets\/(\d+)/);
      if (!m) return null;
      const id = m[1];

      // ── Title ────────────────────────────────────────────────────
      let title = "";
      const titleEl = card.querySelector(
        '.beatmapset-panel__main-link, a[class*="main-link"], ' +
          '.beatmapset-panel__title, [class*="beatmapset-panel__title"]',
      );
      if (titleEl) {
        const titleClone = titleEl.cloneNode(true);
        titleClone
          .querySelectorAll('.beatmapset-badge, [class*="badge"], i, svg')
          .forEach((n) => n.remove());
        title = titleClone.textContent.trim();
      }
      if (!title) {
        const ml = card.querySelector('a[href*="/beatmapsets/"]');
        if (ml) title = ml.textContent.trim();
      }

      // ── Artist ───────────────────────────────────────────────────
      // Use dedicated semantic elements first; fall back to filtered info-row text.
      // Never read raw info-row text without stripping stat nodes — doing so causes
      // play counts / fav counts / dates to bleed into the artist field.
      let artist = "";
      for (const sel of [
        ".beatmapset-panel__artist",
        '[class*="beatmapset-panel__artist"]',
        ".beatmapset-panel__info-row--artist",
        '[class*="info-row--artist"]',
      ]) {
        const el = card.querySelector(sel);
        if (el) {
          artist = el.textContent.trim();
          break;
        }
      }
      if (!artist) {
        for (const row of card.querySelectorAll(
          '.beatmapset-panel__info-row, [class*="info-row"]',
        )) {
          const clone = row.cloneNode(true);
          clone
            .querySelectorAll(
              '.beatmapset-badge, [class*="badge"], i, svg, ' +
                '[class*="stat"], [class*="count"], [class*="play"], [class*="fav"]',
            )
            .forEach((n) => n.remove());
          const txt = clone.textContent.trim();
          if (txt.startsWith("by ")) {
            artist = txt
              .replace(/^by\s+/, "")
              .replace(/Featured\s*Artist$/i, "")
              .trim();
            break;
          }
        }
      }

      // ── Creator (mapper) ─────────────────────────────────────────
      let creator = "";
      for (const sel of [
        ".beatmapset-panel__mapper",
        '[class*="beatmapset-panel__mapper"]',
        ".beatmapset-panel__info-row--mapper",
        '[class*="info-row--mapper"]',
      ]) {
        const el = card.querySelector(sel);
        if (el) {
          creator = el.textContent.trim();
          break;
        }
      }
      if (!creator) {
        for (const row of card.querySelectorAll(
          '.beatmapset-panel__info-row, [class*="info-row"]',
        )) {
          const clone = row.cloneNode(true);
          clone
            .querySelectorAll(
              '.beatmapset-badge, [class*="badge"], i, svg, ' +
                '[class*="stat"], [class*="count"], [class*="play"], [class*="fav"]',
            )
            .forEach((n) => n.remove());
          const txt = clone.textContent.trim();
          if (txt.startsWith("mapped by ")) {
            creator = txt.replace(/^mapped by\s+/, "").trim();
            break;
          }
        }
      }
      if (!creator) {
        const mapperLink = card.querySelector(
          'a[href*="/users/"], .beatmapset-panel__mapper a, [class*="mapper"] a',
        );
        if (mapperLink) creator = mapperLink.textContent.trim();
      }

      // source is not present in listing card DOM — leave blank rather than
      // accidentally capturing stats / date text from info-row nodes
      const source = "";

      // Extract cover URL — try multiple methods
      let coverUrl = "";

      // Method 1: computed style --bg custom property on cover element
      const coverEl = card.querySelector('[class*="beatmapset-cover"]');
      if (coverEl) {
        const cs = getComputedStyle(coverEl);
        let bg = cs.getPropertyValue("--bg") || "";
        if (!bg) bg = cs.backgroundImage || "";
        const m2 = bg.match(/url\("([^"]+)"\)/) || bg.match(/url\(([^)]+)\)/);
        if (m2) coverUrl = m2[1];
      }

      // Method 2: img inside cover
      if (!coverUrl) {
        const coverImg = card.querySelector(
          'img[src*="cover"], [class*="cover"] img, .beatmapset-cover img',
        );
        if (coverImg)
          coverUrl = coverImg.src || coverImg.getAttribute("data-src") || "";
      }

      // Method 3: any img in card that looks like a cover
      if (!coverUrl) {
        const imgs = card.querySelectorAll("img");
        for (const img of imgs) {
          const src = img.src || "";
          if (src.includes("cover") || src.includes("thumb")) {
            coverUrl = src;
            break;
          }
        }
        if (!coverUrl && imgs.length > 0) {
          // First image that's not an icon
          for (const img of imgs) {
            if (img.width > 40) {
              coverUrl = img.src;
              break;
            }
          }
        }
      }

      // Normalize URL
      if (coverUrl && !coverUrl.startsWith("http")) {
        if (coverUrl.startsWith("//")) coverUrl = "https:" + coverUrl;
        else if (coverUrl.startsWith("/"))
          coverUrl = "https://osu.ppy.sh" + coverUrl;
      }

      return {
        id,
        artist,
        artist_unicode: artist,
        title,
        title_unicode: title,
        creator,
        user_id: "",
        covers: { list: coverUrl, card: coverUrl, cover: coverUrl },
        status: "",
        favourite_count: 0,
        play_count: 0,
        bpm: 0,
        source,
        tags: "",
        genre: "",
        language: "",
        url: "https://osu.ppy.sh/beatmapsets/" + id,
        favourited_at: new Date().toISOString(),
        is_artist_featured: !!card.querySelector(".beatmapset-badge--featured_artist"),
        nsfw: !!card.querySelector(".beatmapset-badge--nsfw") || false,
        preview: "https://b.ppy.sh/preview/" + id + ".mp3",
      };
    } catch (e) {
      return null;
    }
  }

  function getBeatmapId() {
    const m = location.pathname.match(/\/beatmapsets\/(\d+)/);
    return m ? m[1] : null;
  }

  function resolveBeatmapContext(button) {
    const urlId = getBeatmapId();
    if (urlId) return { beatmapId: urlId, card: null, pageType: "detail" };

    // Primary: use closest() to find the nearest .beatmapset-panel card wrapper.
    // This avoids the bug where walking up parents and using querySelector on
    // a multi-card container would pick the first card's link instead of this one.
    const card = button.closest(".beatmapset-panel");
    if (card) {
      const link = card.querySelector('a[href*="/beatmapsets/"]');
      if (link) {
        const m = link.href.match(/\/beatmapsets\/(\d+)/);
        if (m) return { beatmapId: m[1], card: card, pageType: "listing" };
      }
    }

    // Fallback: walk up the DOM for cases where .beatmapset-panel doesn't exist
    let el = button.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const cls = (el.className || "").toString();
      if (cls.includes("beatmapset-panel__menu")) {
        el = el.parentElement;
        continue;
      }
      // Only check direct children to avoid cross-card contamination
      const dlink = el.querySelector(':scope > a[href*="/beatmapsets/"]');
      if (dlink) {
        const m = dlink.href.match(/\/beatmapsets\/(\d+)/);
        if (m) return { beatmapId: m[1], card: el, pageType: "listing" };
      }
      el = el.parentElement;
    }

    return { beatmapId: null, card: null, pageType: "unknown" };
  }

  // ═══ Favorite button detection ═══
  // Accepts BUTTON, A, and SPAN elements (the guest-disabled span on listing pages).
  function isFavButton(el) {
    if (el.id === "osu-local-guest-fav-btn") return false;
    const tag = el.tagName;
    const isInteractive = tag === "BUTTON" || tag === "A" || tag === "SPAN";
    if (!isInteractive) return false;

    const cls = (el.className || "").toString();
    const title = (
      el.getAttribute("title") ||
      el.getAttribute("data-orig-title") ||
      el.getAttribute("aria-label") ||
      ""
    ).toLowerCase();

    // Reject download buttons immediately — never treat them as fav buttons
    if (
      cls.includes("download") ||
      title.includes("download") ||
      el.querySelector(".fa-file-download, .fa-download, .fas.fa-file-download, .fas.fa-download")
    ) return false;

    // ── Fast path: the guest-disabled span osu! renders when not signed in ──
    // <span class="beatmapset-panel__menu-item beatmapset-panel__menu-item--disabled"
    //       data-orig-title="sign in to favourite this beatmap">
    //   <span class="far fa-heart"></span>
    // </span>
    if (
      cls.includes("beatmapset-panel__menu-item") &&
      (cls.includes("disabled") || cls.includes("avourite") || cls.includes("avorite"))
    ) return true;
    if (cls.includes("beatmapset-panel__menu-item") && el.querySelector(".fa-heart"))
      return true;

    // For SPANs that aren't the specific menu-item, require them to look like a fav button
    if (tag === "SPAN") {
      if (title.includes("avourite") || title.includes("avorite")) return true;
      // Only match spans that contain a heart icon and are inside a beatmap panel
      if (
        el.querySelector(".fa-heart, .fas.fa-heart, .far.fa-heart") &&
        el.closest(".beatmapset-panel")

      ) return true;
      return false;
    }

    // BUTTON / A checks below
    if (
      el.querySelector(
        ".fa-heart, .fas.fa-heart, .far.fa-heart, .fal.fa-heart, .fa-solid.fa-heart, .fa-regular.fa-heart",
      )
    )
      return true;

    const svg = el.querySelector("svg");
    if (svg) {
      const path = svg.querySelector("path");
      if (path) {
        const d = path.getAttribute("d") || "";
        const svgClass = (svg.getAttribute("class") || "").toLowerCase();
        if (
          d.startsWith("M") &&
          d.includes("C") &&
          d.length > 20 &&
          svgClass.includes("heart")
        )
          return true;
      }
    }

    // title is already declared at top of function — reuse it
    if (title.includes("avourite") || title.includes("avorite")) return true;


    const text = (el.textContent || "").toLowerCase().trim();
    if (text.includes("avourite") || text.includes("avorite")) return true;

    if (
      typeof cls === "string" &&
      (cls.includes("avourite") || cls.includes("avorite"))
    )
      return true;

    if (el.closest(".beatmapset-panel__menu-container")) {
      const iconEl = el.querySelector(
        'i, span[class*="icon"], span[class*="heart"]',
      );
      if (iconEl) {
        const ic = (iconEl.className || "").toLowerCase();
        if (ic.includes("heart") || ic.includes("fa-")) return true;
      }
      if (
        el.getAttribute("data-action") === "favourite" ||
        el.getAttribute("data-method") === "favourite"
      )
        return true;
      if (
        /[\u{2764}\u{1F493}-\u{1F49C}\u{1F5A4}\u{1F90D}\u{1F90E}\u{2661}\u{2665}]/u.test(
          el.textContent || "",
        )
      )
        return true;
    }
    return false;
  }

  // ═══ Visual helpers ═══
  function updateHeartVisual(el, isFav) {
    // Update FontAwesome heart solid/outline
    const heart = el.querySelector(".fa-heart");
    if (heart) {
      heart.classList.toggle("far", !isFav);
      heart.classList.toggle("fas", isFav);
    }
    // Also update the container span's disabled/active look
    const cls = (el.className || "").toString();
    if (cls.includes("beatmapset-panel__menu-item")) {
      el.classList.toggle("beatmapset-panel__menu-item--disabled", false);
      if (isFav) {
        el.style.color = "#ff3377";
        el.style.cursor = "pointer";
        el.removeAttribute("data-orig-title");
        el.title = "Remove from local favorites";
      } else {
        el.style.color = "";
        el.style.cursor = "pointer";
        el.title = "Add to local favorites";
      }
    }
  }

  // ═══ Toggle favorite ═══
  // ═══ Background enrichment ═══
  // Fetches the beatmapset detail page and merges full JSON data into storage.
  // Fire-and-forget — card data is stored instantly, this fills in the gaps.
  function enrichBeatmapData(beatmapId) {
    return fetch("https://osu.ppy.sh/beatmapsets/" + beatmapId, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.text() : null))
      .then((html) => {
        if (!html) return;
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const el = doc.getElementById("json-beatmapset");
        if (!el) return;
        let raw;
        try {
          raw = JSON.parse(el.textContent);
        } catch (e) {
          return;
        }
        const bm = raw.beatmapset || raw;
        if (!bm || !bm.id) return;
        const favs = getFavorites();
        const sid = String(bm.id);
        if (!favs[sid]) return; // Removed before enrichment finished — skip
        favs[sid] = {
          id: sid,
          artist: bm.artist || "",
          artist_unicode: bm.artist_unicode || bm.artist || "",
          title: bm.title || "",
          title_unicode: bm.title_unicode || bm.title || "",
          creator: bm.creator || "",
          user_id: String(bm.user_id || ""),
          covers: bm.covers || {},
          status: bm.status || "",
          favourite_count: bm.favourite_count || 0,
          play_count: bm.play_count || 0,
          bpm: bm.bpm || 0,
          source: bm.source || "",
          tags: bm.tags || "",
          genre: (bm.genre && bm.genre.name) || "",
          language: (bm.language && bm.language.name) || "",
          url: "https://osu.ppy.sh/beatmapsets/" + sid,
          favourited_at: favs[sid].favourited_at || new Date().toISOString(),
          is_artist_featured: !!bm.track_id,
          nsfw: bm.nsfw || false,
          preview: "https://b.ppy.sh/preview/" + sid + ".mp3",
        };
        setFavorites(favs);
      })
      .catch(() => {});
  }

  // Sequentially enriches a list of IDs with a delay between requests
  function enrichBeatmapsSequential(ids, delayMs) {
    let i = 0;
    function next() {
      if (i >= ids.length) return;
      enrichBeatmapData(ids[i++]).then(() => setTimeout(next, delayMs));
    }
    setTimeout(next, delayMs);
  }

  function toggleFavorite(beatmapId, card) {
    if (!beatmapId) return null;
    const favs = getFavorites();
    const wasFav = !!favs[beatmapId];
    let needsEnrich = false;

    if (wasFav) {
      delete favs[beatmapId];
    } else {
      const jsonData = getBeatmapDataFromJSON();
      if (jsonData) {
        favs[beatmapId] = jsonData;
      } else {
        needsEnrich = true;
        const data = (card ? getBeatmapDataFromCard(card) : null) || {
          id: beatmapId,
          url: "https://osu.ppy.sh/beatmapsets/" + beatmapId,
          favourited_at: new Date().toISOString(),
        };
        favs[beatmapId] = data;
      }
    }

    setFavorites(favs);
    updateFloatingHeart();
    if (needsEnrich) enrichBeatmapData(beatmapId);
    return !wasFav;
  }

  // ═══ Copy-all button ("Favourite Beatmaps" section) ═══
  function addCopyAllButton() {
    // Find the "Favourite Beatmaps" heading inside the Beatmaps section
    // Works on profile pages: /users/* (any user)
    const favHeading = document.querySelector(
      '.js-sortable--page[data-page-id="beatmaps"] h3.title--page-extra-small',
    );
    if (!favHeading) return;
    const ht = favHeading.textContent || "";
    if (!ht.includes("Favourite") && !ht.includes("Favorite")) return;
    // Guard: don't add the button twice
    if (favHeading.querySelector(".osu-fav-all-btn")) return;

    const btn = document.createElement("button");
    btn.className = "osu-fav-all-btn";
    btn.textContent = "Favorite all";
    Object.assign(btn.style, {
      marginLeft: "10px",
      padding: "2px 10px",
      fontSize: "11px",
      background: "#ff66aa",
      color: "#fff",
      border: "none",
      borderRadius: "3px",
      cursor: "pointer",
      fontWeight: "600",
      transform: "scale(1)",
      transition: "transform 0.1s",
    });

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.textContent = "Loading all...";
      btn.disabled = true;

      // The grid that holds beatmap panels in the Favourite Beatmaps section
      const grid = document.querySelector(
        '.js-sortable--page[data-page-id="beatmaps"] .page-extra__beatmapsets.js-audio--group',
      );

      // Click "show more" once and wait for new cards to appear
      function clickShowMoreOnce() {
        return new Promise((resolve) => {
          const showMore = document.querySelector(
            ".show-more-link--profile-page-beatmapsets",
          );
          if (
            !showMore ||
            showMore.offsetParent === null ||
            showMore.disabled
          ) {
            resolve();
            return;
          }
          const before = grid
            ? grid.querySelectorAll(".beatmapset-panel").length
            : 0;
          showMore.click();

          let attempts = 0;
          function check() {
            attempts++;
            const after = grid
              ? grid.querySelectorAll(".beatmapset-panel").length
              : 0;
            const sm = document.querySelector(
              ".show-more-link--profile-page-beatmapsets",
            );
            if (
              after > before ||
              !sm ||
              sm.offsetParent === null ||
              attempts > 30
            ) {
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
        return clickShowMoreOnce().then(() => {
          const sm = document.querySelector(
            ".show-more-link--profile-page-beatmapsets",
          );
          if (sm && sm.offsetParent !== null && !sm.disabled) {
            return loadAllBeatmaps();
          }
        });
      }

      loadAllBeatmaps()
        .then(() => {
          const favs = getFavorites();
          if (!grid) return;
          const cards = grid.querySelectorAll(
            ".beatmapset-panel, .beatmapsets__item",
          );
          // Use a decreasing base timestamp so top-to-bottom DOM order is preserved
          // (panel sorts by favourited_at descending)
          const baseTime = Date.now();
          let count = 0;
          const newIds = [];
          cards.forEach((card, i) => {
            const data = getBeatmapDataFromCard(card);
            if (data && !favs[data.id]) {
              // Subtract i seconds so first card (top) gets newest timestamp
              data.favourited_at = new Date(baseTime - i * 1000).toISOString();
              favs[data.id] = data;
              newIds.push(data.id);
              count++;
            }
          });

          setFavorites(favs);
          updateFloatingHeart();
          // Refresh the favorites panel if it's already open
          if (document.getElementById("osu-local-fav-panel")) {
            document.getElementById("osu-local-fav-panel").remove();
            showFavoritesPanel();
          }
          btn.textContent = "Added " + count + ", enriching...";
          // Enrich each card with full page data sequentially (1000ms between requests to respect the 60 requests/min limit)
          enrichBeatmapsSequential(newIds, 1000);
          setTimeout(() => {
            btn.textContent = "Favorite all";
            btn.disabled = false;
          }, 2000);
        })
        .catch(() => {
          btn.textContent = "Error";
          setTimeout(() => {
            btn.textContent = "Favorite all";
            btn.disabled = false;
          }, 2000);
        });
    });

    // Append button inside the heading element
    favHeading.appendChild(btn);
  }

  // ═══ Floating heart — always visible on all osu! pages ═══
  function ensureHeartIndicator() {
    if (document.getElementById("osu-local-fav-ind")) return;

    const ind = document.createElement("div");
    ind.id = "osu-local-fav-ind";
    Object.assign(ind.style, {
      position: "fixed",
      bottom: "40px",
      right: "100px",
      zIndex: "99999",
      width: "50px",
      height: "50px",
      borderRadius: "50%",
      background: "rgba(22,33,62,0.95)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      fontSize: "26px",
      lineHeight: "1",
      transition: "all 0.15s ease",
      userSelect: "none",
    });

    const update = () => {
      const bmid = getBeatmapId();
      const fav = bmid ? isFavorited(bmid) : false;
      ind.textContent = fav ? "❤️" : "🤍";
      ind.style.border = fav ? "2px solid #ff3377" : "2px solid #ff66aa";
      ind.style.boxShadow = fav
        ? "0 2px 20px rgba(255,51,119,0.6)"
        : "0 2px 16px rgba(255,102,170,0.3)";
      // Clicking heart always opens favorites panel
      ind.title = "View local favorites";
    };

    ind.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showFavoritesPanel();
    });

    document.body.appendChild(ind);
    update();
  }

  function updateGuestButtonVisual() {
    const btn = document.getElementById("osu-local-guest-fav-btn");
    if (!btn) return;
    const bmid = getBeatmapId();
    if (!bmid) return;
    const fav = isFavorited(bmid);
    const heart = btn.querySelector(".fa-heart");
    if (heart) {
      heart.classList.toggle("far", !fav);
      heart.classList.toggle("fas", fav);
    }
    btn.setAttribute(
      "data-orig-title",
      fav ? "remove from local favorites" : "save to local favorites"
    );
  }

  function updateFloatingHeart() {
    const ind = document.getElementById("osu-local-fav-ind");
    if (!ind) return;
    const bmid = getBeatmapId();
    const fav = bmid ? isFavorited(bmid) : false;
    ind.textContent = fav ? "❤️" : "🤍";
    ind.style.border = fav ? "2px solid #ff3377" : "2px solid #ff66aa";
    ind.style.boxShadow = fav
      ? "0 2px 20px rgba(255,51,119,0.6)"
      : "0 2px 16px rgba(255,102,170,0.3)";
    updateGuestButtonVisual();
  }

  // ═══ Click interception ═══
  document.addEventListener(
    "click",
    function (e) {
      // Also intercept clicks on the guest-disabled <span> (not just button/a)
      const button = e.target.closest("button, a, span.beatmapset-panel__menu-item");
      if (!button || !isFavButton(button)) return;

      const ctx = resolveBeatmapContext(button);
      if (!ctx.beatmapId) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const nowFav = toggleFavorite(ctx.beatmapId, ctx.card);
      updateHeartVisual(button, nowFav);

      button.style.transform = "scale(1.2)";
      button.style.transition = "transform 0.1s ease";
      setTimeout(() => {
        button.style.transform = "scale(1)";
      }, 120);
    },
    true,
  );

  // ═══ Refresh visible buttons ═══
  function refreshButtons() {
    // Also scan disabled <span> elements used when the user is not signed in
    const candidates = document.querySelectorAll(
      "button, span.beatmapset-panel__menu-item",
    );
    candidates.forEach((btn) => {
      if (!isFavButton(btn) || btn.dataset.osuFavChecked) return;
      btn.dataset.osuFavChecked = "1";
      const ctx = resolveBeatmapContext(btn);
      if (ctx.beatmapId) {
        updateHeartVisual(btn, isFavorited(ctx.beatmapId));
        // Make the disabled span look clickable
        if (btn.tagName === "SPAN") {
          btn.style.cursor = "pointer";
          btn.style.opacity = "1";
          btn.style.pointerEvents = "auto";
        }
      }
    });
  }

  // ═══ Favorites panel ═══
  function showFavoritesPanel() {
    const existing = document.getElementById("osu-local-fav-panel");
    if (existing) {
      existing.remove();
      return;
    }

    let currentSort = "date",
      sortAsc = false,
      searchQuery = "";

    // Inject scrollbar style once
    if (!document.getElementById("osu-fav-panel-style")) {
      const s = document.createElement("style");
      s.id = "osu-fav-panel-style";
      s.textContent =
        "#osu-fav-list::-webkit-scrollbar{width:4px}#osu-fav-list::-webkit-scrollbar-thumb{background:#333;border-radius:2px}#osu-fav-list::-webkit-scrollbar-thumb:hover{background:#ff66aa}" +
        "@keyframes osuFavSlideDown{from{max-height:0;opacity:0;overflow:hidden}to{max-height:50px;opacity:1}}";
      document.head.appendChild(s);
    }

    const panel = document.createElement("div");
    panel.id = "osu-local-fav-panel";
    Object.assign(panel.style, {
      position: "fixed",
      top: "0",
      right: "0",
      zIndex: "100000",
      width: "360px",
      height: "100vh",
      background: "#111",
      color: "#ddd",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: "13px",
      borderLeft: "1px solid #333",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      boxShadow: "-2px 0 16px rgba(0,0,0,.5)",
    });

    const bannerContainer = document.createElement("div");
    bannerContainer.id = "osu-fav-banner-container";

    function displayUpdateBanner(latestVersion) {
      if (document.getElementById("osu-fav-update-banner")) return;
      const dismissed = GM_getValue("osu_dismissed_version", "");
      if (dismissed === latestVersion) return;

      const banner = document.createElement("div");
      banner.id = "osu-fav-update-banner";
      banner.style.cssText =
        "background:linear-gradient(135deg,#ff66aa,#ff3377);color:#fff;padding:8px 14px;display:flex;align-items:center;justify-content:space-between;font-weight:500;font-size:11px;gap:8px;animation:osuFavSlideDown 0.3s ease-out;border-bottom:1px solid rgba(0,0,0,0.15);flex-shrink:0";

      const textSpan = document.createElement("span");
      textSpan.style.cssText = "flex:1";
      textSpan.innerHTML = `✨ New version <b>v${latestVersion}</b> is available!`;

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px;align-items:center";

      const updateBtn = document.createElement("button");
      updateBtn.textContent = "Update";
      updateBtn.style.cssText =
        "background:#fff;color:#ff3377;border:none;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;transition:background 0.2s";
      updateBtn.addEventListener("mouseenter", () => (updateBtn.style.background = "#fff0f5"));
      updateBtn.addEventListener("mouseleave", () => (updateBtn.style.background = "#fff"));
      updateBtn.addEventListener("click", () => {
        window.open(
          "https://github.com/vyroxat/Local-osu-Favorites/raw/main/osu-local-favorites.user.js",
          "_blank",
        );
      });

      const dismissBtn = document.createElement("button");
      dismissBtn.textContent = "✕";
      dismissBtn.title = "Dismiss";
      dismissBtn.style.cssText =
        "background:none;border:none;color:#fff;cursor:pointer;font-size:12px;opacity:0.8;font-weight:bold;padding:0 2px";
      dismissBtn.addEventListener("mouseenter", () => (dismissBtn.style.opacity = "1"));
      dismissBtn.addEventListener("mouseleave", () => (dismissBtn.style.opacity = "0.8"));
      dismissBtn.addEventListener("click", () => {
        banner.remove();
        GM_setValue("osu_dismissed_version", latestVersion);
      });

      actions.append(updateBtn, dismissBtn);
      banner.append(textSpan, actions);
      bannerContainer.appendChild(banner);
    }

    // ── Header ─────────────────────────────────────────────
    const header = document.createElement("div");
    Object.assign(header.style, {
      padding: "10px 14px 8px",
      background: "#1a1a1a",
      borderBottom: "2px solid #ff66aa",
      flexShrink: "0",
    });

    const headerTop = document.createElement("div");
    headerTop.style.cssText =
      "display:flex;align-items:center;gap:8px;margin-bottom:8px";

    const logoImg = document.createElement("img");
    logoImg.src = "https://raw.githubusercontent.com/vyroxat/Local-osu-Favorites/main/icons/icon48.png";
    logoImg.style.cssText = "width:28px;height:28px;border-radius:50%;flex-shrink:0";
    logoImg.addEventListener("error", () => logoImg.style.display = "none");

    const titleEl = document.createElement("span");
    titleEl.style.cssText = "font-weight:600;font-size:14px;flex:1";
    const countBadge = document.createElement("span");
    countBadge.id = "osu-fav-count";
    countBadge.style.cssText =
      "color:#ff66aa;background:rgba(255,102,170,.12);padding:2px 8px;border-radius:10px;font-size:11px;margin-left:6px";
    titleEl.append("Local Favorites", countBadge);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕ Close";
    closeBtn.style.cssText =
      "background:none;border:1px solid #333;color:#999;cursor:pointer;padding:2px 8px;border-radius:3px;font-size:12px;flex-shrink:0";
    closeBtn.addEventListener("click", () => panel.remove());

    headerTop.append(logoImg, titleEl, closeBtn);

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search title, artist, mapper...";
    searchInput.style.cssText =
      "width:100%;padding:6px 10px;background:#111;border:1px solid #333;border-radius:3px;color:#ddd;font-size:12px;outline:none";
    searchInput.addEventListener(
      "focus",
      () => (searchInput.style.borderColor = "#ff66aa"),
    );
    searchInput.addEventListener(
      "blur",
      () => (searchInput.style.borderColor = "#333"),
    );
    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value;
      renderList();
    });

    header.appendChild(headerTop);
    header.appendChild(searchInput);

    // ── Toolbar ────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.style.cssText =
      "display:flex;align-items:center;gap:4px;padding:5px 14px;background:#1a1a1a;border-bottom:1px solid #333;flex-shrink:0";

    const sortGroup = document.createElement("div");
    sortGroup.style.cssText = "display:flex;gap:2px;flex:1";

    const SORTS = ["date", "title", "artist", "status"];
    const sortBtns = {};
    SORTS.forEach((s) => {
      const btn = document.createElement("button");
      btn.dataset.sort = s;
      btn.style.cssText =
        "font-size:10px;font-weight:500;padding:3px 7px;border:1px solid transparent;border-radius:3px;background:transparent;cursor:pointer;user-select:none;color:#666";
      btn.addEventListener("click", () => {
        if (currentSort === s) sortAsc = !sortAsc;
        else {
          currentSort = s;
          sortAsc = false;
        }
        updateSortBtns();
        renderList();
      });
      sortGroup.appendChild(btn);
      sortBtns[s] = btn;
    });

    function updateSortBtns() {
      SORTS.forEach((s) => {
        const btn = sortBtns[s];
        const label = s[0].toUpperCase() + s.slice(1);
        btn.textContent =
          label + (currentSort === s ? (sortAsc ? " ↑" : " ↓") : "");
        btn.style.background = currentSort === s ? "#ff66aa" : "transparent";
        btn.style.color = currentSort === s ? "#fff" : "#666";
        btn.style.borderColor = currentSort === s ? "#ff66aa" : "transparent";
      });
    }

    function makeBtn(label, extraStyle = "") {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = `font-size:10px;padding:3px 7px;border:1px solid #333;border-radius:3px;background:transparent;color:#999;cursor:pointer;${extraStyle}`;
      btn.addEventListener("mouseenter", () => {
        btn.style.borderColor = "#ff66aa";
        btn.style.color = "#ff66aa";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.borderColor = "#333";
        btn.style.color = "#999";
      });
      return btn;
    }

    const exportBtn = makeBtn("Export");
    const importBtn = makeBtn("Import");
    const importFile = document.createElement("input");
    importFile.type = "file";
    importFile.accept = ".json";
    importFile.style.display = "none";

    const actionsGroup = document.createElement("div");
    actionsGroup.style.cssText = "display:flex;gap:3px;flex-shrink:0";
    actionsGroup.append(exportBtn, importBtn, importFile);

    toolbar.appendChild(sortGroup);
    toolbar.appendChild(actionsGroup);

    // ── List ───────────────────────────────────────────────
    const listEl = document.createElement("div");
    listEl.id = "osu-fav-list";
    Object.assign(listEl.style, {
      flex: "1",
      overflowY: "auto",
      padding: "4px 0",
    });

    // ── Footer ─────────────────────────────────────────────
    const footer = document.createElement("div");
    footer.style.cssText =
      "padding:8px 14px;border-top:1px solid #333;background:#1a1a1a;flex-shrink:0";

    const removeAllBtn = document.createElement("button");
    removeAllBtn.textContent = "Remove all";
    removeAllBtn.style.cssText =
      "font-size:10px;padding:4px 10px;border:1px solid #555;border-radius:3px;background:none;color:#888;cursor:pointer;width:100%";
    footer.appendChild(removeAllBtn);

    // ── Helpers ────────────────────────────────────────────
    function statusColor(s) {
      return (
        {
          ranked:    "#4caf50",
          loved:     "#ff66aa",
          qualified: "#4fc3f7",
          approved:  "#4caf50",
          pending:   "#ff9800",
          wip:       "#f44336",
          graveyard: "#666",
          vip:       "#f6c243",
        }[s] || "#888"
      );
    }
    function formatDate(iso) {
      if (!iso) return "";
      const d = new Date(iso),
        diff = Date.now() - d;
      if (diff < 60000) return "just now";
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
      return d.toLocaleDateString();
    }
    function showToast(msg) {
      showOsuFavToast(msg, "380px");
    }

    // ── Render list ────────────────────────────────────────
    function renderList() {
      const favs = getFavorites();
      let entries = Object.entries(favs);

      // Update count badge
      const cBadge = panel.querySelector("#osu-fav-count");
      if (cBadge) cBadge.textContent = Object.keys(favs).length;

      // Filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        entries = entries.filter(
          ([, f]) =>
            (f.title || "").toLowerCase().includes(q) ||
            (f.artist || "").toLowerCase().includes(q) ||
            (f.creator || "").toLowerCase().includes(q) ||
            (f.tags || "").toLowerCase().includes(q) ||
            (f.source || "").toLowerCase().includes(q) ||
            (f.id || "").includes(q),
        );
      }

      // Sort
      entries.sort(([idA, a], [idB, b]) => {
        let cmp = 0;
        if (currentSort === "date")
          cmp = (a.favourited_at || "").localeCompare(b.favourited_at || "");
        if (currentSort === "title")
          cmp = (a.title || "").localeCompare(b.title || "");
        if (currentSort === "artist")
          cmp = (a.artist || "").localeCompare(b.artist || "");
        if (currentSort === "status")
          cmp = (a.status || "").localeCompare(b.status || "");
        if (cmp === 0) cmp = idB.localeCompare(idA);
        return sortAsc ? cmp : -cmp;
      });

      listEl.innerHTML = "";

      if (Object.keys(favs).length === 0) {
        listEl.innerHTML =
          '<p style="text-align:center;color:#666;padding:40px 20px;font-size:12px">No favorites yet.</p>';
        return;
      }
      if (entries.length === 0) {
        listEl.innerHTML =
          '<p style="text-align:center;color:#666;padding:40px 20px;font-size:12px">No matches.</p>';
        return;
      }

      const frag = document.createDocumentFragment();

      entries.forEach(([id, f]) => {
        const card = document.createElement("div");
        card.style.cssText =
          "display:flex;gap:8px;padding:8px 14px;border-bottom:1px solid #1e1e1e;align-items:center";
        card.addEventListener(
          "mouseenter",
          () => (card.style.background = "#1a1a1a"),
        );
        card.addEventListener("mouseleave", () => (card.style.background = ""));

        // Cover
        const coverUrl =
          (f.covers || {}).card ||
          (f.covers || {})["card@2x"] ||
          (f.covers || {}).list ||
          (f.covers || {}).cover ||
          "";
        const coverEl = document.createElement("div");
        coverEl.style.cssText =
          "width:56px;height:42px;border-radius:2px;overflow:hidden;flex-shrink:0;background:#1a1a1a;display:flex;align-items:center;justify-content:center";
        if (coverUrl) {
          const img = document.createElement("img");
          img.src = coverUrl;
          img.loading = "lazy";
          img.style.cssText = "width:100%;height:100%;object-fit:cover";
          img.addEventListener("error", () => {
            img.remove();
            coverEl.style.fontSize = "16px";
            coverEl.style.color = "#444";
            coverEl.textContent = "?";
          });
          coverEl.appendChild(img);
        } else {
          coverEl.style.cssText += ";font-size:16px;color:#444";
          coverEl.textContent = "?";
        }

        // Info
        const info = document.createElement("div");
        info.style.cssText = "flex:1;min-width:0";

        const titleDiv = document.createElement("div");
        titleDiv.style.cssText =
          "font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3";
        titleDiv.textContent = f.title || f.title_unicode || "Unknown";
        if (f.nsfw) {
          const badge = document.createElement("span");
          badge.textContent = "EXPLICIT";
          badge.style.cssText =
            "font-size:7px;color:#f6c243;border:1px solid #f6c243;border-radius:2px;padding:0 3px;margin-left:4px;vertical-align:middle;font-weight:600";
          titleDiv.appendChild(badge);
        }
        const artistDiv = document.createElement("div");
        artistDiv.style.cssText =
          "font-size:10px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;display:flex;align-items:center;gap:4px";
        const artistText = document.createElement("span");
        artistText.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        artistText.textContent = f.artist || f.artist_unicode || "";
        artistDiv.appendChild(artistText);
        if (f.is_artist_featured) {
          const faBadge = document.createElement("span");
          faBadge.textContent = "FEATURED ARTIST";
          faBadge.style.cssText =
            "font-size:7px;color:#66ccff;border:1px solid #66ccff;border-radius:2px;padding:0 3px;vertical-align:middle;font-weight:600;flex-shrink:0";
          artistDiv.appendChild(faBadge);
        }

        const metaDiv = document.createElement("div");
        metaDiv.style.cssText =
          "display:flex;gap:5px;align-items:center;margin-top:2px";

        if (f.creator) {
          const m = document.createElement("span");
          m.style.cssText =
            "font-size:10px;color:#ff66aa;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px";
          m.textContent = f.creator;
          metaDiv.appendChild(m);
        }
        if (f.status) {
          const st = document.createElement("span");
          st.textContent = f.status.toUpperCase();
          st.style.cssText = `font-size:8px;font-weight:700;letter-spacing:.3px;color:${statusColor(f.status)}`;
          metaDiv.appendChild(st);
        }
        if (f.bpm) {
          const bpm = document.createElement("span");
          bpm.style.cssText = "font-size:9px;color:#555";
          bpm.textContent = `${f.bpm} BPM`;
          metaDiv.appendChild(bpm);
        }

        const dateDiv = document.createElement("div");
        dateDiv.style.cssText = "font-size:9px;color:#555;margin-top:1px";
        dateDiv.textContent = formatDate(f.favourited_at);

        // Progress bar (shown during playback)
        const progressWrap = document.createElement("div");
        progressWrap.style.cssText = "height:2px;background:#333;border-radius:1px;margin-top:3px;overflow:hidden;display:none";
        const progressBar = document.createElement("div");
        progressBar.style.cssText = "height:100%;width:0%;background:#ff66aa;border-radius:1px";
        progressWrap.appendChild(progressBar);

        info.append(titleDiv, artistDiv, metaDiv, dateDiv, progressWrap);

        // Actions
        const actions = document.createElement("div");
        actions.style.cssText =
          "display:flex;flex-direction:column;gap:2px;flex-shrink:0";

        const openLink = document.createElement("a");
        openLink.href = f.url || `https://osu.ppy.sh/beatmapsets/${id}`;
        openLink.target = "_blank";
        openLink.textContent = "Open";
        openLink.style.cssText =
          "font-size:9px;padding:2px 6px;border:1px solid #333;border-radius:2px;color:#999;text-decoration:none;text-align:center;display:block";
        openLink.addEventListener("mouseenter", () => {
          openLink.style.borderColor = "#ff66aa";
          openLink.style.color = "#ff66aa";
        });
        openLink.addEventListener("mouseleave", () => {
          openLink.style.borderColor = "#333";
          openLink.style.color = "#999";
        });

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "Remove";
        removeBtn.style.cssText =
          "font-size:9px;padding:2px 6px;border:1px solid #333;border-radius:2px;background:none;color:#999;cursor:pointer";
        removeBtn.addEventListener("mouseenter", () => {
          removeBtn.style.borderColor = "#e55";
          removeBtn.style.color = "#e55";
        });
        removeBtn.addEventListener("mouseleave", () => {
          removeBtn.style.borderColor = "#333";
          removeBtn.style.color = "#999";
        });
        removeBtn.addEventListener("click", () => {
          const favs = getFavorites();
          delete favs[id];
          setFavorites(favs);
          updateFloatingHeart();
          renderList();
        });

        // Preview button — singleton audio, only one plays at a time
        if (!window._osuFavAudio) {
          window._osuFavAudio = new Audio();
          window._osuFavAudio._activeBtn = null;
          window._osuFavAudio._activeBar = null;
          window._osuFavAudio.addEventListener("ended", () => {
            if (window._osuFavAudio._activeBtn) {
              window._osuFavAudio._activeBtn.textContent = "\u25b6";
              window._osuFavAudio._activeBtn.style.borderColor = "#333";
              window._osuFavAudio._activeBtn.style.color = "#999";
            }
            if (window._osuFavAudio._activeBar) {
              window._osuFavAudio._activeBar.parentElement.style.display = "none";
              window._osuFavAudio._activeBar.style.width = "0%";
            }
            window._osuFavAudio._activeBtn = null;
            window._osuFavAudio._activeBar = null;
          });
          window._osuFavAudio.addEventListener("timeupdate", () => {
            if (window._osuFavAudio._activeBar && window._osuFavAudio.duration) {
              const pct = (window._osuFavAudio.currentTime / window._osuFavAudio.duration) * 100;
              window._osuFavAudio._activeBar.style.width = pct + "%";
            }
          });
        }

        const previewUrl = f.preview || `https://b.ppy.sh/preview/${id}.mp3`;
        const previewBtn = document.createElement("button");
        previewBtn.textContent = "\u25b6";
        previewBtn.title = "Preview audio";
        previewBtn.style.cssText =
          "font-size:11px;padding:2px 6px;border:1px solid #333;border-radius:2px;background:none;color:#999;cursor:pointer;text-align:center;line-height:1";
        previewBtn.addEventListener("mouseenter", () => {
          if (!previewBtn._playing) { previewBtn.style.borderColor = "#ff66aa"; previewBtn.style.color = "#ff66aa"; }
        });
        previewBtn.addEventListener("mouseleave", () => {
          if (!previewBtn._playing) { previewBtn.style.borderColor = "#333"; previewBtn.style.color = "#999"; }
        });
        previewBtn.addEventListener("click", () => {
          const audio = window._osuFavAudio;
          const isSame = audio.src === previewUrl || audio.src.replace("https://", "") === previewUrl.replace("https://", "");
          if (isSame) {
            if (!audio.paused) {
              audio.pause();
              previewBtn.textContent = "\u25b6";
              previewBtn.style.borderColor = "#333";
              previewBtn.style.color = "#999";
              previewBtn._playing = false;
            } else {
              audio.play();
              previewBtn.textContent = "\u23f8";
              previewBtn.style.borderColor = "#ff66aa";
              previewBtn.style.color = "#ff66aa";
              previewBtn._playing = true;
            }
            return;
          }
          // Stop previous
          if (audio._activeBtn) {
            audio._activeBtn.textContent = "\u25b6";
            audio._activeBtn.style.borderColor = "#333";
            audio._activeBtn.style.color = "#999";
            audio._activeBtn._playing = false;
          }
          if (audio._activeBar) {
            audio._activeBar.parentElement.style.display = "none";
            audio._activeBar.style.width = "0%";
          }
          audio.pause();
          // Start new
          audio.src = previewUrl;
          audio._activeBtn = previewBtn;
          audio._activeBar = progressBar;
          progressWrap.style.display = "block";
          previewBtn.textContent = "\u23f8";
          previewBtn.style.borderColor = "#ff66aa";
          previewBtn.style.color = "#ff66aa";
          previewBtn._playing = true;
          audio.play().catch(() => {
            previewBtn.textContent = "\u25b6";
            previewBtn.style.borderColor = "#333";
            previewBtn.style.color = "#999";
            previewBtn._playing = false;
          });
        });

        actions.append(openLink, previewBtn, removeBtn);
        card.append(coverEl, info, actions);
        frag.appendChild(card);
      });

      listEl.appendChild(frag);
    }

    // ── Assemble & wire events ─────────────────────────────
    panel.append(header, bannerContainer, toolbar, listEl, footer);
    document.body.appendChild(panel);
    updateSortBtns();
    renderList();

    // Check cached latest version and display if newer
    const cachedLatest = GM_getValue("osu_latest_version", null);
    const currentVersion = typeof GM_info !== "undefined" ? GM_info.script.version : "3.6.1";
    if (cachedLatest && isNewerVersion(currentVersion, cachedLatest)) {
      displayUpdateBanner(cachedLatest);
    }

    // Trigger update check in background (throttled to 24h)
    checkVersionUpdate().then((latestVersion) => {
      if (latestVersion && isNewerVersion(currentVersion, latestVersion)) {
        displayUpdateBanner(latestVersion);
      }
    });

    exportBtn.addEventListener("click", () => {
      const data = JSON.stringify(getFavorites(), null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `osu-favorites-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast("Exported!");
    });

    importBtn.addEventListener("click", () => importFile.click());

    importFile.addEventListener("change", async (e) => {
      if (!e.target.files[0]) return;
      try {
        const text = await e.target.files[0].text();
        const data = JSON.parse(text);
        if (typeof data !== "object" || Array.isArray(data))
          throw new Error("Expected JSON object");
        const existing = getFavorites();
        let added = 0;
        for (const [id, fav] of Object.entries(data)) {
          if (!existing[id]) {
            existing[id] = fav;
            added++;
          }
        }
        setFavorites(existing);
        updateFloatingHeart();
        renderList();
        showToast(`Added ${added}. Total: ${Object.keys(existing).length}`);
      } catch (err) {
        showToast("Import failed: " + err.message);
      }
      e.target.value = "";
    });

    // Two-click confirm for remove all
    let confirming = false;
    removeAllBtn.addEventListener("click", () => {
      if (!confirming) {
        confirming = true;
        removeAllBtn.textContent = "You sure?";
        removeAllBtn.style.cssText =
          "font-size:10px;padding:4px 10px;border:1px solid #ff4444;border-radius:3px;background:#ff4444;color:#fff;cursor:pointer;width:100%;font-weight:600";
        setTimeout(() => {
          if (confirming) {
            confirming = false;
            removeAllBtn.textContent = "Remove all";
            removeAllBtn.style.cssText =
              "font-size:10px;padding:4px 10px;border:1px solid #555;border-radius:3px;background:none;color:#888;cursor:pointer;width:100%";
          }
        }, 3000);
      } else {
        setFavorites({});
        updateFloatingHeart();
        panel.remove();
      }
    });
  }

  // ═══ Menu commands ═══
  GM_registerMenuCommand("View Local Favorites", showFavoritesPanel);
  GM_registerMenuCommand("Check for Updates", () => {
    showOsuFavToast("Checking for updates...");
    checkVersionUpdate(true).then((latestVersion) => {
      const currentVersion = typeof GM_info !== "undefined" ? GM_info.script.version : "3.6.1";
      if (latestVersion && isNewerVersion(currentVersion, latestVersion)) {
        const panel = document.getElementById("osu-local-fav-panel");
        if (!panel) {
          showFavoritesPanel();
        } else {
          panel.remove();
          showFavoritesPanel();
        }
        showOsuFavToast(`New version v${latestVersion} is available!`);
        window.open(
          "https://github.com/vyroxat/Local-osu-Favorites/raw/main/osu-local-favorites.user.js",
          "_blank",
        );
      } else {
        showOsuFavToast(`You are up to date! (v${currentVersion})`);
      }
    });
  });

  // ═══ Guest-mode fallback button ═══
  // On beatmapset detail pages (/beatmapsets/12345), no heart button exists when
  // not signed in. We inject a standalone button into the page header area.
  function addGuestFavoriteButton() {
    const path = location.pathname;
    // Only on beatmapset detail pages (not the listing /beatmapsets)
    if (!path.match(/^\/beatmapsets\/\d+/)) return;
    // Don't inject if already present
    if (document.getElementById("osu-local-guest-fav-btn")) return;

    const bmid = getBeatmapId();
    if (!bmid) return;

    // If the native osu! favourite button already exists on the page (user is logged in),
    // we don't need to inject our guest fallback — our click interceptor handles the native button.
    if (
      document.querySelector(".btn-osu-big--beatmapset-header-square-favourite") ||
      document.querySelector("button[data-orig-title='favourite this beatmap']") ||
      document.querySelector("button[title='favourite this beatmap']")
    ) return;

    // Try multiple anchor points in order of preference.
    // Prefer the header buttons row (.beatmapset-header__buttons) so our button sits alongside
    // the native download buttons. Fall back progressively for older/different page layouts.
    const anchor =
      document.querySelector(".beatmapset-header__buttons") ||
      document.querySelector(".beatmapset-header__actions") ||
      document.querySelector("[class*='beatmapset-header__actions']") ||
      document.querySelector(".beatmapset__header .beatmapset-header__details") ||
      document.querySelector(".beatmapset__header") ||
      document.querySelector(".beatmapset-info") ||
      null;

    if (!anchor) return;

    const fav = isFavorited(bmid);

    // Build the button using the exact same class and inner-HTML structure as osu!'s
    // native favourite button — so it sits flush with the download buttons and uses
    // the page's own CSS for sizing, colours, and hover effects.
    const btn = document.createElement("button");
    btn.id = "osu-local-guest-fav-btn";
    btn.type = "button";
    btn.className =
      "btn-osu-big btn-osu-big--beatmapset-header-square " +
      "btn-osu-big--beatmapset-header-square-favourite";
    btn.setAttribute(
      "data-orig-title",
      fav ? "remove from local favorites" : "save to local favorites"
    );
    // Inner HTML mirrors the native button exactly:
    // <span.btn-osu-big__content> > <span.btn-osu-big__icon> > <span.fa.fa-fw> > <span.{far|fas}.fa-heart>
    btn.innerHTML =
      '<span class="btn-osu-big__content btn-osu-big__content--center">' +
        '<span class="btn-osu-big__icon">' +
          '<span class="fa fa-fw">' +
            '<span class="' + (fav ? "fas" : "far") + ' fa-heart"></span>' +
          '</span>' +
        '</span>' +
      '</span>';

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nowFav = toggleFavorite(bmid, null);
      // Mirror the native button's animation
      btn.style.transform = "scale(1.15)";
      btn.style.transition = "transform 0.1s";
      setTimeout(() => { btn.style.transform = "scale(1)"; }, 120);
      // Toggle the heart icon class
      const heart = btn.querySelector(".fa-heart");
      if (heart) {
        heart.classList.toggle("far", !nowFav);
        heart.classList.toggle("fas", nowFav);
      }
      btn.setAttribute(
        "data-orig-title",
        nowFav ? "remove from local favorites" : "save to local favorites"
      );
    });

    // Prepend so it appears before the download buttons, matching logged-in position
    anchor.insertBefore(btn, anchor.firstChild);
  }

  // ═══ Enable download buttons for guest/logged-out users ═══
  // Based on exact DOM structure observed via Kimi WebBridge in logged-in Helium session:
  //
  // Logged-in listing/user panel download item:
  //   <a class="beatmapset-panel__menu-item" href="…/download"
  //      data-orig-title="download with video"><span class="fas fa-file-download"></span></a>
  //   (user pages use title= instead of data-orig-title=, but same shape)
  //
  // Logged-in detail page:
  //   <a class="btn-osu-big btn-osu-big--beatmapset-header" href="…/download">…Download with Video…</a>
  //   <a class="btn-osu-big btn-osu-big--beatmapset-header" href="…/download?noVideo=1">…without Video…</a>
  function enableGuestDownloads() {
    // ── 1. Beatmap panel cards (listing + user pages) ────────────────────────
    // Replace disabled <span class="beatmapset-panel__menu-item"> download spans
    // with real <a> links that match the logged-in element exactly.
    document.querySelectorAll("span.beatmapset-panel__menu-item").forEach((span) => {
      // Already converted — skip
      if (span.dataset.osuDlFixed) return;

      const hasDownloadIcon = span.querySelector(".fa-file-download, .fa-download");
      const titleAttr = (
        span.getAttribute("data-orig-title") ||
        span.getAttribute("title") ||
        ""
      ).toLowerCase();

      const isDisabledDownload =
        hasDownloadIcon ||
        titleAttr.includes("download") ||
        titleAttr.includes("sign in before downloading");

      if (!isDisabledDownload) return;

      const ctx = resolveBeatmapContext(span);
      if (!ctx.beatmapId) {
        // Mark so we don't keep retrying on elements where context lookup failed
        span.dataset.osuDlFixed = "pending";
        return;
      }

      const a = document.createElement("a");
      a.className = "beatmapset-panel__menu-item";
      a.href = `https://osu.ppy.sh/beatmapsets/${ctx.beatmapId}/download`;
      // Match logged-in: listing pages use data-orig-title, user pages use title
      a.setAttribute("data-orig-title", "download with video");
      a.title = "download with video";

      // Preserve qtip attributes so tooltips work
      if (span.getAttribute("data-hasqtip"))
        a.setAttribute("data-hasqtip", span.getAttribute("data-hasqtip"));
      if (span.getAttribute("aria-describedby"))
        a.setAttribute("aria-describedby", span.getAttribute("aria-describedby"));

      // Inner content: keep the original icon span (fas fa-file-download)
      a.innerHTML = span.innerHTML;
      span.replaceWith(a);
    });

    // ── 2. Beatmapset detail pages (/beatmapsets/ID) ─────────────────────────
    // When logged out, osu! renders a "Sign In to access more features" button
    // instead of the download links. Replace it with the exact logged-in pair.
    const bmid = getBeatmapId();
    if (!bmid) return;

    // Guard: if real download links already exist (script ran before, or user logged in),
    // or if we already injected them, don't duplicate.
    const downloadLinksExist = !!document.querySelector(
      `.beatmapset-header__buttons a[href*="/download"]`
    );
    if (downloadLinksExist) return;

    const signInBtn = Array.from(document.querySelectorAll("button.btn-osu-big")).find((btn) => {
      const text = (btn.textContent || "").toLowerCase();
      return text.includes("sign in") && text.includes("access more features");
    });

    if (!signInBtn) return;

    // Build "Download with Video" — matches logged-in <a class="btn-osu-big btn-osu-big--beatmapset-header">
    const aWithVideo = document.createElement("a");
    aWithVideo.className = "btn-osu-big btn-osu-big--beatmapset-header ";
    aWithVideo.href = `https://osu.ppy.sh/beatmapsets/${bmid}/download`;
    aWithVideo.innerHTML =
      '<span class="btn-osu-big__content">' +
        '<span class="btn-osu-big__left">' +
          '<span class="btn-osu-big__text-top">Download</span>' +
          '<span class="btn-osu-big__text-bottom">with Video</span>' +
        '</span>' +
        '<span class="btn-osu-big__icon">' +
          '<span class="fa fa-fw">' +
            '<span class="fas fa-download"></span>' +
          '</span>' +
        '</span>' +
      '</span>';

    // Build "Download without Video"
    const aNoVideo = document.createElement("a");
    aNoVideo.className = "btn-osu-big btn-osu-big--beatmapset-header ";
    aNoVideo.href = `https://osu.ppy.sh/beatmapsets/${bmid}/download?noVideo=1`;
    aNoVideo.innerHTML =
      '<span class="btn-osu-big__content">' +
        '<span class="btn-osu-big__left">' +
          '<span class="btn-osu-big__text-top">Download</span>' +
          '<span class="btn-osu-big__text-bottom">without Video</span>' +
        '</span>' +
        '<span class="btn-osu-big__icon">' +
          '<span class="fa fa-fw">' +
            '<span class="fas fa-download"></span>' +
          '</span>' +
        '</span>' +
      '</span>';

    signInBtn.replaceWith(aWithVideo, aNoVideo);
  }

  // ═══ Toast helper ═══
  function showOsuFavToast(msg, rightOffset = "20px") {
    const t = document.createElement("div");
    Object.assign(t.style, {
      position: "fixed",
      bottom: "20px",
      right: rightOffset,
      zIndex: "100001",
      background: "#222",
      border: "1px solid #444",
      borderRadius: "4px",
      padding: "7px 14px",
      fontSize: "12px",
      color: "#ddd",
      boxShadow: "0 2px 8px rgba(0,0,0,.5)",
      pointerEvents: "none",
      transition: "opacity 0.2s ease",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 200);
    }, 2500);
  }

  // ═══ Version check & update helper ═══
  function isNewerVersion(current, latest) {
    if (!current || !latest) return false;
    const cParts = current.split(".").map((n) => parseInt(n, 10) || 0);
    const lParts = latest.split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(cParts.length, lParts.length); i++) {
      const c = cParts[i] || 0;
      const l = lParts[i] || 0;
      if (l > c) return true;
      if (c > l) return false;
    }
    return false;
  }

  function checkVersionUpdate(force = false) {
    const currentVersion = typeof GM_info !== "undefined" ? GM_info.script.version : "3.6.1";
    const lastCheck = GM_getValue("osu_last_version_check", 0);
    const checkInterval = 24 * 60 * 60 * 1000; // 24 hours

    if (!force && Date.now() - lastCheck < checkInterval) {
      return Promise.resolve(GM_getValue("osu_latest_version", null));
    }

    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest === "undefined") {
        resolve(null);
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url: "https://raw.githubusercontent.com/vyroxat/Local-osu-Favorites/main/osu-local-favorites.user.js",
        timeout: 10000,
        onload: function (response) {
          GM_setValue("osu_last_version_check", Date.now());
          const text = response.responseText;
          const match = text.match(/@version\s+([0-9.]+)/);
          if (match) {
            const latestVersion = match[1].trim();
            if (isNewerVersion(currentVersion, latestVersion)) {
              GM_setValue("osu_latest_version", latestVersion);
              resolve(latestVersion);
              return;
            }
          }
          GM_setValue("osu_latest_version", null);
          resolve(null);
        },
        onerror: function () {
          resolve(null);
        },
        ontimeout: function () {
          resolve(null);
        },
      });
    });
  }

  // ═══ Init ═══
  function init() {
    injectInterceptor();
    getFavorites();
    ensureHeartIndicator();
    addCopyAllButton();
    addGuestFavoriteButton();
    enableGuestDownloads();

    // Debounced observer — runs at most once per 600ms to avoid freezing the page
    let timer = null;
    const debouncedRefresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshButtons();
        if (!document.getElementById("osu-local-fav-ind"))
          ensureHeartIndicator();
        addCopyAllButton();
        addGuestFavoriteButton();
        updateFloatingHeart();
        enableGuestDownloads();
      }, 600);
    };

    if (document.body) {
      new MutationObserver(debouncedRefresh).observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    // Polling for SPA navigation (low overhead)
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        ensureHeartIndicator();
        addGuestFavoriteButton();
        enableGuestDownloads();
        debouncedRefresh();
      }
    }, 800);

    // Initial refresh after page settles
    setTimeout(refreshButtons, 800);
    setTimeout(refreshButtons, 2000);
    setTimeout(addGuestFavoriteButton, 1200);
    setTimeout(addGuestFavoriteButton, 2500);
    setTimeout(enableGuestDownloads, 1000);
    setTimeout(enableGuestDownloads, 2200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
