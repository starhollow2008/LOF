// ==UserScript==
// @name         osu! Local Favorites
// @namespace    https://github.com/starhollow2008/osu-Local-Favorites
// @updateURL    https://github.com/starhollow2008/osu-Local-Favorites/raw/main/osu-local-favorites.user.js
// @downloadURL  https://github.com/starhollow2008/osu-Local-Favorites/raw/main/osu-local-favorites.user.js
// @version      5.4.2
// @icon         https://github.com/starhollow2008/osu-Local-Favorites/blob/main/icons/icon48.png?raw=true
// @description  Store osu! beatmap favorites locally instead of on osu!'s servers. Works without sign-in.
// @author       Starhollow2008 | FlareonGhh
// @match        https://osu.ppy.sh/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      gist.githubusercontent.com
// @connect      assets.ppy.sh
// @connect      b.ppy.sh
// @connect      mirror.hinamizawa.ai
// @run-at       document-start
// ==/UserScript==

/* === osu! Local Favorites ===
 *
 * Table of contents (search for the ═══ markers below):
 *   1. Page-world XHR/fetch interceptor  — blocks osu!'s own favourite calls
 *   2. Error reporting                   — console + on-page toast for failures
 *   3. Storage                           — local favourites CRUD (GM_*Value)
 *   4. Theme                             — accent color + opacity, as CSS vars
 *   5. Download Mirrors                  — 3rd-party download fallback + popover;
 *                                           also previews, playback settings, and the
 *                                           IndexedDB cover/preview cache
 *   6. GitHub Gist Backup                — connect, manual/auto sync, restore
 *   7. Beatmap data extraction           — parse JSON / DOM card into a record
 *   8. Favorite button detection         — find osu!'s heart buttons on page
 *   9. Visual helpers                    — heart icon fill/outline state
 *  10. Background enrichment             — fetch full detail-page JSON
 *  11. Global re-enrichment              — Settings → Library Maintenance
 *  12. Toggle favorite                   — the core add/remove action
 *  13. Copy-all button                   — bulk-import from a profile page's
 *                                            Favourite/Most Played sections
 *  14. Floating heart indicator          — always-on-screen shortcut
 *  15. Favorites panel                   — the side panel UI + Settings view
 *  16. Guest-mode fallback button        — heart button on detail pages
 *  17. Guest downloads + mirror buttons    — download links when logged out
 *  18. Toast / version-check / update UI — misc helpers
 *  19. Init                              — observers, polling, menu commands
 */
(() => {
  "use strict";

  const STORAGE_KEY = "osu_local_favorites";

  // ═══ GM storage compatibility shim ═══
  // Some userscript-manager environments (seen on certain mobile browsers)
  // only partially implement the GM_ API: GM_getValue/GM_setValue exist as
  // callable no-op stubs that log "GM_getValue is not supported" to the
  // console instead of throwing — so a plain `typeof GM_getValue ===
  // "function"` check passes even though nothing is actually being
  // persisted, and every read comes back undefined regardless of the
  // default value passed in. That alone was enough to make favoriting
  // crash outright (toggleFavorite indexing into an undefined favorites
  // object). We do a real write-then-read round trip once at startup and,
  // if it doesn't survive, silently redirect all GM_getValue/GM_setValue
  // calls to localStorage instead. Every one of this script's ~60 existing
  // call sites keeps calling GM_getValue/GM_setValue exactly as before —
  // shadowing the names here at the top of the IIFE is enough to redirect
  // all of them, no need to touch each call site individually.
  const _nativeGM_getValue = typeof GM_getValue === "function" ? GM_getValue : null;
  const _nativeGM_setValue = typeof GM_setValue === "function" ? GM_setValue : null;
  const _GM_FALLBACK_LS_KEY = "__osu_local_favorites_gm_fallback__";

  function _lsReadAll() {
    try {
      const raw = localStorage.getItem(_GM_FALLBACK_LS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function _lsWriteAll(all) {
    try {
      localStorage.setItem(_GM_FALLBACK_LS_KEY, JSON.stringify(all));
    } catch (e) {
      // Nothing more we can do if localStorage is also unavailable/full.
    }
  }

  // In-memory write-through cache over the localStorage fallback.
  // Without this, EVERY GM_getValue call re-serialized the entire store —
  // with a large favorites library (500+) that meant multi-megabyte
  // JSON.parse calls hundreds of times per panel render, causing the
  // exponential slowdown / "Forced reflow" violations. Reads hit the cache;
  // writes update the cache and persist asynchronously-ish (sync write,
  // but only one stringify per mutation instead of read+parse+stringify).
  let _lsCache = null; // null = not loaded yet

  function _lsCacheGet() {
    if (_lsCache === null) _lsCache = _lsReadAll();
    return _lsCache;
  }

  const _gmStorageWorks = (() => {
    if (!_nativeGM_getValue || !_nativeGM_setValue) return false;
    try {
      const probeKey = "__osu_local_favorites_probe__";
      const probeValue = "ok-" + Date.now();
      _nativeGM_setValue(probeKey, probeValue);
      return _nativeGM_getValue(probeKey, null) === probeValue;
    } catch (e) {
      return false;
    }
  })();

  function GM_getValue(key, defaultValue) {
    if (_gmStorageWorks) {
      const v = _nativeGM_getValue(key, defaultValue);
      return v === undefined ? defaultValue : v;
    }
    const all = _lsCacheGet();
    return key in all ? all[key] : defaultValue;
  }

  function GM_setValue(key, value) {
    if (_gmStorageWorks) {
      _nativeGM_setValue(key, value);
      return;
    }
    const all = _lsCacheGet();
    all[key] = value;
    // Persist the mutated object directly — no re-parse needed.
    _lsWriteAll(all);
  }

  if (!_gmStorageWorks) {
    console.warn(
      "[osu-local-favorites] this userscript manager's GM storage isn't working — falling back to localStorage",
    );
  }

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
          } catch (e) { }
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

  // ═══ Error reporting ═══
  // One place for every failure in this script to end up: a structured
  // console.error() (name/message/HTTP status/stack, so pasting that one
  // line is enough to file a useful bug report) plus a small on-page toast
  // when it's worth telling the user something failed. Call sites that
  // already showed a plain toast on failure route through reportError()
  // below instead of building their own message, so they pick up the
  // console detail for free without changing what appears on screen.
  const ERROR_TOAST_MIN_GAP_MS = 4000; // don't flood the screen if something fails repeatedly
  let _lastErrorToastAt = 0;

  function showOsuFavErrorToast(msg) {
    if (!document.body) return; // page not ready — the console line already has the detail
    const t = document.createElement("div");
    Object.assign(t.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "100002",
      maxWidth: "320px",
      background: "#2a1414",
      border: "1px solid #6b2222",
      borderRadius: "4px",
      padding: "8px 14px",
      fontSize: "12px",
      lineHeight: "1.4",
      color: "#f5b8b8",
      boxShadow: "0 2px 8px rgba(0,0,0,.5)",
      pointerEvents: "none",
      transition: "opacity 0.2s ease",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });
    t.textContent = "⚠ Error: " + msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 200);
    }, 4000);
  }

  // context: short human label for where this happened, shown in both the
  // toast and the console line (e.g. "Gist backup", "Toggle favorite").
  // err: whatever was thrown/rejected — normally an Error, handled
  // gracefully either way. extra: optional {status, statusText, ...} for
  // callers that know more than what's already on the Error object (most
  // network helpers below attach .status/.statusText themselves, so this is
  // rarely needed).
  function reportError(context, err, extra) {
    extra = extra || {};
    const name = (err && err.name) || "Error";
    const message = (err && err.message) || String(err);
    const status = extra.status != null ? extra.status : (err && err.status) || null;
    const statusText = extra.statusText != null ? extra.statusText : (err && err.statusText) || null;
    const stack = (err && err.stack) || null;
    const statusPart = status ? ` (status ${status}${statusText ? " " + statusText : ""})` : "";

    console.error(
      `[osu! Local Favorites] ${context} — ${name}: ${message}${statusPart}`,
      Object.assign(
        { context, name, message, status, statusText, stack, time: new Date().toISOString() },
        extra,
      ),
    );

    const now = Date.now();
    if (now - _lastErrorToastAt < ERROR_TOAST_MIN_GAP_MS) return; // already told the user something just failed
    _lastErrorToastAt = now;
    showOsuFavErrorToast(`${context}: ${message}${statusPart} — see console for details`);
  }

  // Last-resort safety net for bugs that slip past every try/catch above.
  // window-level "error"/"unhandledrejection" fire for *every* script on the
  // page, not just this one, so each listener below only reports when the
  // stack trace contains one of this script's own function names — a
  // best-effort filter (Tampermonkey doesn't expose a reliable "this came
  // from a userscript" flag), but good enough to avoid popping a Local
  // Favorites error toast for osu!'s own unrelated page bugs.
  const OWN_STACK_MARKERS = [
    "toggleFavorite", "ghApiRequest", "osuApiGetToken", "osuApiTokenRequest",
    "enrichBeatmapData", "showFavoritesPanel", "refreshButtons", "performGistBackup",
  ];
  function looksLikeOwnError(err) {
    const stack = (err && err.stack) || "";
    return OWN_STACK_MARKERS.some((name) => stack.includes(name));
  }
  window.addEventListener("error", (e) => {
    if (!looksLikeOwnError(e.error)) return;
    reportError("Uncaught error", e.error || new Error(e.message));
  });
  window.addEventListener("unhandledrejection", (e) => {
    if (!looksLikeOwnError(e.reason)) return;
    reportError("Unhandled rejection", e.reason instanceof Error ? e.reason : new Error(String(e.reason)));
  });

  // ═══ Storage ═══
  function getFavorites() {
    return GM_getValue(STORAGE_KEY, {});
  }

  function setFavorites(favs) {
    GM_setValue(STORAGE_KEY, favs);
  }

  function isFavorited(id) {
    return !!getFavorites()[id];
  }

  // ═══ Collections (playlists) ═══
  // User-defined groupings of favorites, entirely separate from osu!'s own
  // collections. Stored as { [collectionId]: { name, created, ids: [beatmapId,...] } }.
  const COLLECTIONS_KEY = "osu_fav_collections";

  function getCollections() {
    return GM_getValue(COLLECTIONS_KEY, {});
  }

  function setCollections(cols) {
    GM_setValue(COLLECTIONS_KEY, cols);
  }

  function createCollection(name) {
    const cols = getCollections();
    const id =
      "col_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    cols[id] = {
      name: (name || "").trim() || "Untitled",
      created: new Date().toISOString(),
      ids: [],
    };
    setCollections(cols);
    return id;
  }

  function deleteCollection(id) {
    const cols = getCollections();
    delete cols[id];
    setCollections(cols);
  }

  // Adds/removes a beatmap from a collection; returns the new membership state.
  function toggleMapInCollection(collectionId, mapId) {
    const cols = getCollections();
    const col = cols[collectionId];
    if (!col) return false;
    if (!Array.isArray(col.ids)) col.ids = [];
    const idx = col.ids.indexOf(mapId);
    let nowIn;
    if (idx === -1) {
      col.ids.push(mapId);
      nowIn = true;
    } else {
      col.ids.splice(idx, 1);
      nowIn = false;
    }
    setCollections(cols);
    return nowIn;
  }

  function collectionsContainingMap(mapId) {
    const cols = getCollections();
    return Object.entries(cols)
      .filter(([, c]) => Array.isArray(c.ids) && c.ids.includes(mapId))
      .map(([id]) => id);
  }

  // ═══ Theme ═══
  // Accent color and the idle/hover/active opacity levels used by the cover
  // preview button are all exposed as CSS custom properties on <html>, rather
  // than hardcoded throughout the UI. Settings → Appearance just updates these
  // variables (and persists them) — every element that references
  // var(--osu-fav-accent) etc. picks up the change immediately, with no need
  // to touch each individual style string.
  const THEME_ACCENT_KEY = "osu_theme_accent";
  const THEME_HEART_KEY = "osu_theme_heart_color";
  const THEME_IDLE_OPACITY_KEY = "osu_theme_idle_opacity";
  const THEME_IDLE_DIM_KEY = "osu_theme_idle_dim";
  const THEME_HOVER_DIM_KEY = "osu_theme_hover_dim";
  const THEME_ACTIVE_OPACITY_KEY = "osu_theme_active_opacity";

  const THEME_DEFAULTS = {
    accent: "#ff66aa",
    heartColor: "#ff66aa",
    idleOpacity: 0.15,
    idleDim: 0,
    hoverDim: 0.65,
    activeOpacity: 0.8,
  };

  // Simple hex darken for the accent's hover/pressed shade — mirrors the
  // original #ff66aa → #ff3377 relationship (roughly -25% lightness)
  function darkenHex(hex, amount = 0.25) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
    const [r, g, b] = [1, 2, 3].map((i) => clamp(parseInt(m[i], 16) * (1 - amount)));
    return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  }

  function getThemeSettings() {
    return {
      accent: GM_getValue(THEME_ACCENT_KEY, THEME_DEFAULTS.accent),
      heartColor: GM_getValue(THEME_HEART_KEY, THEME_DEFAULTS.heartColor),
      idleOpacity: GM_getValue(THEME_IDLE_OPACITY_KEY, THEME_DEFAULTS.idleOpacity),
      idleDim: GM_getValue(THEME_IDLE_DIM_KEY, THEME_DEFAULTS.idleDim),
      hoverDim: GM_getValue(THEME_HOVER_DIM_KEY, THEME_DEFAULTS.hoverDim),
      activeOpacity: GM_getValue(THEME_ACTIVE_OPACITY_KEY, THEME_DEFAULTS.activeOpacity),
    };
  }

  // Applies the current theme settings to :root as CSS custom properties.
  // Safe to call repeatedly (e.g. right after a Settings change) — it just
  // overwrites the same handful of variables.
  function applyTheme() {
    const t = getThemeSettings();
    const root = document.documentElement.style;
    root.setProperty("--osu-fav-accent", t.accent);
    root.setProperty("--osu-fav-accent-dark", darkenHex(t.accent));
    root.setProperty("--osu-fav-heart-color", t.heartColor);
    root.setProperty("--osu-fav-idle-opacity", t.idleOpacity);
    root.setProperty("--osu-fav-idle-dim", t.idleDim);
    root.setProperty("--osu-fav-hover-dim", t.hoverDim);
    root.setProperty("--osu-fav-active-opacity", t.activeOpacity);
  }

  // Minimal heart glyph as real SVG (not emoji) — emoji hearts render from the
  // system emoji font with a fixed, non-CSS-colorable presentation, which is
  // exactly why they can't be recolored. This one uses fill/stroke, so
  // --osu-fav-heart-color actually takes effect.
  const HEART_PATH =
    "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";
  function heartSVG(filled, size = 26) {
    return filled
      ? `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path d="${HEART_PATH}" fill="var(--osu-fav-heart-color)"/></svg>`
      : `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path d="${HEART_PATH}" fill="none" stroke="var(--osu-fav-heart-color)" stroke-width="1.6"/></svg>`;
  }

  // Play/pause icons as inline SVGs — the old U+25B6/U+23F8 text glyphs get
  // emoji presentation on mobile (▶️ / colored ⏸), which broke sizing and
  // theming. SVGs render identically everywhere and inherit currentColor.
  function playSVG(size = 11) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-label="play"><path d="M8 5v14l11-7z"/></svg>`;
  }

  function pauseSVG(size = 11) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-label="pause"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;
  }

  // Player-bar icons - previous/next/shuffle/loop, same inline-SVG approach
  // as playSVG/pauseSVG above and for the same reason.
  function prevSVG(size = 14) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-label="previous"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>`;
  }
  function nextSVG(size = 14) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-label="next"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`;
  }
  function shuffleSVG(size = 14) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-label="shuffle"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>`;
  }
  function loopSVG(size = 14) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-label="loop"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>`;
  }

  // ═══ Download Mirrors ═══
  // Third-party beatmap mirrors, used as a fallback wherever osu!'s own
  // download doesn't work — guests (osu!'s own download button/route is
  // gated behind a real logged-in session), beatmaps with downloads disabled,
  // or just as an alternative when the official servers are slow. Modeled
  // after the mirror list in limjeck/osuplus.
  const MIRRORS = [
    {
      key: "beatconnect",
      settingKey: "osu_mirror_beatconnect",
      label: "Beatconnect",
      defaultOn: true,
      variants: (id) => [
        { label: "Beatconnect", top: "Beatconnect", bottom: null, url: `https://beatconnect.io/b/${id}` },
      ],
    },
    {
      key: "nerinyan",
      settingKey: "osu_mirror_nerinyan",
      label: "NeriNyan",
      defaultOn: true,
      variants: (id) => [
        { label: "NeriNyan", top: "NeriNyan", bottom: null, url: `https://api.nerinyan.moe/d/${id}` },
        { label: "NeriNyan (no video)", top: "NeriNyan", bottom: "no video", url: `https://api.nerinyan.moe/d/${id}?nv=1` },
      ],
    },
    {
      key: "sayobot",
      settingKey: "osu_mirror_sayobot",
      label: "Sayobot",
      defaultOn: false,
      variants: (id) => [
        { label: "Sayobot", top: "Sayobot", bottom: null, url: `https://dl.sayobot.cn/beatmaps/download/full/${id}` },
        { label: "Sayobot (no video)", top: "Sayobot", bottom: "no video", url: `https://dl.sayobot.cn/beatmaps/download/novideo/${id}` },
      ],
    },
    {
      key: "mino",
      settingKey: "osu_mirror_mino",
      label: "Mino",
      defaultOn: false,
      variants: (id) => [{ label: "Mino", top: "Mino", bottom: null, url: `https://catboy.best/d/${id}` }],
    },
  ];

  function isMirrorEnabled(mirror) {
    return GM_getValue(mirror.settingKey, mirror.defaultOn);
  }

  // Detects a real logged-in osu! session via the page's own current-user
  // JSON blob (empty object "{}" for guests, populated for a real session).
  // Used to decide whether "Official Download" is worth offering at all —
  // osu!'s download route requires server-side auth and simply doesn't work
  // for guests regardless of what our script does.
  function isLoggedIn() {
    const el = document.getElementById("json-current-user");
    if (!el) return false;
    try {
      const data = JSON.parse(el.textContent);
      return !!(data && data.id);
    } catch (e) {
      return false;
    }
  }

  // Which video variant to prefer, and whether Official or Mirrors should be
  // listed first — both user-configurable in Settings → Download Mirrors.
  // Nothing is ever hidden by these; they only decide ordering, so the full
  // set of options is always one click away in the dropdown.
  const DL_VIDEO_PREF_KEY = "osu_dl_video_pref"; // "video" | "novideo"
  const DL_SOURCE_PREF_KEY = "osu_dl_source_pref"; // "official" | "mirrors"
  const DL_DEFAULT_MIRROR_KEY = "osu_dl_default_mirror"; // "" | "official" | "official_novideo" | "<mirror.key>" | "<mirror.key>_novideo"

  // Flat, order-independent registry of every possible download destination
  // (both Official variants + every mirror's variants), keyed stably so a
  // stored "default mirror" choice keeps meaning the same thing no matter
  // how the user's video/source-order preferences later reorder the
  // dropdown itself. Used to populate the Settings picker and to resolve a
  // stored default back into a real URL.
  function getAllDownloadDestinations() {
    const list = [
      { key: "official", label: "Official Download" },
      { key: "official_novideo", label: "Official Download (no video)" },
    ];
    MIRRORS.forEach((m) => {
      m.variants("0").forEach((v, i) => {
        list.push({
          key: i === 0 ? m.key : `${m.key}_novideo`,
          label: v.bottom ? `${v.top} (${v.bottom})` : v.top,
        });
      });
    });
    return list;
  }

  // Resolves the stored default-mirror key into an actual {label, url} for
  // this beatmap, or null if it can't currently be used — either because
  // the setting is unset, the chosen mirror has since been disabled, or
  // it's Official but the user isn't signed in. Returning null is the
  // signal to fall back to showing the normal dropdown, so this never
  // hands back a link that would just fail.
  function resolveDefaultMirror(id) {
    const key = GM_getValue(DL_DEFAULT_MIRROR_KEY, "");
    if (!key) return null;

    if (key === "official" || key === "official_novideo") {
      if (!isLoggedIn()) return null;
      return {
        label: key === "official_novideo" ? "Official Download (no video)" : "Official Download",
        url: `https://osu.ppy.sh/beatmapsets/${id}/download${key === "official_novideo" ? "?noVideo=1" : ""}`,
      };
    }

    const novideo = key.endsWith("_novideo");
    const mirrorKey = novideo ? key.slice(0, -"_novideo".length) : key;
    const mirror = MIRRORS.find((m) => m.key === mirrorKey);
    if (!mirror || !isMirrorEnabled(mirror)) return null;

    const variants = mirror.variants(id);
    const variant = novideo ? variants[1] : variants[0];
    if (!variant) return null;
    return { label: variant.bottom ? `${variant.top} (${variant.bottom})` : variant.top, url: variant.url };
  }

  // ═══ Full-length previews (Hinamizawa music mirror) ═══
  // osu!'s own preview clip is a fixed ~10s cut. mirror.hinamizawa.ai runs a
  // separate music-streaming API (distinct from its beatmap-download mirror)
  // that serves the full track from its own disk when it has one cached, and
  // otherwise transparently falls back to proxying the same ~10s official
  // clip while it extracts the full song in the background — so pointing
  // the preview player at it is a strict upgrade, never a worse experience
  // than what we already show. No auth, open CORS, HTTP Range for seeking.
  const PREVIEW_FULLSONG_KEY = "osu_preview_fullsong";
  function fullSongPreviewsEnabled() {
    return GM_getValue(PREVIEW_FULLSONG_KEY, true);
  }
  function previewSourceUrl(id, fallbackUrl) {
    return fullSongPreviewsEnabled()
      ? `https://mirror.hinamizawa.ai/v3/osu/music/audio/${id}`
      : fallbackUrl;
  }

  // ═══ Music Playback settings (loop / auto next / shuffle / volume) ═══
  const MUSIC_LOOP_KEY = "osu_music_loop";
  const MUSIC_AUTONEXT_KEY = "osu_music_autonext";
  const MUSIC_SHUFFLE_KEY = "osu_music_shuffle";
  const MUSIC_VOLUME_KEY = "osu_music_volume"; // 0-100, applied as audio.volume/100
  function musicLoopEnabled() {
    return GM_getValue(MUSIC_LOOP_KEY, false);
  }
  function musicAutoNextEnabled() {
    return GM_getValue(MUSIC_AUTONEXT_KEY, false);
  }
  function musicShuffleEnabled() {
    return GM_getValue(MUSIC_SHUFFLE_KEY, false);
  }
  function musicVolumePct() {
    const v = GM_getValue(MUSIC_VOLUME_KEY, 100);
    return typeof v === "number" && v >= 0 && v <= 100 ? v : 100;
  }

  // ═══ Media Cache (background covers + audio previews) ═══
  // Without this, every reload re-requests every visible cover image, and
  // every reopen of the panel re-streams the same preview clips - none of
  // it changes between visits, so by default it's pure repeat network
  // traffic. This stores both kinds of media as Blobs in IndexedDB, keyed
  // by their source URL, and serves them back as local blob: URLs on
  // future renders until the entry's chosen expiry passes.
  //
  // "never" skips the cache store entirely (identical to how this script
  // behaved before this feature existed - always straight to the network).
  // "always" caches with no expiry; entries only change if the URL itself
  // does. Every other mode is a fixed, or user-typed custom, TTL.
  const CACHE_DURATION_KEY = "osu_cache_duration"; // "custom"|"30min"|"1h"|"6h"|"12h"|"24h"|"1week"|"1month"|"always"|"never"
  const CACHE_CUSTOM_MINUTES_KEY = "osu_cache_custom_minutes";
  const CACHE_DURATIONS_MIN = {
    "30min": 30,
    "1h": 60,
    "6h": 6 * 60,
    "12h": 12 * 60,
    "24h": 24 * 60,
    "1week": 7 * 24 * 60,
    "1month": 30 * 24 * 60,
  };
  function cacheDurationMode() {
    return GM_getValue(CACHE_DURATION_KEY, "24h");
  }
  function cacheCustomMinutes() {
    const n = Number(GM_getValue(CACHE_CUSTOM_MINUTES_KEY, 60));
    return Number.isFinite(n) && n > 0 ? n : 60;
  }
  // TTL in ms, or Infinity for "always" - "never" is handled by callers
  // before this is ever reached (they skip the cache store outright).
  function cacheDurationMs() {
    const mode = cacheDurationMode();
    if (mode === "always") return Infinity;
    if (mode === "custom") return cacheCustomMinutes() * 60 * 1000;
    return (CACHE_DURATIONS_MIN[mode] || CACHE_DURATIONS_MIN["24h"]) * 60 * 1000;
  }
  function formatCacheBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  const CACHE_DB_NAME = "osu_local_favorites_media_cache";
  const CACHE_STORE = "media";
  let _cacheDbPromise = null;
  function openCacheDb() {
    if (_cacheDbPromise) return _cacheDbPromise;
    _cacheDbPromise = new Promise((resolve) => {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      try {
        const req = indexedDB.open(CACHE_DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(CACHE_STORE)) {
            req.result.createObjectStore(CACHE_STORE, { keyPath: "url" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        // Fail soft - callers treat a null db exactly like "cache
        // unavailable" and fall back to plain network URLs, same as if
        // caching were switched off.
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    return _cacheDbPromise;
  }
  function cacheGet(url) {
    return openCacheDb().then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const req = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(url);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    });
  }
  function cachePut(url, blob) {
    return openCacheDb().then((db) => {
      if (!db) return;
      try {
        db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE).put({ url, blob, cachedAt: Date.now() });
      } catch (e) {
        // Best-effort - a failed write just means no caching for this one item.
      }
    });
  }
  function cacheClearAll() {
    return openCacheDb().then((db) => {
      if (!db) return;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(CACHE_STORE, "readwrite");
          tx.objectStore(CACHE_STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (e) {
          resolve();
        }
      });
    });
  }
  // Used by the Settings panel to show how much is currently stored.
  function cacheStats() {
    return openCacheDb().then((db) => {
      if (!db) return { count: 0, bytes: 0 };
      return new Promise((resolve) => {
        try {
          const req = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).getAll();
          req.onsuccess = () => {
            const rows = req.result || [];
            resolve({ count: rows.length, bytes: rows.reduce((sum, r) => sum + (r.blob ? r.blob.size : 0), 0) });
          };
          req.onerror = () => resolve({ count: 0, bytes: 0 });
        } catch (e) {
          resolve({ count: 0, bytes: 0 });
        }
      });
    });
  }

  // Fetches a URL's raw bytes as a Blob for caching, via GM_xmlhttpRequest
  // rather than a page-context fetch(). osu!'s own CDN (assets.ppy.sh /
  // b.ppy.sh) doesn't send permissive Access-Control-Allow-Origin headers,
  // so a plain fetch() from here is blocked by the browser as a cross-origin
  // network error before any bytes ever arrive — the image/audio still
  // displays fine via <img>/<audio> (those aren't subject to CORS), but the
  // cache store silently never gets populated, which is exactly why caching
  // "worked" for nothing. GM_xmlhttpRequest runs outside the page's CORS
  // sandbox (same mechanism already used for the GitHub/osu! API calls
  // above), so it isn't affected. Falls back to a normal fetch() if this
  // userscript manager doesn't support GM_xmlhttpRequest at all.
  function gmFetchBlob(url) {
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve) => {
        try {
          GM_xmlhttpRequest({
            method: "GET",
            url,
            responseType: "blob",
            timeout: 20000,
            onload: (response) => {
              if (response.status >= 200 && response.status < 300 && response.response) {
                resolve(response.response);
              } else {
                resolve(null);
              }
            },
            onerror: () => resolve(null),
            ontimeout: () => resolve(null),
          });
        } catch (e) {
          resolve(null);
        }
      });
    }
    return fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .catch(() => null);
  }

  // Resolves to a URL safe to hand straight to <img src> / <audio src>: a
  // local blob: URL when a fresh cached copy exists, otherwise the original
  // network URL unchanged - so a cache miss never delays first-time
  // playback/display waiting on a full download. A miss also kicks off a
  // background fetch to populate the cache for next time; fire-and-forget,
  // not awaited by the caller either way.
  function resolveCachedMediaUrl(url) {
    if (!url) return Promise.resolve(url);
    if (cacheDurationMode() === "never") return Promise.resolve(url);

    return cacheGet(url).then((entry) => {
      const ttl = cacheDurationMs();
      const fresh = entry && (ttl === Infinity || Date.now() - entry.cachedAt < ttl);
      if (fresh) return URL.createObjectURL(entry.blob);

      gmFetchBlob(url).then((blob) => { if (blob) cachePut(url, blob); });
      return url;
    });
  }

  // A clip this short means Hinamizawa doesn't have the full track cached
  // and previewSourceUrl() fell back to osu!'s own ~10s clip - see the
  // "skip if not on Hina" check in ensureAudio() below.
  const SHORT_CLIP_MAX_SECONDS = 15;

  // Singleton <audio> element, shared across every card's preview button
  // and the Now Playing bar. Created once per page load and reused for the
  // lifetime of the tab, so its listeners key off dynamic `_np*`/`_queue*`
  // properties (reassigned by whichever panel is currently open) rather
  // than closing over any one panel's local variables, which would go
  // stale the moment that panel is closed and reopened.
  function ensureAudio() {
    if (window._osuFavAudio) return window._osuFavAudio;
    const audio = new Audio();
    audio.volume = musicVolumePct() / 100;
    window._osuFavAudio = audio;
    audio._activeBtn = null;
    audio._activeBar = null;
    audio._activeDim = null;
    audio._npBar = null;
    audio._npTitle = null;
    audio._npArtist = null;
    audio._npPlayBtn = null;
    audio._npProgressBar = null;
    audio._npThumb = null;
    audio._npBg = null;
    audio._npCurrentId = null;
    audio._npCurrentTitle = "";
    audio._npCurrentArtist = "";
    audio._queueNavigated = false;
    audio._queueDirection = 1;
    audio._queueSkipAttempt = 0;
    audio._queueAdvance = null;

    audio.addEventListener("timeupdate", () => {
      const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      if (audio._activeBar) audio._activeBar.style.width = pct + "%";
      if (audio._npProgressBar) audio._npProgressBar.style.width = pct + "%";
    });

    audio.addEventListener("play", () => {
      if (audio._npPlayBtn) audio._npPlayBtn.innerHTML = pauseSVG();
    });
    audio.addEventListener("pause", () => {
      if (audio._npPlayBtn) audio._npPlayBtn.innerHTML = playSVG();
    });

    // Fires once metadata loads for whatever we just set as .src. If we got
    // here via Back/Next/auto-next/shuffle (not a direct click on this
    // track's own preview button) and the clip turns out to be osu!'s
    // short fallback rather than a full track, treat it as "not on Hina"
    // and keep moving instead of playing the short clip.
    audio.addEventListener("loadedmetadata", () => {
      if (!audio._queueNavigated) return;
      if (!fullSongPreviewsEnabled()) return;
      if (!isFinite(audio.duration) || audio.duration > SHORT_CLIP_MAX_SECONDS) return;
      if (audio._queueAdvance) {
        const dir = audio._queueDirection || 1;
        const attempt = (audio._queueSkipAttempt || 0) + 1;
        audio._queueAdvance(dir, { skipAttempt: attempt });
      }
    });

    audio.addEventListener("ended", () => {
      if (musicLoopEnabled()) {
        audio.currentTime = 0;
        audio.play();
        return;
      }
      if (musicAutoNextEnabled() && audio._queueAdvance) {
        audio._queueAdvance(1, {});
        return;
      }
      if (audio._activeBtn) {
        audio._activeBtn.style.opacity = "var(--osu-fav-idle-opacity, 0.15)";
        audio._activeBtn.style.borderColor = "#333";
        audio._activeBtn.style.color = "#999";
        audio._activeBtn.innerHTML = playSVG();
        audio._activeBtn._playing = false;
      }
      if (audio._activeBar) {
        audio._activeBar.parentElement.style.display = "none";
        audio._activeBar.style.width = "0%";
      }
      if (audio._activeDim) audio._activeDim.style.background = "rgba(51,51,51,var(--osu-fav-idle-dim, 0))";
      audio._activeBtn = null;
      audio._activeBar = null;
      audio._activeDim = null;
      if (audio._npBar) audio._npBar.style.display = "none";
      if (audio._npProgressBar) audio._npProgressBar.style.width = "0%";
      audio._npCurrentId = null;
      audio._npCurrentTitle = "";
      audio._npCurrentArtist = "";
      audio._queueAdvance = null;
    });

    return audio;
  }

  // Builds the ordered list of download options for a beatmapset. Official
  // download offers both a with-video and no-video (confirmed real
  // ?noVideo=1 param) variant — previously this was hardcoded to
  // video-only. Guests always see mirrors first, since Official won't work
  // for them no matter what; logged-in users get their configured order.
  function buildDownloadOptions(id) {
    const videoPref = GM_getValue(DL_VIDEO_PREF_KEY, "video");
    const sourcePref = GM_getValue(DL_SOURCE_PREF_KEY, "official");
    const loggedIn = isLoggedIn();

    let officialEntries;
    if (loggedIn) {
      officialEntries = [
        { label: "Official Download", url: `https://osu.ppy.sh/beatmapsets/${id}/download` },
        { label: "Official Download (no video)", url: `https://osu.ppy.sh/beatmapsets/${id}/download?noVideo=1` },
      ];
      if (videoPref === "novideo") officialEntries.reverse();
    } else {
      officialEntries = [{ label: "Official Download (requires sign-in)", url: `https://osu.ppy.sh/beatmapsets/${id}/download` }];
    }

    const mirrorEntries = [];
    MIRRORS.forEach((m) => {
      if (!isMirrorEnabled(m)) return;
      const variants = m.variants(id);
      if (videoPref === "novideo" && variants.length > 1) variants.reverse();
      mirrorEntries.push(...variants);
    });

    if (!loggedIn) return [...mirrorEntries, ...officialEntries];
    return sourcePref === "mirrors" ? [...mirrorEntries, ...officialEntries] : [...officialEntries, ...mirrorEntries];
  }

  // Shows a small popover of download options (official + enabled mirrors)
  // anchored to the triggering element. Appended to <body> — not the
  // scrollable panel list — so it's never clipped by overflow:auto. Closes
  // on outside click, Escape, or if any ancestor (e.g. the panel list)
  // scrolls out from under it.
  function showDownloadMenu(anchorEl, beatmapId) {
    const existing = document.getElementById("osu-fav-dl-menu");
    const reopening = existing && existing._anchor === anchorEl;
    if (existing && existing._cleanup) existing._cleanup();
    if (reopening) return; // Clicking the same button again just closes it

    const options = buildDownloadOptions(beatmapId);
    const menu = document.createElement("div");
    menu.id = "osu-fav-dl-menu";
    menu._anchor = anchorEl;
    menu.style.cssText =
      "position:fixed;z-index:100002;min-width:180px;max-width:240px;" +
      "background:#1a1a1a;border:1px solid #333;border-radius:4px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.5);padding:4px;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

    function cleanup() {
      menu.remove();
      document.removeEventListener("click", onOutsideClick, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onWindowScroll, true);
    }
    function onOutsideClick(e) {
      if (menu.contains(e.target)) return;
      cleanup();
    }
    function onKey(e) {
      if (e.key === "Escape") cleanup();
    }
    // Only close on a scroll that moves the menu's anchor out from under it
    // (page/panel scroll) — a scroll *inside* the menu itself (e.g. the
    // scrollable genre/tag or collections list) must not close it.
    function onWindowScroll(e) {
      if (menu.contains(e.target)) return;
      cleanup();
    }
    menu._cleanup = cleanup;

    if (options.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:11px;color:#666;padding:8px 10px;line-height:1.4";
      empty.textContent = "No download source available — enable a mirror in Settings.";
      menu.appendChild(empty);
    } else {
      options.forEach((opt) => {
        const row = document.createElement("a");
        row.href = opt.url;
        row.target = "_blank";
        row.rel = "noopener";
        row.textContent = opt.label;
        row.style.cssText =
          "display:block;padding:6px 10px;font-size:11px;color:#ddd;text-decoration:none;" +
          "border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        row.addEventListener("mouseenter", () => {
          row.style.background = "var(--osu-fav-accent)";
          row.style.color = "#fff";
        });
        row.addEventListener("mouseleave", () => {
          row.style.background = "transparent";
          row.style.color = "#ddd";
        });
        row.addEventListener("click", cleanup);
        menu.appendChild(row);
      });
    }

    document.body.appendChild(menu);

    // Position under the anchor, right-aligned, flipping above if it would
    // overflow the bottom of the viewport
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight) top = Math.max(8, rect.top - menuRect.height - 4);
    let left = rect.right - menuRect.width;
    left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
    menu.style.top = top + "px";
    menu.style.left = left + "px";

    // Defer attaching so this same click doesn't immediately close the menu
    setTimeout(() => document.addEventListener("click", onOutsideClick, true), 0);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onWindowScroll, true);
  }

  // ── Genre + Tags term collection ──
  // Builds two frequency-counted term lists from the current favorites:
  // one from the `genre` field (osu!'s own taxonomy — a handful of values),
  // one from the freeform `tags` field (can be large). Each favorite counts
  // once per unique term even if it shows up twice (e.g. a tag repeated).
  // Any tag string that collides with a genre value is dropped from the tag
  // list so the same term never appears twice across both sections.
  //
  // Tag text gets light cleanup before it's used as a dedup key: NFKC
  // normalization folds full-width Latin letters and other compatibility
  // variants down to their plain form (so e.g. a full-width "Ｋａｓａｉ" and
  // an ordinary "Kasai" collapse into one entry instead of two near-
  // duplicate rows), and stray leading/trailing punctuation is trimmed.
  // Display text keeps the normalized form's original casing/script —
  // this only removes accidental duplicates, it doesn't translate or
  // otherwise rewrite non-Latin tags.
  const TAG_TRIM_PUNCT_RE = /^[\s"'.,;:!?()\[\]「」『』【】]+|[\s"'.,;:!?()\[\]「」『』【】]+$/g;
  function normalizeTagText(raw) {
    let t = raw.normalize("NFKC").replace(TAG_TRIM_PUNCT_RE, "");
    return t;
  }

  function collectGenreAndTagTerms(favs) {
    const genreCounts = new Map(); // lowercase key -> { display, count }
    const tagCounts = new Map();
    Object.values(favs).forEach((f) => {
      const genre = (f.genre && f.genre.trim()) || "Unspecified";
      const gKey = genre.toLowerCase();
      const gEntry = genreCounts.get(gKey) || { display: genre, count: 0 };
      gEntry.count++;
      genreCounts.set(gKey, gEntry);

      const seen = new Set();
      (f.tags || "").split(/\s+/).forEach((raw) => {
        const tag = normalizeTagText(raw.trim());
        if (!tag) return;
        const tKey = tag.toLowerCase();
        if (seen.has(tKey)) return;
        seen.add(tKey);
        const tEntry = tagCounts.get(tKey) || { display: tag, count: 0 };
        tEntry.count++;
        tagCounts.set(tKey, tEntry);
      });
    });
    // A term that's ever used as an actual genre value is a genre, not a tag.
    genreCounts.forEach((_, key) => tagCounts.delete(key));
    return { genreCounts, tagCounts };
  }

  // Whether a favorite matches a given genre/tag filter key (both compared
  // lowercase, tags run through the same NFKC-normalize + trim as the
  // popover list) — true if it's that favorite's genre, or one of its tags.
  function favMatchesGenreTerm(f, key) {
    const genre = ((f.genre && f.genre.trim()) || "Unspecified").toLowerCase();
    if (genre === key) return true;
    return (f.tags || "")
      .split(/\s+/)
      .map((t) => normalizeTagText(t.trim()).toLowerCase())
      .includes(key);
  }

  // ── Genre + Tags filter popover ──
  // 3-tap cycle per row: neutral → include (green) → exclude (red) → neutral.
  // Multiple "include" terms are OR'd together; any "exclude" term is always
  // dropped, even if it would otherwise match an include. currentState is
  // { [lowercaseTerm]: "include" | "exclude" }; onApply is called after every
  // tap with a fresh copy so the caller can re-render live without closing
  // the menu. Rows are split into a "Genres" section (osu!'s own taxonomy)
  // and a "Tags" section (freeform, can be large — hence the search box).
  function showGenreFilterMenu(anchorEl, currentState, onApply) {
    const existing = document.getElementById("osu-fav-genre-menu");
    const reopening = existing && existing._anchor === anchorEl;
    if (existing && existing._cleanup) existing._cleanup();
    if (reopening) return;

    const state = Object.assign({}, currentState);

    const favs = getFavorites();
    const { genreCounts, tagCounts } = collectGenreAndTagTerms(favs);
    const genreList = Array.from(genreCounts.entries())
      .map(([key, v]) => ({ key, display: v.display, count: v.count }))
      .sort((a, b) => a.display.localeCompare(b.display));
    const tagList = Array.from(tagCounts.entries())
      .map(([key, v]) => ({ key, display: v.display, count: v.count }))
      .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));

    const menu = document.createElement("div");
    menu.id = "osu-fav-genre-menu";
    menu._anchor = anchorEl;
    menu.style.cssText =
      "position:fixed;z-index:100002;min-width:190px;max-width:240px;max-height:360px;overflow-y:auto;" +
      "background:#1a1a1a;border:1px solid #333;border-radius:4px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.5);padding:4px;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

    function cleanup() {
      menu.remove();
      document.removeEventListener("click", onOutsideClick, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onWindowScroll, true);
    }
    function onOutsideClick(e) {
      if (menu.contains(e.target)) return;
      cleanup();
    }
    function onKey(e) {
      if (e.key === "Escape") cleanup();
    }
    // Only close on a scroll that moves the menu's anchor out from under it
    // (page/panel scroll) — a scroll *inside* the menu itself (e.g. the
    // scrollable genre/tag or collections list) must not close it.
    function onWindowScroll(e) {
      if (menu.contains(e.target)) return;
      cleanup();
    }
    menu._cleanup = cleanup;

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:9px;color:#666;padding:2px 6px 6px;line-height:1.4";
    hint.textContent = "Tap: include (green) → exclude (red) → off";
    menu.appendChild(hint);

    // Tags can run into the hundreds for a big library — a live filter box
    // keeps that usable instead of relying on scrolling alone.
    const searchBox = document.createElement("input");
    searchBox.type = "text";
    searchBox.placeholder = "Filter list...";
    searchBox.style.cssText =
      "width:100%;box-sizing:border-box;background:#111;border:1px solid #333;border-radius:3px;color:#ddd;" +
      "font-size:10px;padding:4px 6px;outline:none;margin-bottom:4px";
    searchBox.addEventListener("click", (e) => e.stopPropagation());
    searchBox.addEventListener("keydown", (e) => e.stopPropagation());
    menu.appendChild(searchBox);

    const rowsWrap = document.createElement("div");
    menu.appendChild(rowsWrap);

    function styleForState(s) {
      if (s === "include") return { bg: "#215a2b", border: "#3fa54a", color: "#fff" };
      if (s === "exclude") return { bg: "#5a2121", border: "#c0392b", color: "#fff" };
      return { bg: "transparent", border: "#333", color: "#ccc" };
    }

    function makeRow(term) {
      const row = document.createElement("button");
      row.type = "button";
      const sty = styleForState(state[term.key]);
      row.style.cssText =
        `display:flex;justify-content:space-between;align-items:center;gap:6px;width:100%;text-align:left;` +
        `margin:2px 0;padding:5px 8px;font-size:11px;border:1px solid ${sty.border};border-radius:3px;` +
        `background:${sty.bg};color:${sty.color};cursor:pointer;box-sizing:border-box`;
      const label = document.createElement("span");
      label.textContent = term.display;
      label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      const count = document.createElement("span");
      count.textContent = term.count;
      count.style.cssText = "flex-shrink:0;opacity:0.65;font-size:10px";
      row.append(label, count);
      row.addEventListener("click", () => {
        const cur = state[term.key];
        const next = cur === undefined ? "include" : cur === "include" ? "exclude" : undefined;
        if (next === undefined) delete state[term.key];
        else state[term.key] = next;
        const s2 = styleForState(state[term.key]);
        row.style.borderColor = s2.border;
        row.style.background = s2.bg;
        row.style.color = s2.color;
        onApply(Object.assign({}, state));
      });
      return row;
    }

    // Tags can number in the hundreds/thousands for a big library — building
    // a DOM row for every single one on open was the source of multi-second
    // "click handler" jank. Cap what's actually rendered; the live filter
    // box (with its own smaller cap) is how the rest get reached.
    const MAX_UNFILTERED_TAGS = 60;
    const MAX_FILTERED_TAGS = 150;

    function renderRows(query) {
      const q = (query || "").toLowerCase();
      const filteredGenres = q ? genreList.filter((t) => t.display.toLowerCase().includes(q)) : genreList;
      const filteredTagsAll = q ? tagList.filter((t) => t.display.toLowerCase().includes(q)) : tagList;
      const cap = q ? MAX_FILTERED_TAGS : MAX_UNFILTERED_TAGS;
      const shownTags = filteredTagsAll.slice(0, cap);
      const hiddenCount = filteredTagsAll.length - shownTags.length;

      // Build off-DOM, then attach once — avoids a forced layout per row.
      const frag = document.createDocumentFragment();

      if (filteredGenres.length === 0 && shownTags.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "font-size:11px;color:#666;padding:8px 10px";
        empty.textContent = q ? "No matches." : "No favorites to filter yet.";
        frag.appendChild(empty);
      } else {
        if (filteredGenres.length) {
          const label = document.createElement("div");
          label.style.cssText = "font-size:9px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.03em;padding:4px 8px 2px";
          label.textContent = "Genres";
          frag.appendChild(label);
          filteredGenres.forEach((t) => frag.appendChild(makeRow(t)));
        }
        if (shownTags.length) {
          const label = document.createElement("div");
          label.style.cssText = "font-size:9px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.03em;padding:6px 8px 2px";
          label.textContent = "Tags";
          frag.appendChild(label);
          shownTags.forEach((t) => frag.appendChild(makeRow(t)));
        }
        if (hiddenCount > 0) {
          const note = document.createElement("div");
          note.style.cssText = "font-size:9px;color:#555;padding:5px 8px;line-height:1.4";
          note.textContent = `+${hiddenCount} more tag${hiddenCount === 1 ? "" : "s"} — type to narrow`;
          frag.appendChild(note);
        }
      }

      rowsWrap.innerHTML = "";
      rowsWrap.appendChild(frag);
    }
    renderRows("");
    searchBox.addEventListener("input", () => renderRows(searchBox.value.trim()));

    if (genreList.length || tagList.length) {
      const divider = document.createElement("div");
      divider.style.cssText = "height:1px;background:#333;margin:4px 2px";
      menu.appendChild(divider);

      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.textContent = "Clear filters";
      clearBtn.style.cssText =
        "display:block;width:100%;text-align:center;padding:5px 8px;font-size:10px;box-sizing:border-box;" +
        "border:1px solid #333;border-radius:3px;background:transparent;color:#888;cursor:pointer";
      clearBtn.addEventListener("mouseenter", () => (clearBtn.style.color = "var(--osu-fav-accent)"));
      clearBtn.addEventListener("mouseleave", () => (clearBtn.style.color = "#888"));
      clearBtn.addEventListener("click", () => {
        Object.keys(state).forEach((k) => delete state[k]);
        onApply({});
        cleanup();
      });
      menu.appendChild(clearBtn);
    }

    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight) top = Math.max(8, rect.top - menuRect.height - 4);
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8));
    menu.style.top = top + "px";
    menu.style.left = left + "px";

    setTimeout(() => document.addEventListener("click", onOutsideClick, true), 0);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onWindowScroll, true);
  }

  // ── Collections selector popover (toolbar) ──
  // Lets the user pick which collection to filter the list by ("All favorites"
  // clears it), create new collections, and delete existing ones (two-tap
  // confirm, matching the "Remove all favorites" pattern elsewhere).
  function showCollectionsMenu(anchorEl, activeId, onSelect) {
    const existing = document.getElementById("osu-fav-cols-menu");
    const reopening = existing && existing._anchor === anchorEl;
    if (existing && existing._cleanup) existing._cleanup();
    if (reopening) return;

    const menu = document.createElement("div");
    menu.id = "osu-fav-cols-menu";
    menu._anchor = anchorEl;
    menu.style.cssText =
      "position:fixed;z-index:100002;min-width:190px;max-width:240px;max-height:320px;overflow-y:auto;" +
      "background:#1a1a1a;border:1px solid #333;border-radius:4px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.5);padding:4px;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

    function cleanup() {
      menu.remove();
      document.removeEventListener("click", onOutsideClick, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onWindowScroll, true);
    }
    function onOutsideClick(e) {
      if (menu.contains(e.target)) return;
      cleanup();
    }
    function onKey(e) {
      if (e.key === "Escape") cleanup();
    }
    // Only close on a scroll that moves the menu's anchor out from under it
    // (page/panel scroll) — a scroll *inside* the menu itself (e.g. the
    // scrollable genre/tag or collections list) must not close it.
    function onWindowScroll(e) {
      if (menu.contains(e.target)) return;
      cleanup();
    }
    menu._cleanup = cleanup;

    function renderRows() {
      menu.innerHTML = "";

      const allRow = document.createElement("button");
      allRow.type = "button";
      allRow.textContent = "All favorites";
      allRow.style.cssText =
        `display:block;width:100%;text-align:left;padding:6px 10px;margin-bottom:2px;font-size:11px;border:none;` +
        `border-radius:3px;cursor:pointer;box-sizing:border-box;` +
        `background:${activeId ? "transparent" : "var(--osu-fav-accent)"};color:${activeId ? "#ddd" : "#fff"}`;
      allRow.addEventListener("mouseenter", () => { if (activeId) allRow.style.background = "#242424"; });
      allRow.addEventListener("mouseleave", () => { if (activeId) allRow.style.background = "transparent"; });
      allRow.addEventListener("click", () => { onSelect(""); cleanup(); });
      menu.appendChild(allRow);

      const cols = getCollections();
      const entries = Object.entries(cols).sort((a, b) => a[1].name.localeCompare(b[1].name));

      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "font-size:11px;color:#666;padding:8px 10px;line-height:1.4";
        empty.textContent = "No collections yet — create one below.";
        menu.appendChild(empty);
      }

      entries.forEach(([id, col]) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:4px";

        const selectBtn = document.createElement("button");
        selectBtn.type = "button";
        selectBtn.textContent = `${col.name} (${(col.ids || []).length})`;
        selectBtn.style.cssText =
          `flex:1;min-width:0;text-align:left;padding:6px 10px;font-size:11px;border:none;border-radius:3px;` +
          `cursor:pointer;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
          `background:${activeId === id ? "var(--osu-fav-accent)" : "transparent"};color:${activeId === id ? "#fff" : "#ddd"}`;
        selectBtn.addEventListener("mouseenter", () => { if (activeId !== id) selectBtn.style.background = "#242424"; });
        selectBtn.addEventListener("mouseleave", () => { if (activeId !== id) selectBtn.style.background = "transparent"; });
        selectBtn.addEventListener("click", () => { onSelect(activeId === id ? "" : id); cleanup(); });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.textContent = "\u2715";
        delBtn.title = "Delete collection";
        delBtn.style.cssText =
          "flex-shrink:0;font-size:9px;padding:3px 5px;border:1px solid #333;border-radius:3px;background:transparent;color:#666;cursor:pointer";
        let confirming = false;
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!confirming) {
            confirming = true;
            delBtn.textContent = "Sure?";
            delBtn.style.borderColor = "#e55";
            delBtn.style.color = "#e55";
            setTimeout(() => {
              if (confirming) {
                confirming = false;
                delBtn.textContent = "\u2715";
                delBtn.style.borderColor = "#333";
                delBtn.style.color = "#666";
              }
            }, 3000);
          } else {
            deleteCollection(id);
            if (activeId === id) onSelect("");
            renderRows();
          }
        });

        row.append(selectBtn, delBtn);
        menu.appendChild(row);
      });

      const divider = document.createElement("div");
      divider.style.cssText = "height:1px;background:#333;margin:4px 2px";
      menu.appendChild(divider);

      const newRow = document.createElement("div");
      newRow.style.cssText = "display:flex;gap:4px;padding:4px";
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "New collection...";
      input.style.cssText =
        "flex:1;min-width:0;background:#111;border:1px solid #333;border-radius:3px;color:#ddd;" +
        "font-size:10px;padding:4px 6px;outline:none;box-sizing:border-box";
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") createBtn.click();
      });
      const createBtn = document.createElement("button");
      createBtn.type = "button";
      createBtn.textContent = "Create";
      createBtn.style.cssText =
        "font-size:10px;padding:4px 8px;border:1px solid var(--osu-fav-accent);border-radius:3px;" +
        "background:var(--osu-fav-accent);color:#fff;cursor:pointer;flex-shrink:0";
      createBtn.addEventListener("click", () => {
        const name = input.value.trim();
        if (!name) return;
        createCollection(name);
        input.value = "";
        renderRows();
      });
      newRow.append(input, createBtn);
      menu.appendChild(newRow);
    }
    renderRows();

    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight) top = Math.max(8, rect.top - menuRect.height - 4);
    let left = rect.right - menuRect.width;
    left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
    menu.style.top = top + "px";
    menu.style.left = left + "px";

    setTimeout(() => document.addEventListener("click", onOutsideClick, true), 0);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onWindowScroll, true);
  }

  // ── Per-card "add to collection" popover ──
  // Toggle-style checklist (a map can belong to several collections at once),
  // plus the same inline "new collection" creator as the toolbar selector.
  function showAddToCollectionMenu(anchorEl, mapId, onChange) {
    const existing = document.getElementById("osu-fav-col-menu");
    const reopening = existing && existing._anchor === anchorEl;
    if (existing && existing._cleanup) existing._cleanup();
    if (reopening) return;

    const menu = document.createElement("div");
    menu.id = "osu-fav-col-menu";
    menu._anchor = anchorEl;
    menu.style.cssText =
      "position:fixed;z-index:100002;min-width:180px;max-width:240px;max-height:320px;overflow-y:auto;" +
      "background:#1a1a1a;border:1px solid #333;border-radius:4px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.5);padding:4px;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

    function cleanup() {
      menu.remove();
      document.removeEventListener("click", onOutsideClick, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onWindowScroll, true);
    }
    function onOutsideClick(e) {
      if (menu.contains(e.target)) return;
      cleanup();
    }
    function onKey(e) {
      if (e.key === "Escape") cleanup();
    }
    // Only close on a scroll that moves the menu's anchor out from under it
    // (page/panel scroll) — a scroll *inside* the menu itself (e.g. the
    // scrollable genre/tag or collections list) must not close it.
    function onWindowScroll(e) {
      if (menu.contains(e.target)) return;
      cleanup();
    }
    menu._cleanup = cleanup;

    function renderRows() {
      menu.innerHTML = "";
      const cols = getCollections();
      const entries = Object.entries(cols).sort((a, b) => a[1].name.localeCompare(b[1].name));

      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "font-size:11px;color:#666;padding:8px 10px;line-height:1.4";
        empty.textContent = "No collections yet — create one below.";
        menu.appendChild(empty);
      } else {
        entries.forEach(([id, col]) => {
          const inCol = (col.ids || []).includes(mapId);
          const row = document.createElement("button");
          row.type = "button";
          row.style.cssText =
            "display:flex;align-items:center;gap:6px;width:100%;text-align:left;padding:6px 10px;" +
            "font-size:11px;color:#ddd;background:transparent;border:none;border-radius:3px;cursor:pointer;" +
            "white-space:nowrap;box-sizing:border-box";
          row.addEventListener("mouseenter", () => (row.style.background = "#242424"));
          row.addEventListener("mouseleave", () => (row.style.background = "transparent"));

          const check = document.createElement("span");
          check.textContent = inCol ? "\u2713" : "";
          check.style.cssText = "width:12px;flex-shrink:0;color:var(--osu-fav-accent);font-weight:700";

          const label = document.createElement("span");
          label.textContent = `${col.name} (${(col.ids || []).length})`;
          label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1";

          row.append(check, label);
          row.addEventListener("click", () => {
            toggleMapInCollection(id, mapId);
            renderRows();
            if (onChange) onChange();
          });
          menu.appendChild(row);
        });
      }

      const divider = document.createElement("div");
      divider.style.cssText = "height:1px;background:#333;margin:4px 2px";
      menu.appendChild(divider);

      const newRow = document.createElement("div");
      newRow.style.cssText = "display:flex;gap:4px;padding:4px";
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "New collection...";
      input.style.cssText =
        "flex:1;min-width:0;background:#111;border:1px solid #333;border-radius:3px;color:#ddd;" +
        "font-size:10px;padding:4px 6px;outline:none;box-sizing:border-box";
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") confirmBtn.click();
      });
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.textContent = "Add";
      confirmBtn.style.cssText =
        "font-size:10px;padding:4px 8px;border:1px solid var(--osu-fav-accent);border-radius:3px;" +
        "background:var(--osu-fav-accent);color:#fff;cursor:pointer;flex-shrink:0";
      confirmBtn.addEventListener("click", () => {
        const name = input.value.trim();
        if (!name) return;
        const id = createCollection(name);
        toggleMapInCollection(id, mapId);
        input.value = "";
        renderRows();
        if (onChange) onChange();
      });
      newRow.append(input, confirmBtn);
      menu.appendChild(newRow);
    }
    renderRows();

    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight) top = Math.max(8, rect.top - menuRect.height - 4);
    let left = rect.right - menuRect.width;
    left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
    menu.style.top = top + "px";
    menu.style.left = left + "px";

    setTimeout(() => document.addEventListener("click", onOutsideClick, true), 0);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onWindowScroll, true);
  }

  // ═══ GitHub Gist Backup ═══
  const GIST_FILENAME = "osu-local-favorites-backup.json";
  const GH_TOKEN_KEY = "osu_github_token";
  // ── osu! API v2 (OAuth2 authorization-code) storage keys ──
  const OSU_API_CLIENT_ID_KEY = "osu_api_client_id";
  const OSU_API_CLIENT_SECRET_KEY = "osu_api_client_secret";
  const OSU_API_TOKEN_KEY = "osu_api_token"; // {access,refresh,expires_at}
  const OSU_API_STATE_KEY = "osu_api_oauth_state";
  const OSU_API_USERNAME_KEY = "osu_api_username";
  // The redirect URI users must register on their osu! OAuth application.
  // Must match EXACTLY (scheme/host/path, no trailing slash).
  const OSU_API_REDIRECT_URI = "https://osu.ppy.sh/osu-local-favorites";
  const GH_USERNAME_KEY = "osu_github_username";
  const GH_GIST_ID_KEY = "osu_github_gist_id";
  const GH_GIST_URL_KEY = "osu_github_gist_url";
  const GH_AUTO_BACKUP_KEY = "osu_gist_auto_backup";
  const GH_PRIVACY_KEY = "osu_gist_privacy"; // "private" | "public"
  const GH_LAST_SYNC_KEY = "osu_gist_last_sync";

  function ghApiRequest(method, path, token, body) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === "undefined") {
        reject(new Error("GM_xmlhttpRequest is unavailable"));
        return;
      }
      GM_xmlhttpRequest({
        method,
        url: "https://api.github.com" + path,
        headers: {
          Authorization: "token " + token,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 15000,
        onload: (response) => {
          let json = null;
          try {
            json = JSON.parse(response.responseText);
          } catch (e) { }
          if (response.status >= 200 && response.status < 300) {
            resolve(json);
          } else {
            reject(Object.assign(
              new Error((json && json.message) || ("GitHub error " + response.status)),
              { status: response.status, statusText: response.statusText },
            ));
          }
        },
        onerror: () => reject(Object.assign(new Error("Network error contacting GitHub"), { status: 0 })),
        ontimeout: () => reject(Object.assign(new Error("GitHub request timed out"), { status: 0 })),
      });
    });
  }

  function ghGetUser(token) {
    return ghApiRequest("GET", "/user", token);
  }

  // Looks for a gist already containing our backup filename — lets a
  // reconnect (new browser/device) pick up an existing backup instead of
  // silently creating a duplicate.
  function ghFindExistingGist(token) {
    return ghApiRequest("GET", "/gists?per_page=100", token).then((gists) => {
      if (!Array.isArray(gists)) return null;
      return gists.find((g) => g.files && g.files[GIST_FILENAME]) || null;
    });
  }

  function ghCreateGist(token, favs, isPublic) {
    return ghApiRequest("POST", "/gists", token, {
      description: "osu! Local Favorites backup",
      public: isPublic,
      files: { [GIST_FILENAME]: { content: JSON.stringify(favs, null, 2) } },
    });
  }

  function ghUpdateGist(token, gistId, favs) {
    return ghApiRequest("PATCH", "/gists/" + gistId, token, {
      files: { [GIST_FILENAME]: { content: JSON.stringify(favs, null, 2) } },
    });
  }

  // Fetches and parses the backup file from a gist. Falls back to raw_url
  // when GitHub truncates large file content in the API response.
  function ghGetGistContent(token, gistId) {
    return ghApiRequest("GET", "/gists/" + gistId, token).then((gist) => {
      const file = gist && gist.files && gist.files[GIST_FILENAME];
      if (!file) throw new Error("Backup file not found in gist");
      if (!file.truncated) return JSON.parse(file.content);
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: file.raw_url,
          timeout: 15000,
          onload: (r) => {
            try {
              resolve(JSON.parse(r.responseText));
            } catch (e) {
              reject(new Error("Failed to parse backup data"));
            }
          },
          onerror: () => reject(new Error("Network error fetching backup")),
          ontimeout: () => reject(new Error("Timed out fetching backup")),
        });
      });
    });
  }

  // Pulls a gist id out of either a raw id or a pasted gist URL
  // (https://gist.github.com/user/<id> or the api.github.com form).
  function parseGistId(input) {
    const trimmed = (input || "").trim();
    const hexMatch = trimmed.match(/[0-9a-f]{16,}/i);
    if (hexMatch) return hexMatch[0];
    const parts = trimmed.split(/[/?#]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : trimmed;
  }

  // ═══ osu! API v2 — OAuth2 authorization-code flow ═══
  // Same mechanism standard osu! extensions use: the user creates an OAuth
  // application on their osu! account settings (new OAuth app), enters its
  // Client ID + Client Secret in LOF's settings, and registers exactly
  // https://osu.ppy.sh/osu-local-favorites as the callback URL. The script
  // then drives the full flow itself:
  //   1. osuApiStartAuth()      → navigates to /oauth/authorize with a random state
  //   2. osu! redirects back to /osu-local-favorites?code=…&state=…
  //   3. osuApiHandleOAuthCallback() (runs at document-start) exchanges the
  //      code at /oauth/token, stores access+refresh tokens and wipes the
  //      query string so the user never sees osu!'s 404 page.
  //   4. osuApiGetToken() transparently refreshes via refresh_token grant.
  //
  // All token traffic is same-origin (https://osu.ppy.sh → itself), so plain
  // fetch() works — no GM_xmlhttpRequest / CORS involved.

  function osuApiIsConfigured() {
    return !!(GM_getValue(OSU_API_CLIENT_ID_KEY, "") && GM_getValue(OSU_API_CLIENT_SECRET_KEY, ""));
  }

  function osuApiIsConnected() {
    return !!GM_getValue(OSU_API_TOKEN_KEY, null);
  }

  function osuApiStartAuth() {
    if (!osuApiIsConfigured()) {
      showToast("Enter your Client ID and Secret first");
      return;
    }
    // Random state guards against CSRF on the callback.
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    GM_setValue(OSU_API_STATE_KEY, state);
    const params = new URLSearchParams({
      client_id: GM_getValue(OSU_API_CLIENT_ID_KEY, ""),
      redirect_uri: OSU_API_REDIRECT_URI,
      response_type: "code",
      scope: "public",
      state,
    });
    location.href = "https://osu.ppy.sh/oauth/authorize?" + params.toString();
  }

  function osuApiTokenRequest(body) {
    return fetch("https://osu.ppy.sh/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        Object.assign(
          {
            client_id: Number(GM_getValue(OSU_API_CLIENT_ID_KEY, "")) || GM_getValue(OSU_API_CLIENT_ID_KEY, ""),
            client_secret: GM_getValue(OSU_API_CLIENT_SECRET_KEY, ""),
          },
          body,
        ),
      ),
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.access_token) {
        throw Object.assign(
          new Error(data.error_description || data.error || "token request failed (HTTP " + r.status + ")"),
          { status: r.status, statusText: r.statusText },
        );
      }
      return data;
    });
  }

  function osuApiSaveToken(data) {
    GM_setValue(OSU_API_TOKEN_KEY, {
      access: data.access_token,
      refresh: data.refresh_token || "",
      expires_at: Date.now() + (data.expires_in || 86400) * 1000 - 60000, // refresh 1 min early
    });
  }

  // Returns a Promise<string> with a valid access token. Refreshes (and
  // retries once after a refresh) automatically. Rejects when not configured
  // or when both access and refresh tokens are dead.
  let _osuApiRefreshInFlight = null;
  function osuApiGetToken() {
    if (!osuApiIsConfigured()) return Promise.reject(new Error("osu! API not configured"));
    const tok = GM_getValue(OSU_API_TOKEN_KEY, null);
    if (!tok) return Promise.reject(new Error("osu! API not connected"));
    if (tok.access && Date.now() < tok.expires_at) return Promise.resolve(tok.access);
    if (!tok.refresh) return Promise.reject(new Error("osu! API session expired — reconnect in settings"));
    // Deduplicate concurrent refreshes
    if (!_osuApiRefreshInFlight) {
      _osuApiRefreshInFlight = osuApiTokenRequest({
        grant_type: "refresh_token",
        refresh_token: tok.refresh,
      })
        .then((data) => {
          osuApiSaveToken(data);
          return data.access_token;
        })
        .catch((err) => {
          // Refresh dead → force a clean reconnect
          GM_setValue(OSU_API_TOKEN_KEY, null);
          throw err;
        })
        .finally(() => { _osuApiRefreshInFlight = null; });
    }
    return _osuApiRefreshInFlight;
  }

  // ── Rate limiting / queuing (per https://osu.ppy.sh/docs/index.html) ──
  // osu! asks clients to stay under ~60 requests/minute (≈1/sec), honor
  // Retry-After on HTTP 429, use exponential backoff, and cache responses.
  // All of that is enforced centrally here so every osuApiGet() caller is
  // compliant regardless of where the call originates.
  const OSU_API_MIN_GAP_MS = 1050;        // ≥1s between requests
  let _osuApiQueueTail = Promise.resolve(); // serializes request pacing
  let _osuApiRetryAfterUntil = 0;         // absolute ts while server says wait
  let _osuApiBackoffMs = 0;               // grows exponentially on repeat 429s
  const _osuApiCache = new Map();         // path → response JSON (session cache)
  const OSU_API_CACHE_MAX = 500;

  function _osuApiDelay(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  // Serializes every API call through one queue with ≥OSU_API_MIN_GAP_MS
  // spacing, plus any server-mandated or backoff wait before dispatching.
  function _osuApiGate(fn) {
    const run = () => {
      const now = Date.now();
      const wait = Math.max(
        _osuApiRetryAfterUntil - now,
        _osuApiBackoffMs ? (_osuApiRetryAfterUntil || now) + _osuApiBackoffMs - now : 0,
      );
      return (wait > 0 ? _osuApiDelay(wait) : Promise.resolve()).then(fn);
    };
    const result = _osuApiQueueTail.then(run, run);
    _osuApiQueueTail = result.catch(() => { }).then(() => _osuApiDelay(OSU_API_MIN_GAP_MS));
    return result;
  }

  function osuApiGet(path) {
    const cleanPath = path.replace(/^\//, "");
    // Docs good-practice #4: cache retrieved data and reuse it.
    if (_osuApiCache.has(cleanPath)) return Promise.resolve(_osuApiCache.get(cleanPath));

    const attempt = (isRetry) =>
      osuApiGetToken().then((token) =>
        fetch("https://osu.ppy.sh/api/v2/" + cleanPath, {
          headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        }).then(async (r) => {
          if (r.status === 429) {
            // Honor the server's Retry-After, then apply exponential backoff
            // for any further 429s (docs good-practice #3).
            const raHeader = parseFloat(r.headers.get("Retry-After") || "0");
            if (!isRetry && _osuApiBackoffMs === 0) _osuApiBackoffMs = 2000;
            else _osuApiBackoffMs = Math.min(_osuApiBackoffMs * 2 || 2000, 60000);
            _osuApiRetryAfterUntil = Date.now() + (Number.isFinite(raHeader) && raHeader > 0 ? raHeader * 1000 : _osuApiBackoffMs);
            throw Object.assign(new Error("rate limited by osu! API"), { rateLimited: true });
          }
          _osuApiBackoffMs = 0; // successful window — reset backoff
          if (r.status === 401 && !isRetry) {
            // Access token died early (revoked/password change): drop cached
            // token so the next osuApiGetToken() refreshes, then retry once.
            GM_setValue(OSU_API_TOKEN_KEY, null);
            return attempt(true);
          }
          if (!r.ok) throw Object.assign(
            new Error("osu! API HTTP " + r.status + " for " + cleanPath),
            { status: r.status, statusText: r.statusText },
          );
          return r.json();
        }),
      );

    return _osuApiGate(() => attempt(false)).catch((err) => {
      // One transparent retry after a rate-limit wait has elapsed.
      if (err && err.rateLimited) {
        return _osuApiGate(() => attempt(true)).then((data) => {
          _osuApiCacheSet(cleanPath, data);
          return data;
        });
      }
      throw err;
    }).then((data) => {
      _osuApiCacheSet(cleanPath, data);
      return data;
    });
  }

  function _osuApiCacheSet(path, data) {
    if (!data || typeof data !== "object") return;
    if (_osuApiCache.size >= OSU_API_CACHE_MAX) {
      // Evict oldest inserted entry
      _osuApiCache.delete(_osuApiCache.keys().next().value);
    }
    _osuApiCache.set(path, data);
  }

  function osuApiGetUsername() {
    const cached = GM_getValue(OSU_API_USERNAME_KEY, "");
    if (cached) return Promise.resolve(cached);
    return osuApiGet("/me").then((me) => {
      const name = (me && me.username) || "";
      if (name) GM_setValue(OSU_API_USERNAME_KEY, name);
      return name;
    });
  }

  function osuApiDisconnect() {
    GM_setValue(OSU_API_TOKEN_KEY, null);
    GM_setValue(OSU_API_USERNAME_KEY, "");
    GM_setValue(OSU_API_STATE_KEY, "");
  }

  // Runs once at document-start. If we're back on osu.ppy.sh with ?code= &
  // ?state= from our own authorize redirect, exchange the code before osu!
  // renders its 404 page, then rewrite the URL clean.
  function osuApiHandleOAuthCallback() {
    try {
      const q = new URLSearchParams(location.search);
      const code = q.get("code");
      const state = q.get("state");
      const expected = GM_getValue(OSU_API_STATE_KEY, "");
      if (!code || !state || !expected || state !== expected) return;
      GM_setValue(OSU_API_STATE_KEY, "");
      history.replaceState(null, "", location.pathname); // hide ?code=… immediately
      osuApiTokenRequest({ grant_type: "authorization_code", code, redirect_uri: OSU_API_REDIRECT_URI })
        .then((data) => {
          osuApiSaveToken(data);
          GM_setValue(OSU_API_USERNAME_KEY, "");
          const notify = () => showOsuFavToast("osu! API connected");
          if (document.body) notify(); else document.addEventListener("DOMContentLoaded", notify);
        })
        .catch((err) => {
          const notify = () => reportError("osu! API connect", err);
          if (document.body) notify(); else document.addEventListener("DOMContentLoaded", notify);
        });
    } catch (e) { /* never break page load over this */ }
  }

  // Fetches a beatmapset through the API v2 and normalizes it into LOF's
  // stored-favorite shape (identical fields to getBeatmapDataFromJSON — the
  // website's embedded JSON is basically the same object as the API payload).
  function osuApiFetchBeatmapset(beatmapId) {
    return osuApiGet("/beatmapsets/" + beatmapId).then((bm) => {
      if (!bm || !bm.id) throw new Error("beatmapset not found");
      const sid = String(bm.id);
      return {
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
        favourited_at: new Date().toISOString(),
        is_artist_featured: !!bm.track_id,
        nsfw: !!bm.nsfw,
        preview: "https://b.ppy.sh/preview/" + sid + ".mp3",
      };
    });
  }

  // Creates the backup gist on first run, otherwise updates the linked one.
  // Note: GitHub does not allow flipping a gist's public/private flag after
  // creation, so a privacy change clears GH_GIST_ID_KEY and this naturally
  // creates a fresh gist with the new visibility on the next call.
  function performGistBackup() {
    const token = GM_getValue(GH_TOKEN_KEY, "");
    if (!token) return Promise.reject(new Error("Not connected to GitHub"));
    const favs = getFavorites();
    const gistId = GM_getValue(GH_GIST_ID_KEY, "");
    const isPublic = GM_getValue(GH_PRIVACY_KEY, "private") === "public";

    const p = gistId
      ? ghUpdateGist(token, gistId, favs)
      : ghCreateGist(token, favs, isPublic).then((gist) => {
        GM_setValue(GH_GIST_ID_KEY, gist.id);
        GM_setValue(GH_GIST_URL_KEY, gist.html_url || "");
        return gist;
      });

    return p.then((gist) => {
      GM_setValue(GH_LAST_SYNC_KEY, Date.now());
      return gist;
    });
  }

  // Debounced auto-backup — call this after every favorites mutation.
  // No-ops unless the user has connected GitHub and switched auto-update on.
  // Debouncing avoids hammering the API when several maps are favorited in
  // a row (e.g. the "Favorite all" bulk button).
  let _autoBackupTimer = null;
  function scheduleAutoBackup() {
    const token = GM_getValue(GH_TOKEN_KEY, "");
    const auto = GM_getValue(GH_AUTO_BACKUP_KEY, false);
    if (!token || !auto) return;
    if (_autoBackupTimer) clearTimeout(_autoBackupTimer);
    _autoBackupTimer = setTimeout(() => {
      _autoBackupTimer = null;
      performGistBackup()
        .then(() => {
          showOsuFavToast("Gist backup updated");
          const statusEl = document.getElementById("osu-fav-footer-status");
          if (statusEl && typeof statusEl._refresh === "function") statusEl._refresh();
        })
        .catch((err) => reportError("Gist auto-backup", err));
    }, 4000);
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
      // .beatmap-playcount__title (Most Played rows) is handled alongside
      // the regular panel selectors — its text also carries a trailing
      // "[Difficulty]" and an inline "by Artist" span, both stripped below,
      // since we're favouriting the *set*, not one specific diff.
      let title = "";
      const titleEl = card.querySelector(
        '.beatmapset-panel__main-link, a[class*="main-link"], ' +
        '.beatmapset-panel__title, [class*="beatmapset-panel__title"], ' +
        ".beatmap-playcount__title",
      );
      if (titleEl) {
        const titleClone = titleEl.cloneNode(true);
        titleClone
          .querySelectorAll('.beatmapset-badge, [class*="badge"], i, svg, [class*="title-artist"]')
          .forEach((n) => n.remove());
        title = titleClone.textContent.trim().replace(/\s*\[[^[\]]+\]\s*$/, "").trim();
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
        ".beatmap-playcount__artist", // Most Played rows — text is "by Artist", stripped below
      ]) {
        const el = card.querySelector(sel);
        if (el) {
          artist = el.textContent.replace(/^\s*by\s+/i, "").trim();
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
        ".beatmap-playcount__mapper-link", // Most Played rows — username only, no "mapped by " text to strip
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

    // Walk up from the button and find the smallest ancestor that contains
    // links to exactly one distinct beatmapset id. This works no matter how
    // deeply the beatmapset link is nested inside the card's markup (some
    // layouts — e.g. the Featured Artist track grid — wrap it several levels
    // deep rather than as a direct child), and no matter which wrapper class
    // a given card layout uses, since we no longer depend on ".beatmapset-panel"
    // or a direct-child relationship at all. As soon as an ancestor's links
    // span more than one distinct beatmapset, we've walked past the card
    // boundary into a container shared by multiple cards, so we stop there
    // rather than risk grabbing a neighboring card's id.
    let el = button.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const cls = (el.className || "").toString();
      if (cls.includes("beatmapset-panel__menu")) {
        el = el.parentElement;
        continue;
      }
      const ids = new Set();
      el.querySelectorAll('a[href*="/beatmapsets/"]').forEach((a) => {
        const m = a.href.match(/\/beatmapsets\/(\d+)/);
        if (m) ids.add(m[1]);
      });
      if (ids.size === 1) {
        return { beatmapId: [...ids][0], card: el, pageType: "listing" };
      }
      if (ids.size > 1) break;
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
    const text = (el.textContent || "").toLowerCase().trim();

    // Reject download buttons immediately — never treat them as fav buttons
    if (
      cls.includes("download") ||
      title.includes("download") ||
      text.includes("download") ||
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
    // Guard: only treat a heart-icon button as a fav button when it actually
    // sits in a beatmap context (a beatmapset detail page, or inside a listing
    // card). Hearts also appear on profiles, forums, modding posts, etc., and
    // previously those matched here, then failed id resolution and produced
    // spurious "couldn't resolve a beatmap id" errors.
    const hasBeatmapContext =
      !!getBeatmapId() || !!el.closest(".beatmapset-panel");
    if (!hasBeatmapContext) return false;

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

    // title and text are already declared at top of function — reuse them
    if (title.includes("avourite") || title.includes("avorite")) return true;

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
        el.style.color = "var(--osu-fav-heart-color)";
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

  // ═══ Background enrichment ═══
  // Shared pacing for any sequence of osu! beatmapset detail-page requests —
  // keeps us comfortably under ~60 requests/min regardless of which feature
  // (bulk "Favorite all" import or a full-library re-enrichment) is driving it.
  const ENRICH_RATE_LIMIT_MS = 1000;

  // Persistent queue of beatmapset IDs still missing full metadata (genre/
  // language/tags/source/etc.) — anything favorited from a listing card
  // instead of the beatmapset detail page starts here (see toggleFavorite/
  // "Favorite all" below) and is only removed once enrichBeatmapData()
  // actually succeeds for it.
  //
  // This exists because the previous approach — fire off enrichBeatmapData()
  // once right after favoriting and otherwise forget about it — quietly
  // lost genre/language for a lot of favorites in practice: at the required
  // ~1 req/sec throttle, favoriting even a couple hundred maps in one
  // "Favorite all" run takes minutes to fully enrich, and closing the tab
  // (or just navigating away) partway through abandons whatever hadn't been
  // reached yet, with no record that it was ever incomplete. The queue below
  // survives navigation/reloads and a background drainer (see
  // ensureEnrichDrainerRunning) resumes it automatically wherever the user
  // happens to be browsing, at the same gentle pace, until it's empty.
  const ENRICH_QUEUE_KEY = "osu_enrich_queue";

  function getEnrichQueue() {
    const q = GM_getValue(ENRICH_QUEUE_KEY, []);
    return Array.isArray(q) ? q : [];
  }
  function setEnrichQueue(q) {
    GM_setValue(ENRICH_QUEUE_KEY, q);
  }
  function addToEnrichQueue(id) {
    const q = getEnrichQueue();
    if (!q.includes(id)) {
      q.push(id);
      setEnrichQueue(q);
    }
  }
  function removeFromEnrichQueue(id) {
    const q = getEnrichQueue();
    const idx = q.indexOf(id);
    if (idx !== -1) {
      q.splice(idx, 1);
      setEnrichQueue(q);
    }
  }

  // Fetches the beatmapset detail page and merges full JSON data into storage.
  // Fire-and-forget — card data is stored instantly, this fills in the gaps.
  // Also used standalone by the global re-enrichment feature to refresh
  // fields (tags/source/genre/language/etc.) that may be stale or were saved
  // in an older, differently-normalized format.
  function enrichBeatmapData(beatmapId) {
    // Prefer the osu! API v2 when connected (clean JSON, no HTML parsing,
    // no reliance on the embedded #json-beatmapset element). Falls back to
    // scraping the beatmapset page's embedded JSON when the API isn't set up.
    const useApi = osuApiIsConnected() && osuApiIsConfigured();
    const fetchNormalized = useApi
      ? osuApiFetchBeatmapset(beatmapId)
      : fetch("https://osu.ppy.sh/beatmapsets/" + beatmapId, {
        credentials: "include",
      })
        .then((r) => (r.ok ? r.text() : null))
        .then((html) => {
          if (!html) return null;
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");
          const el = doc.getElementById("json-beatmapset");
          if (!el) return null;
          try {
            const raw = JSON.parse(el.textContent);
            const bm = raw.beatmapset || raw;
            return bm && bm.id ? bm : null;
          } catch (e) {
            return null;
          }
        });

    return Promise.resolve(fetchNormalized)
      .then((bm) => {
        if (!bm) return false;
        const favs = getFavorites();
        const sid = String(bm.id);
        if (!favs[sid]) {
          // Removed before enrichment finished — nothing to fill in, but it's
          // also not "still needing enrichment" anymore, so stop retrying it.
          removeFromEnrichQueue(sid);
          return false;
        }
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
        scheduleAutoBackup();
        removeFromEnrichQueue(sid);
        return true;
      })
      .catch(() => false); // left in the queue — a later drain pass retries it
  }

  // Sequentially enriches a list of IDs with a delay between requests
  function enrichBeatmapsSequential(ids, delayMs = ENRICH_RATE_LIMIT_MS) {
    let i = 0;
    function next() {
      if (i >= ids.length) return;
      enrichBeatmapData(ids[i++]).then(() => setTimeout(next, delayMs));
    }
    setTimeout(next, delayMs);
  }

  // Quietly works through the persistent enrichment queue (see
  // ENRICH_QUEUE_KEY above) in the background, one map per
  // ENRICH_RATE_LIMIT_MS — same throttle as every other enrichment path,
  // just spread across however many page loads it takes instead of
  // requiring one tab to stay open until it's done. Safe to call any time;
  // it's a no-op while a manual "Re-enrich all maps" run is already going
  // (avoids doubling up the request rate), and naturally stops calling
  // itself once the queue is empty or every favorite it names is gone.
  let _enrichDrainerActive = false;
  function ensureEnrichDrainerRunning() {
    if (_enrichDrainerActive) return;
    _enrichDrainerActive = true;

    function drainNext() {
      if (_reenrichRunning) {
        // Manual re-enrichment took over — back off and let it finish;
        // it removes IDs from this same queue as it goes.
        setTimeout(drainNext, ENRICH_RATE_LIMIT_MS);
        return;
      }
      const queue = getEnrichQueue();
      const favs = getFavorites();
      const id = queue.find((qid) => favs[qid]); // skip queued IDs no longer favorited
      if (!id) {
        if (queue.length) setEnrichQueue(queue.filter((qid) => favs[qid]));
        _enrichDrainerActive = false; // queue empty — stop until something re-queues it
        return;
      }
      enrichBeatmapData(id).then(() => setTimeout(drainNext, ENRICH_RATE_LIMIT_MS));
    }
    setTimeout(drainNext, ENRICH_RATE_LIMIT_MS);
  }

  // ═══ Global re-enrichment (Settings → Library Maintenance) ═══
  // Re-fetches every favorited map's full data, one request at a time and
  // rate-limited via ENRICH_RATE_LIMIT_MS. Exposed through a couple of
  // module-level state vars + ID-lookups (rather than closures) so progress
  // keeps rendering correctly even if the settings view is torn down and
  // rebuilt (e.g. re.render on unrelated state changes) while a run is live.
  let _reenrichRunning = false;
  let _reenrichCancelFlag = false;
  let _reenrichDone = 0;
  let _reenrichTotal = 0;

  // Pushes current progress into the Settings panel's progress bar, if it's
  // currently mounted. Safe to call even when the panel/settings view isn't
  // open — the elements simply won't be found and this becomes a no-op.
  function updateReenrichmentUI(finished, cancelled) {
    const btn = document.getElementById("osu-fav-reenrich-btn");
    const progressWrap = document.getElementById("osu-fav-reenrich-progress");
    const bar = document.getElementById("osu-fav-reenrich-bar");
    const text = document.getElementById("osu-fav-reenrich-text");
    const pct = _reenrichTotal ? Math.round((_reenrichDone / _reenrichTotal) * 100) : 0;

    if (progressWrap) progressWrap.style.display = _reenrichRunning || finished || cancelled ? "block" : "none";
    if (bar) bar.style.width = pct + "%";
    if (text) {
      if (cancelled) text.textContent = `Cancelled at ${pct}% (${_reenrichDone}/${_reenrichTotal})`;
      else if (finished) text.textContent = `Done — refreshed ${_reenrichDone}/${_reenrichTotal} maps`;
      else text.textContent = `${pct}% (${_reenrichDone}/${_reenrichTotal})`;
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = _reenrichRunning
        ? "Cancel re-enrichment"
        : `Re-enrich all maps (${Object.keys(getFavorites()).length})`;
    }
  }

  function runGlobalReenrichment() {
    if (_reenrichRunning) return;
    const ids = Object.keys(getFavorites());
    if (ids.length === 0) {
      showOsuFavToast("No favorites to re-enrich");
      return;
    }
    _reenrichRunning = true;
    _reenrichCancelFlag = false;
    _reenrichDone = 0;
    _reenrichTotal = ids.length;
    updateReenrichmentUI(false, false);

    function next(i) {
      if (_reenrichCancelFlag) {
        _reenrichRunning = false;
        updateReenrichmentUI(false, true);
        scheduleAutoBackup();
        return;
      }
      if (i >= ids.length) {
        _reenrichRunning = false;
        updateReenrichmentUI(true, false);
        showOsuFavToast("Re-enrichment complete!");
        scheduleAutoBackup();
        return;
      }
      enrichBeatmapData(ids[i]).then(() => {
        _reenrichDone++;
        updateReenrichmentUI(false, false);
        setTimeout(() => next(i + 1), ENRICH_RATE_LIMIT_MS);
      });
    }
    next(0);
  }

  function cancelGlobalReenrichment() {
    if (_reenrichRunning) _reenrichCancelFlag = true;
  }

  // ═══ Toggle favorite ═══
  function toggleFavorite(beatmapId, card) {
    if (!beatmapId) return null;
    const favs = getFavorites();
    const wasFav = !!favs[beatmapId];
    let needsEnrich = false;

    if (wasFav) {
      delete favs[beatmapId];
      removeFromEnrichQueue(beatmapId); // no longer favorited — stop trying to enrich it
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
    scheduleAutoBackup();
    // Refresh the favorites panel if it's already open
    if (document.getElementById("osu-local-fav-panel")) {
      document.getElementById("osu-local-fav-panel").remove();
      showFavoritesPanel();
    }
    if (needsEnrich) {
      // Persisted first so this survives even if the immediate attempt
      // below doesn't finish before the tab closes/navigates away — the
      // background drainer picks it back up later regardless.
      addToEnrichQueue(beatmapId);
      enrichBeatmapData(beatmapId);
      ensureEnrichDrainerRunning();
    }
    return !wasFav;
  }

  // ═══ Copy-all button ("Favourite Beatmaps" + "Most Played Beatmaps") ═══
  // Both live on a profile's Beatmaps tab and share the same "click show
  // more until it's gone" pagination pattern, but render completely
  // differently under the hood:
  //   • Favourite (data-page-id="beatmaps") — one .beatmapset-panel card
  //     per beatmapset, "show more" carries both the "profile-page" and
  //     "profile-page-beatmapsets" modifier classes.
  //   • Most Played (data-page-id="historical") — one .beatmap-playcount
  //     row per DIFFICULTY the user has played, so the same beatmapset can
  //     show up dozens of times; its "show more" only carries the plain
  //     "profile-page" modifier. getBeatmapDataFromCard() already knows how
  //     to read both row types, and the dedup below (favs[id] already set,
  //     whether from a prior favourite or an earlier row in *this* run)
  //     means a 20-diff mapset only ever gets added once.
  function addFavoriteAllButtons() {
    addFavoriteAllButton({
      pageId: "beatmaps",
      headingMatch: (t) => t.includes("Favourite") || t.includes("Favorite"),
      gridSelector: ".page-extra__beatmapsets.js-audio--group",
      rowSelector: ".beatmapset-panel, .beatmapsets__item",
    });
    addFavoriteAllButton({
      pageId: "historical",
      headingMatch: (t) => t.includes("Most Played"),
      gridSelector: null, // rows sit directly in the page container, no dedicated grid wrapper
      rowSelector: ".beatmap-playcount",
    });
  }

  function addFavoriteAllButton({ pageId, headingMatch, gridSelector, rowSelector }) {
    const container = document.querySelector(`.js-sortable--page[data-page-id="${pageId}"]`);
    if (!container) return;
    const heading = Array.from(
      container.querySelectorAll("h3.title--page-extra-small"),
    ).find((h) => headingMatch(h.textContent || ""));
    if (!heading) return;
    // Guard: don't add the button twice
    if (heading.querySelector(".osu-fav-all-btn")) return;

    const scope = (gridSelector && container.querySelector(gridSelector)) || container;

    const btn = document.createElement("button");
    btn.className = "osu-fav-all-btn";
    btn.textContent = "Favorite all";
    Object.assign(btn.style, {
      marginLeft: "10px",
      padding: "2px 10px",
      fontSize: "11px",
      background: "var(--osu-fav-accent)",
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

      // Click "show more" once and wait for new rows to appear
      function clickShowMoreOnce() {
        return new Promise((resolve) => {
          const showMore = scope.querySelector(".show-more-link--profile-page");
          if (
            !showMore ||
            showMore.offsetParent === null ||
            showMore.disabled
          ) {
            resolve();
            return;
          }
          const before = scope.querySelectorAll(rowSelector).length;
          showMore.click();

          let attempts = 0;
          function check() {
            attempts++;
            const after = scope.querySelectorAll(rowSelector).length;
            const sm = scope.querySelector(".show-more-link--profile-page");
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

      // Recursively click "show more" until everything is loaded
      function loadAllRows() {
        return clickShowMoreOnce().then(() => {
          const sm = scope.querySelector(".show-more-link--profile-page");
          if (sm && sm.offsetParent !== null && !sm.disabled) {
            return loadAllRows();
          }
        });
      }

      loadAllRows()
        .then(() => {
          const favs = getFavorites();
          const rows = scope.querySelectorAll(rowSelector);
          // Use a decreasing base timestamp so top-to-bottom DOM order is preserved
          // (panel sorts by favourited_at descending)
          const baseTime = Date.now();
          let count = 0;
          let alreadyHad = 0;
          const newIds = [];
          rows.forEach((row, i) => {
            const data = getBeatmapDataFromCard(row);
            if (!data) return;
            if (favs[data.id]) {
              // Already favourited before, OR another diff of a set we
              // already added earlier in *this* run — either way, skip it.
              alreadyHad++;
            } else {
              // Subtract i seconds so first row (top) gets newest timestamp
              data.favourited_at = new Date(baseTime - i * 1000).toISOString();
              favs[data.id] = data;
              newIds.push(data.id);
              count++;
            }
          });

          setFavorites(favs);
          updateFloatingHeart();
          scheduleAutoBackup();
          // Refresh the favorites panel if it's already open
          if (document.getElementById("osu-local-fav-panel")) {
            document.getElementById("osu-local-fav-panel").remove();
            showFavoritesPanel();
          }
          // Show matching/skipped count when some were already favorited
          const skippedLabel = alreadyHad > 0
            ? " *[matching " + alreadyHad + "| " + alreadyHad + " not added]"
            : "";
          btn.textContent = "Added " + count + skippedLabel + ", enriching...";
          // Persist the queue first — for a big batch, this run alone can
          // take minutes at the required throttle, and closing the tab
          // partway through used to lose genre/language/tags permanently
          // for whatever hadn't been reached yet. Now the background
          // drainer just resumes where this left off on a later page load.
          newIds.forEach(addToEnrichQueue);
          // Enrich each new beatmapset sequentially — respects ENRICH_RATE_LIMIT_MS
          // (1 request/sec), the same throttle every other bulk/re-enrich path uses.
          enrichBeatmapsSequential(newIds);
          setTimeout(() => {
            btn.textContent = "Favorite all";
            btn.disabled = false;
          }, 3500);
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
    heading.appendChild(btn);
  }

  // ═══ Floating heart — always visible on all osu! pages ═══
  // Visual language matches the rest of LOF's UI (flat dark surface, 1px
  // hairline border, small radius, accent used sparingly) instead of the old
  // generic glowing-circle look.
  const IND_POS_KEY = "osu_fav_ind_pos"; // {right,bottom} px from bottom-right

  function indApplyVisual(ind, fav, dragging) {
    ind.innerHTML = heartSVG(fav);
    ind.style.background = "rgba(17,17,17,0.95)";
    ind.style.border = fav ? "1px solid var(--osu-fav-accent)" : "1px solid #333";
    ind.style.boxShadow = fav ? "0 2px 10px rgba(255,102,170,0.25)" : "none";
    ind.style.opacity = dragging ? "0.85" : "";
  }

  function ensureHeartIndicator() {
    if (document.getElementById("osu-local-fav-ind")) return;

    const ind = document.createElement("div");
    ind.id = "osu-local-fav-ind";
    Object.assign(ind.style, {
      position: "fixed",
      bottom: "40px",
      right: "100px",
      zIndex: "99999",
      width: "42px",
      height: "42px",
      borderRadius: "12px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      transition: "border-color 0.15s ease, opacity 0.15s ease",
      userSelect: "none",
      touchAction: "none",
    });

    // Restore last saved position (drag is persisted across pages/sessions)
    try {
      const saved = GM_getValue(IND_POS_KEY, null);
      if (saved && typeof saved.right === "number" && typeof saved.bottom === "number") {
        // Clamp into the viewport in case the window shrank since saving
        const maxR = Math.max(0, window.innerWidth - 46);
        const maxB = Math.max(0, window.innerHeight - 46);
        ind.style.right = Math.min(Math.max(0, saved.right), maxR) + "px";
        ind.style.bottom = Math.min(Math.max(0, saved.bottom), maxB) + "px";
      }
    } catch (e) { }

    const update = () => {
      const bmid = getBeatmapId();
      const fav = bmid ? isFavorited(bmid) : false;
      indApplyVisual(ind, fav, false);
      // Clicking heart always opens favorites panel
      ind.title = "View local favorites (hold + drag to move)";
    };

    // ── Click vs hold-to-drag ──
    // A short press without movement = click (open panel). Holding for
    // HOLD_MS or moving > MOVE_THRESHOLD px starts a drag; the new position
    // is anchored to bottom/right so it survives resizes, and persisted.
    const HOLD_MS = 250;
    const MOVE_THRESHOLD = 6;
    let pressTimer = null;
    let dragging = false;
    let dragMoved = false;
    let startX = 0, startY = 0, startRight = 0, startBottom = 0;
    let suppressClick = false;

    ind.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      dragging = false;
      dragMoved = false;
      suppressClick = false;
      startX = e.clientX;
      startY = e.clientY;
      startRight = parseFloat(ind.style.right) || 100;
      startBottom = parseFloat(ind.style.bottom) || 40;
      pressTimer = setTimeout(() => {
        dragging = true;
        suppressClick = true;
        ind.setPointerCapture(e.pointerId);
        indApplyVisual(ind, isFavorited(getBeatmapId()) , true);
      }, HOLD_MS);
      e.preventDefault();
    });

    ind.addEventListener("pointermove", (e) => {
      if (!dragging) {
        // Cancel pending drag if the finger/mouse moved before hold elapsed
        if (pressTimer && Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_THRESHOLD) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
        return;
      }
      dragMoved = true;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const right = Math.min(Math.max(0, startRight - dx), Math.max(0, window.innerWidth - ind.offsetWidth));
      const bottom = Math.min(Math.max(0, startBottom - dy), Math.max(0, window.innerHeight - ind.offsetHeight));
      ind.style.right = right + "px";
      ind.style.bottom = bottom + "px";
    });

    const endPress = (e) => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (dragging) {
        dragging = false;
        indApplyVisual(ind, isFavorited(getBeatmapId()), false);
        if (dragMoved) {
          GM_setValue(IND_POS_KEY, {
            right: parseFloat(ind.style.right) || 0,
            bottom: parseFloat(ind.style.bottom) || 0,
          });
          suppressClick = true;
        }
      }
    };
    ind.addEventListener("pointerup", endPress);
    ind.addEventListener("pointercancel", endPress);

    ind.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (suppressClick) { suppressClick = false; return; }
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
      // Inline style wins over osu!'s own stylesheet rules, so our button
      // reads as clearly "ours" rather than an indistinguishable copy of
      // osu!'s native heart.
      heart.style.color = "var(--osu-fav-heart-color)";
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
    indApplyVisual(ind, fav, false);
    updateGuestButtonVisual();
  }

  // ═══ Click interception ═══
  document.addEventListener(
    "click",
    function (e) {
      // Never treat clicks inside our own UI (the favorites panel or the
      // download-mirror popover) as a native-page favourite-button click.
      // isFavButton()'s matching is heuristic (title/class/icon-based) and
      // meant for osu!'s own page elements — it previously misfired on our
      // own "Download ▾" menu, e.g. the "Official Download (requires
      // sign-in)" row, which doesn't carry a "download" title/class, only
      // the word in its visible text. The panel and menu already handle
      // all of their own actions directly (toggleFavorite, removeBtn,
      // showDownloadMenu's row links), so excluding them here entirely is
      // both the fix and the more robust long-term guard.
      if (e.target.closest("#osu-local-fav-panel, #osu-fav-dl-menu")) return;

      // Also intercept clicks on the guest-disabled <span> (not just button/a)
      const button = e.target.closest("button, a, span.beatmapset-panel__menu-item");
      if (!button || !isFavButton(button)) return;

      // As soon as we've identified this as a favorite button, we commit to
      // handling the click ourselves — block osu!'s own click handler
      // unconditionally, even if something below fails. Previously this only
      // happened after beatmap-id resolution succeeded, so a resolution
      // failure would silently fall through to osu!'s real click handler —
      // which our own XHR/fetch interceptor then turns into a broken fake
      // response, since it blindly fakes *any* request to a "/favourites"
      // URL regardless of whether we handled the click. Blocking here always
      // avoids that half-broken passthrough state.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      try {
        const ctx = resolveBeatmapContext(button);
        if (!ctx.beatmapId) {
          // Not an error: isFavButton()'s matching is heuristic, so an
          // occasional false positive can slip past it. Just ignore the click
          // quietly instead of spamming the console and toasting the user.
          console.debug(
            "[osu-local-favorites] ignoring heart-like button without resolvable beatmap id",
            button,
          );
          return;
        }

        const nowFav = toggleFavorite(ctx.beatmapId, ctx.card);
        updateHeartVisual(button, nowFav);

        button.style.transform = "scale(1.2)";
        button.style.transition = "transform 0.1s ease";
        setTimeout(() => {
          button.style.transform = "scale(1)";
        }, 120);
      } catch (err) {
        reportError("Toggle favorite", err);
      }
    },
    true,
  );

  // ═══ Refresh visible buttons ═══
  function refreshButtons() {
    // Cheap short-circuit: isFavButton() only ever returns true for an
    // element on an actual beatmapset detail page or one sitting inside a
    // ".beatmapset-panel" (listing/profile cards) — every other branch in it
    // requires one of those two. On any other page (dashboard, forum, wiki,
    // chat, settings, etc.) that's guaranteed false for literally every
    // element, so skip straight past the expensive "every <button> on the
    // whole page" scan below rather than running it — and the several
    // querySelector/closest calls inside isFavButton() for each one — on
    // totally unrelated pages, every 1.5s and on every DOM mutation, for as
    // long as the tab stays open. This is a pure short-circuit: it changes
    // nothing about which buttons get matched, only skips the work when the
    // page couldn't possibly contain any.
    if (!getBeatmapId() && !document.querySelector(".beatmapset-panel, .beatmapset-panel__menu-item")) {
      return;
    }

    // Also scan disabled <span> elements used when the user is not signed in
    const candidates = document.querySelectorAll(
      "button, span.beatmapset-panel__menu-item",
    );
    candidates.forEach((btn) => {
      if (!isFavButton(btn) || btn.dataset.osuFavChecked) return;
      const ctx = resolveBeatmapContext(btn);
      // Context couldn't be resolved yet — this is common when a card is
      // still mid-render (fast scroll / infinite-load on search & profile
      // pages). Do NOT mark it checked here, or it'll be skipped forever and
      // silently show the wrong (unfavorited) heart state even though it's
      // actually in local favorites — clicking it would then remove it
      // instead of doing nothing. Leave it unmarked so the next pass (mutation
      // observer or periodic fallback) retries once the card has settled.
      if (!ctx.beatmapId) return;
      btn.dataset.osuFavChecked = "1";
      updateHeartVisual(btn, isFavorited(ctx.beatmapId));
      // Make the disabled span look clickable
      if (btn.tagName === "SPAN") {
        btn.style.cursor = "pointer";
        btn.style.opacity = "1";
        btn.style.pointerEvents = "auto";
      }
    });
  }

  // The audio element is deliberately page-lifetime. Closing the favorites panel
  // must only detach the panel UI — never pause/reset the actual preview. This lets
  // previews keep playing while the user closes the panel, switches tabs, or opens
  // another app on mobile. A newly opened panel re-binds its Now Playing controls.
  function clearFavoritesPanelAudio() {
    const audio = window._osuFavAudio;
    if (!audio) return;
    audio._activeBtn = null;
    audio._activeBar = null;
    audio._activeDim = null;
    audio._npBar = null;
    audio._npTitle = null;
    audio._npArtist = null;
    audio._npPlayBtn = null;
    audio._npProgressBar = null;
    // The queue callback closes over this panel's DOM/list, so do not keep it after
    // the panel is gone. Playback itself remains untouched.
    audio._queueAdvance = null;
  }

  // ═══ Favorites panel ═══
  function showFavoritesPanel() {
    const existing = document.getElementById("osu-local-fav-panel");
    if (existing) {
      // The audio element is page-lifetime, while the player UI belongs to the
      // panel. Detach only the old UI binding; never stop the preview when closing.
      clearFavoritesPanelAudio();
      existing.remove();
      return;
    }

    let currentSort = "date",
      sortAsc = false,
      searchQuery = "",
      settingsOpen = false,
      genreFilterState = {}, // { [genreName]: "include" | "exclude" }
      activeCollectionId = ""; // "" = no collection filter (show all)

    // Inject shared styles once — covers scrollbar, slide-down banner, and slide-up prompt
    if (!document.getElementById("osu-fav-panel-style")) {
      const s = document.createElement("style");
      s.id = "osu-fav-panel-style";
      s.textContent =
        "#osu-fav-list::-webkit-scrollbar{width:4px}" +
        "#osu-fav-list::-webkit-scrollbar-thumb{background:#333;border-radius:2px}" +
        "#osu-fav-list::-webkit-scrollbar-thumb:hover{background:var(--osu-fav-accent)}" +
        "#osu-fav-settings::-webkit-scrollbar{width:4px}" +
        "#osu-fav-settings::-webkit-scrollbar-thumb{background:#333;border-radius:2px}" +
        "#osu-fav-settings::-webkit-scrollbar-thumb:hover{background:var(--osu-fav-accent)}" +
        "@keyframes osuFavSlideDown{from{max-height:0;opacity:0;overflow:hidden}to{max-height:50px;opacity:1}}" +
        "@keyframes osuFavSlideUp{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}" +
        "#osu-fav-nowplaying{height:74px!important;min-height:74px!important;max-height:74px!important;flex:0 0 74px!important;padding:8px 12px!important;gap:10px!important;}" +
        "#osu-fav-nowplaying .osu-fav-np-thumb{width:54px!important;height:54px!important;}" +
        "#osu-fav-nowplaying .osu-fav-np-title{font-size:13px!important;line-height:1.3!important;}" +
        "#osu-fav-nowplaying .osu-fav-np-artist{font-size:11px!important;line-height:1.25!important;margin-top:3px!important;}" +
        "#osu-fav-nowplaying .osu-fav-np-controls{gap:5px!important;}" +
        "#osu-fav-nowplaying .osu-fav-np-btn{width:38px!important;height:38px!important;padding:7px!important;}" +
        "#osu-fav-footer-status{height:29px!important;min-height:29px!important;max-height:29px!important;padding:6px 14px!important;line-height:15px!important;}" +
        "#osu-fav-bottom-bar{height:auto!important;min-height:0!important;max-height:none!important;padding-bottom:0!important;}" +
        "@media(max-width:600px){#osu-local-fav-panel>div:first-child{min-height:0!important;max-height:100px!important;box-sizing:border-box!important;overflow:hidden!important;}#osu-local-fav-panel button[title=Settings],#osu-local-fav-panel button[title=Close]{width:34px!important;height:34px!important;min-width:34px!important;min-height:34px!important;max-width:34px!important;max-height:34px!important;padding:0!important;box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:center!important;}#osu-local-fav-panel input[type=text]{height:40px!important;min-height:40px!important;max-height:40px!important;box-sizing:border-box!important;}#osu-fav-nowplaying{height:76px!important;min-height:76px!important;max-height:76px!important;flex:0 0 76px!important;padding:8px 10px!important;gap:8px!important;padding-bottom:8px!important;}#osu-fav-nowplaying .osu-fav-np-thumb{width:50px!important;height:50px!important;}#osu-fav-nowplaying .osu-fav-np-controls{gap:3px!important;}#osu-fav-nowplaying .osu-fav-np-btn{width:34px!important;height:34px!important;padding:6px!important;}#osu-fav-nowplaying .osu-fav-np-title{font-size:12px!important;}#osu-fav-nowplaying .osu-fav-np-artist{font-size:10px!important;}#osu-fav-nowplaying .osu-fav-np-info{min-width:72px!important;}#osu-fav-footer-status{height:28px!important;min-height:28px!important;max-height:28px!important;padding:6px 10px!important;line-height:14px!important;}}";
      document.head.appendChild(s);
    }

    const panel = document.createElement("div");
    panel.id = "osu-local-fav-panel";
    Object.assign(panel.style, {
      position: "fixed",
      top: "0",
      right: "0",
      zIndex: "100000",
      width: "min(360px, 100vw)",
      height: "100vh",
      maxHeight: "100dvh",
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

    // Shows an overlay popup centered inside the panel
    function showPanelUpdateOverlay(latestVersion) {
      if (document.getElementById("osu-fav-update-overlay")) return;
      const dismissed = GM_getValue("osu_dismissed_version", "");
      if (dismissed === latestVersion) return;

      // Backdrop — covers the panel content but not the header
      const backdrop = document.createElement("div");
      backdrop.id = "osu-fav-update-overlay";
      backdrop.style.cssText =
        "position:absolute;inset:0;z-index:10;background:rgba(0,0,0,0.55);" +
        "display:flex;align-items:center;justify-content:center;padding:20px";

      // Card
      const card = document.createElement("div");
      card.style.cssText =
        "width:100%;max-width:280px;background:#111;border:1px solid #333;" +
        "border-radius:4px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.7);" +
        "animation:osuFavSlideUp 0.2s ease-out";

      // Accent header
      const accent = document.createElement("div");
      accent.style.cssText =
        "background:var(--osu-fav-accent);padding:10px 14px;display:flex;align-items:center;" +
        "justify-content:space-between;gap:8px";

      const accentTitle = document.createElement("span");
      accentTitle.style.cssText = "font-size:12px;font-weight:700;color:#fff";
      accentTitle.innerHTML = `Update available — <b>v${latestVersion}</b>`;

      const accentClose = document.createElement("button");
      accentClose.textContent = "✕";
      accentClose.style.cssText =
        "background:none;border:none;color:#fff;cursor:pointer;font-size:13px;" +
        "font-weight:bold;padding:0 2px;opacity:0.8;flex-shrink:0";
      accentClose.addEventListener("mouseenter", () => (accentClose.style.opacity = "1"));
      accentClose.addEventListener("mouseleave", () => (accentClose.style.opacity = "0.8"));
      accentClose.addEventListener("click", () => {
        backdrop.remove();
        GM_setValue("osu_dismissed_version", latestVersion);
      });

      accent.append(accentTitle, accentClose);

      // Body
      const body = document.createElement("div");
      body.style.cssText = "padding:14px;font-size:12px;color:#bbb;line-height:1.5";
      body.innerHTML =
        `<b style="color:#ddd">osu! Local Favorites</b> has a new version ready.<br>` +
        `Install it to get the latest fixes and features.`;

      // Footer
      const foot = document.createElement("div");
      foot.style.cssText =
        "display:flex;justify-content:flex-end;gap:6px;padding:10px 14px;" +
        "border-top:1px solid #222;background:#1a1a1a";

      const laterBtn = document.createElement("button");
      laterBtn.textContent = "Later";
      laterBtn.style.cssText =
        "font-size:10px;padding:4px 10px;border:1px solid #333;border-radius:3px;" +
        "background:transparent;color:#888;cursor:pointer;font-weight:500";
      laterBtn.addEventListener("mouseenter", () => { laterBtn.style.borderColor = "var(--osu-fav-accent)"; laterBtn.style.color = "var(--osu-fav-accent)"; });
      laterBtn.addEventListener("mouseleave", () => { laterBtn.style.borderColor = "#333"; laterBtn.style.color = "#888"; });
      laterBtn.addEventListener("click", () => {
        backdrop.remove();
        GM_setValue("osu_dismissed_version", latestVersion);
      });

      const updateBtn = document.createElement("button");
      updateBtn.textContent = "Update Now";
      updateBtn.style.cssText =
        "font-size:10px;padding:4px 10px;border:none;border-radius:3px;" +
        "background:var(--osu-fav-accent);color:#fff;cursor:pointer;font-weight:600";
      updateBtn.addEventListener("mouseenter", () => (updateBtn.style.background = "var(--osu-fav-accent-dark)"));
      updateBtn.addEventListener("mouseleave", () => (updateBtn.style.background = "var(--osu-fav-accent)"));
      updateBtn.addEventListener("click", () => {
        window.open(
          "https://github.com/starhollow2008/LOF/raw/main/osu-local-favorites.user.js",
          "_blank",
        );
        backdrop.remove();
      });

      foot.append(laterBtn, updateBtn);
      card.append(accent, body, foot);
      backdrop.appendChild(card);
      panel.appendChild(backdrop);
    }

    // ── Header ─────────────────────────────────────────────
    const header = document.createElement("div");
    Object.assign(header.style, {
      padding: "10px 14px 8px",
      background: "#1a1a1a",
      borderBottom: "2px solid var(--osu-fav-accent)",
      flex: "0 0 auto",
      minHeight: "0",
      maxHeight: "110px",
      boxSizing: "border-box",
      overflow: "hidden",
      transition: "height 160ms ease, padding 160ms ease",
    });

    const headerTop = document.createElement("div");
    headerTop.style.cssText =
      "display:flex;align-items:center;gap:8px;margin-bottom:8px;height:34px;min-height:34px;box-sizing:border-box";

    const logoImg = document.createElement("img");
    logoImg.src = "https://raw.githubusercontent.com/starhollow2008/LOF/main/icons/icon48.png";
    logoImg.style.cssText = "width:28px;height:28px;border-radius:50%;flex-shrink:0";
    logoImg.addEventListener("error", () => logoImg.style.display = "none");

    const titleEl = document.createElement("span");
    titleEl.style.cssText = "font-weight:600;font-size:14px;flex:1";
    const countBadge = document.createElement("span");
    countBadge.id = "osu-fav-count";
    countBadge.style.cssText =
      "color:var(--osu-fav-accent);background:rgba(255,102,170,.12);padding:2px 8px;border-radius:10px;font-size:11px;margin-left:6px";
    titleEl.append("Local Favorites", countBadge);

    const settingsBtn = document.createElement("button");
    settingsBtn.textContent = "⚙";
    settingsBtn.title = "Settings";
    settingsBtn.setAttribute("aria-label", "Settings");
    settingsBtn.style.cssText =
      "background:none;border:1px solid #333;color:#999;cursor:pointer;width:34px;height:34px;min-width:34px;min-height:34px;max-width:34px;max-height:34px;padding:0;border-radius:3px;font-size:13px;flex:0 0 34px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;line-height:1";
    settingsBtn.addEventListener("mouseenter", () => {
      if (!settingsOpen) {
        settingsBtn.style.borderColor = "var(--osu-fav-accent)";
        settingsBtn.style.color = "var(--osu-fav-accent)";
      }
    });
    settingsBtn.addEventListener("mouseleave", () => {
      if (!settingsOpen) {
        settingsBtn.style.borderColor = "#333";
        settingsBtn.style.color = "#999";
      }
    });
    settingsBtn.addEventListener("click", () => setView(!settingsOpen));

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.style.cssText =
      "background:none;border:1px solid #333;color:#999;cursor:pointer;width:34px;height:34px;min-width:34px;min-height:34px;max-width:34px;max-height:34px;padding:0;border-radius:3px;font-size:13px;line-height:1;flex:0 0 34px;box-sizing:border-box;display:flex;align-items:center;justify-content:center";
    closeBtn.addEventListener("click", () => {
      clearFavoritesPanelAudio();
      panel.remove();
    });

    headerTop.append(logoImg, titleEl, settingsBtn, closeBtn);

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search title, artist, mapper...";
    searchInput.style.cssText =
      "width:100%;height:40px;min-height:40px;max-height:40px;box-sizing:border-box;padding:6px 10px;background:#111;border:1px solid #333;border-radius:3px;color:#ddd;font-size:12px;outline:none;display:block";
    searchInput.addEventListener(
      "focus",
      () => (searchInput.style.borderColor = "var(--osu-fav-accent)"),
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

    // ── GitHub star notice (shown once, ever, on first panel open) ──
    let githubBanner = null;
    if (!GM_getValue("osu_fav_github_star_shown", false)) {
      GM_setValue("osu_fav_github_star_shown", true);

      githubBanner = document.createElement("div");
      githubBanner.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:8px 14px;background:rgba(255,102,170,.1);" +
        "border-bottom:1px solid var(--osu-fav-accent);flex-shrink:0;animation:osuFavSlideDown 0.3s ease-out";

      const starIcon = document.createElement("span");
      starIcon.textContent = "\u2b50";
      starIcon.style.cssText = "font-size:13px;flex-shrink:0";

      const starLink = document.createElement("a");
      starLink.href = "https://github.com/starhollow2008/LOF";
      starLink.target = "_blank";
      starLink.rel = "noopener";
      starLink.textContent = "Enjoying Local Favorites? Star it on GitHub";
      starLink.style.cssText =
        "flex:1;color:#ddd;text-decoration:none;font-size:11px;line-height:1.4";
      starLink.addEventListener("mouseenter", () => (starLink.style.color = "var(--osu-fav-accent)"));
      starLink.addEventListener("mouseleave", () => (starLink.style.color = "#ddd"));

      const dismissBtn = document.createElement("button");
      dismissBtn.textContent = "\u2715";
      dismissBtn.title = "Dismiss";
      dismissBtn.style.cssText =
        "background:none;border:none;color:#888;cursor:pointer;font-size:12px;padding:2px 4px;flex-shrink:0;line-height:1";
      dismissBtn.addEventListener("mouseenter", () => (dismissBtn.style.color = "var(--osu-fav-accent)"));
      dismissBtn.addEventListener("mouseleave", () => (dismissBtn.style.color = "#888"));
      dismissBtn.addEventListener("click", () => githubBanner.remove());

      githubBanner.append(starIcon, starLink, dismissBtn);
    }

    // ── Toolbar ────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.style.cssText =
      "display:flex;align-items:center;gap:4px;padding:5px 14px;background:#1a1a1a;border-bottom:1px solid #333;flex-shrink:0;flex-wrap:wrap;row-gap:4px";

    const sortGroup = document.createElement("div");
    sortGroup.style.cssText = "display:flex;gap:2px;flex:1;flex-wrap:wrap;row-gap:4px";

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

    // Genre filter — 3-tap cycle per genre: neutral → include (green) →
    // exclude (red) → neutral. Sits at the end of the Date/Title/Artist/Status
    // cluster on the left.
    const genreBtn = document.createElement("button");
    genreBtn.type = "button";
    genreBtn.title = "Filter by genre or tag";
    genreBtn.style.cssText =
      "font-size:10px;font-weight:500;padding:3px 7px;border:1px solid transparent;border-radius:3px;background:transparent;cursor:pointer;user-select:none;color:#666;white-space:nowrap";
    function updateGenreBtn() {
      const active = Object.keys(genreFilterState).length;
      genreBtn.textContent = "Genre" + (active ? ` (${active})` : "") + " \u25be";
      genreBtn.style.background = active ? "var(--osu-fav-accent)" : "transparent";
      genreBtn.style.color = active ? "#fff" : "#666";
      genreBtn.style.borderColor = active ? "var(--osu-fav-accent)" : "transparent";
    }
    updateGenreBtn();
    genreBtn.addEventListener("click", () => {
      showGenreFilterMenu(genreBtn, genreFilterState, (newState) => {
        genreFilterState = newState;
        updateGenreBtn();
        renderList();
      });
    });
    sortGroup.appendChild(genreBtn);

    function updateSortBtns() {
      SORTS.forEach((s) => {
        const btn = sortBtns[s];
        const label = s[0].toUpperCase() + s.slice(1);
        btn.textContent =
          label + (currentSort === s ? (sortAsc ? " ↑" : " ↓") : "");
        btn.style.background = currentSort === s ? "var(--osu-fav-accent)" : "transparent";
        btn.style.color = currentSort === s ? "#fff" : "#666";
        btn.style.borderColor = currentSort === s ? "var(--osu-fav-accent)" : "transparent";
      });
    }

    function makeBtn(label, extraStyle = "") {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = `font-size:10px;padding:3px 7px;border:1px solid #333;border-radius:3px;background:transparent;color:#999;cursor:pointer;${extraStyle}`;
      btn.addEventListener("mouseenter", () => {
        btn.style.borderColor = "var(--osu-fav-accent)";
        btn.style.color = "var(--osu-fav-accent)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.borderColor = "#333";
        btn.style.color = "#999";
      });
      return btn;
    }

    toolbar.appendChild(sortGroup);

    // Collections selector — opposite side of the toolbar from the sort/genre
    // cluster. Picks which collection (if any) the list is filtered to.
    const collectionsBtn = document.createElement("button");
    collectionsBtn.type = "button";
    collectionsBtn.title = "Filter by collection";
    collectionsBtn.style.cssText =
      "font-size:10px;font-weight:500;padding:3px 7px;border:1px solid #333;border-radius:3px;background:transparent;cursor:pointer;user-select:none;color:#999;white-space:nowrap;flex-shrink:0;max-width:130px;overflow:hidden;text-overflow:ellipsis";
    function updateCollectionsBtn() {
      if (!activeCollectionId) {
        collectionsBtn.textContent = "\ud83d\udcc1 Collections \u25be";
        collectionsBtn.style.background = "transparent";
        collectionsBtn.style.color = "#999";
        collectionsBtn.style.borderColor = "#333";
        return;
      }
      const col = getCollections()[activeCollectionId];
      if (!col) {
        activeCollectionId = "";
        updateCollectionsBtn();
        return;
      }
      collectionsBtn.textContent = `\ud83d\udcc1 ${col.name} \u25be`;
      collectionsBtn.style.background = "var(--osu-fav-accent)";
      collectionsBtn.style.color = "#fff";
      collectionsBtn.style.borderColor = "var(--osu-fav-accent)";
    }
    updateCollectionsBtn();
    collectionsBtn.addEventListener("click", () => {
      showCollectionsMenu(collectionsBtn, activeCollectionId, (newId) => {
        activeCollectionId = newId;
        updateCollectionsBtn();
        renderList();
      });
    });
    toolbar.appendChild(collectionsBtn);

    // ── Content area (favorites list + settings view share this space) ──
    const contentArea = document.createElement("div");
    contentArea.style.cssText =
      "flex:1 1 0%;min-height:0;display:flex;flex-direction:column;overflow:hidden;position:relative";

    // ── List ───────────────────────────────────────────────
    const listEl = document.createElement("div");
    listEl.id = "osu-fav-list";
    Object.assign(listEl.style, {
      flex: "1 1 0%",
      minHeight: "0",
      overflowY: "auto",
      padding: "4px 0 58px",
      boxSizing: "border-box",
    });

    // ── Settings view (hidden until the gear button is clicked) ──
    const settingsView = document.createElement("div");
    settingsView.id = "osu-fav-settings";
    settingsView.style.cssText = "flex:1 1 0%;min-height:0;overflow-y:auto;display:none;padding-bottom:42px;box-sizing:border-box";

    contentArea.append(listEl, settingsView);

    // ── Footer — sync status bar, doubles as a shortcut into Settings ──
    const footer = document.createElement("div");
    footer.id = "osu-fav-footer-status";
    footer.style.cssText =
      "width:100%;height:29px;min-height:29px;max-height:29px;box-sizing:border-box;padding:6px 14px;border-top:1px solid #333;background:#1a1a1a;font-size:10px;line-height:15px;color:#555;text-align:center;cursor:pointer;user-select:none;overflow:hidden";
    footer.addEventListener("click", () => setView(true));
    footer.addEventListener("mouseenter", () => (footer.style.color = "var(--osu-fav-accent)"));
    footer.addEventListener("mouseleave", () => (footer.style.color = "#555"));

    function updateFooterStatus() {
      const token = GM_getValue(GH_TOKEN_KEY, "");
      const auto = GM_getValue(GH_AUTO_BACKUP_KEY, false);
      const lastSync = GM_getValue(GH_LAST_SYNC_KEY, 0);
      if (!token) {
        footer.textContent = "⚙ Set up Gist backup in Settings";
      } else if (auto) {
        footer.textContent = lastSync
          ? "Auto-backup on · synced " + formatDate(new Date(lastSync).toISOString())
          : "Auto-backup on · not yet synced";
      } else {
        footer.textContent = lastSync
          ? "Manual backup · synced " + formatDate(new Date(lastSync).toISOString())
          : "Manual backup · not yet synced";
      }
    }
    footer._refresh = updateFooterStatus;

    // ── Now Playing bar — persistent mini-player ─────────────────
    // This intentionally lives as a direct child of the fixed panel rather
    // than inside the scrolling content area. It therefore never moves with
    // the favorites/settings scroll position.
    const nowPlayingBar = document.createElement("div");
    nowPlayingBar.id = "osu-fav-nowplaying";
    nowPlayingBar.style.cssText =
      "display:none;position:relative;align-items:center;gap:9px;padding:7px 14px;" +
      "height:74px;min-height:74px;max-height:74px;box-sizing:border-box;border-top:1px solid #333;" +
      "border-bottom:1px solid #222;background:#1a1a1a;flex:0 0 74px;overflow:hidden;" +
      "box-shadow:0 -3px 12px rgba(0,0,0,.35);margin-top:0;padding-bottom:7px";

    // Album-art backdrop — subtle and blurred, so the bar visually inherits
    // the same artwork as the track without making the controls unreadable.
    const npBg = document.createElement("div");
    npBg.style.cssText =
      "position:absolute;inset:-14px;background-position:center;background-size:cover;" +
      "background-repeat:no-repeat;filter:blur(12px);transform:scale(1.08);opacity:.24;" +
      "pointer-events:none";

    const npBgShade = document.createElement("div");
    npBgShade.style.cssText =
      "position:absolute;inset:0;background:rgba(17,17,17,.64);pointer-events:none;z-index:1";

    // Track thumbnail — this is deliberately a normal img rather than a
    // background-only image, so the current cover remains identifiable.
    const npThumb = document.createElement("img");
    npThumb.alt = "";
    npThumb.className = "osu-fav-np-thumb";
    npThumb.style.cssText =
      "position:relative;z-index:2;width:42px;height:42px;border-radius:3px;object-fit:cover;" +
      "background:#111;display:block;flex-shrink:0;border:1px solid rgba(255,255,255,.08)";
    npThumb.addEventListener("error", () => {
      npThumb.removeAttribute("src");
      npThumb.style.visibility = "hidden";
    });

    const npInfo = document.createElement("div");
    npInfo.className = "osu-fav-np-info";
    npInfo.style.cssText = "position:relative;z-index:2;flex:1;min-width:0;overflow:hidden";
    const npTitle = document.createElement("div");
    npTitle.className = "osu-fav-np-title";
    npTitle.style.cssText =
      "font-size:12px;color:#eee;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.35";
    const npArtist = document.createElement("div");
    npArtist.className = "osu-fav-np-artist";
    npArtist.style.cssText =
      "font-size:10px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;line-height:1.25";
    npInfo.append(npTitle, npArtist);

    const npProgressWrap = document.createElement("div");
    npProgressWrap.style.cssText =
      "position:absolute;left:0;right:0;bottom:0;height:2px;background:#111;overflow:hidden;z-index:4";
    const npProgressBar = document.createElement("div");
    npProgressBar.style.cssText =
      "height:100%;width:0%;background:var(--osu-fav-accent);transition:width .05s linear";
    npProgressWrap.appendChild(npProgressBar);

    const npControls = document.createElement("div");
    npControls.className = "osu-fav-np-controls";
    npControls.style.cssText =
      "position:relative;z-index:2;display:flex;align-items:center;gap:4px;flex-shrink:0";

    function npIconBtn(svgFn, title) {
      const b = document.createElement("button");
      b.className = "osu-fav-np-btn";
      b.type = "button";
      b.title = title;
      b.innerHTML = svgFn();
      b.style.cssText =
        "background:rgba(17,17,17,.46);border:1px solid #333;border-radius:3px;color:#999;cursor:pointer;" +
        "padding:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0";
      b.addEventListener("mouseenter", () => {
        if (!b._active) { b.style.borderColor = "var(--osu-fav-accent)"; b.style.color = "var(--osu-fav-accent)"; }
      });
      b.addEventListener("mouseleave", () => {
        if (!b._active) { b.style.borderColor = "#333"; b.style.color = "#999"; }
      });
      return b;
    }

    function setNpToggleActive(btn, active) {
      btn._active = active;
      btn.style.borderColor = active ? "var(--osu-fav-accent)" : "#333";
      btn.style.color = active ? "var(--osu-fav-accent)" : "#999";
    }

    const npShuffleBtn = npIconBtn(shuffleSVG, "Shuffle");
    const npBackBtn = npIconBtn(prevSVG, "Previous");
    const npPlayBtn = npIconBtn(playSVG, "Play/Pause");
    const npNextBtn = npIconBtn(nextSVG, "Next");
    const npLoopBtn = npIconBtn(loopSVG, "Loop");
    setNpToggleActive(npShuffleBtn, musicShuffleEnabled());
    setNpToggleActive(npLoopBtn, musicLoopEnabled());

    npShuffleBtn.addEventListener("click", () => {
      const on = !musicShuffleEnabled();
      GM_setValue(MUSIC_SHUFFLE_KEY, on);
      setNpToggleActive(npShuffleBtn, on);
    });
    npLoopBtn.addEventListener("click", () => {
      const on = !musicLoopEnabled();
      GM_setValue(MUSIC_LOOP_KEY, on);
      setNpToggleActive(npLoopBtn, on);
    });
    npBackBtn.addEventListener("click", () => queueAdvance(-1));
    npNextBtn.addEventListener("click", () => queueAdvance(1));
    npPlayBtn.addEventListener("click", () => {
      const audio = window._osuFavAudio;
      if (!audio || !audio.src) return;
      if (audio.paused) audio.play();
      else audio.pause();
    });

    npControls.append(npShuffleBtn, npBackBtn, npPlayBtn, npNextBtn, npLoopBtn);
    nowPlayingBar.append(npBg, npBgShade, npThumb, npInfo, npControls, npProgressWrap);

    // Resets whatever card is currently linked to the audio element back to
    // its idle look - shared by the "switch to a different track" path and
    // the natural end-of-track path.
    function resetActiveCardUI(audio) {
      if (audio._activeBtn) {
        audio._activeBtn.innerHTML = playSVG();
        audio._activeBtn._playing = false;
        audio._activeBtn.style.opacity = "var(--osu-fav-idle-opacity, 0.15)";
        audio._activeBtn.style.borderColor = "#333";
        audio._activeBtn.style.color = "#999";
      }
      if (audio._activeBar) {
        audio._activeBar.parentElement.style.display = "none";
        audio._activeBar.style.width = "0%";
      }
      if (audio._activeDim) audio._activeDim.style.background = "rgba(51,51,51,var(--osu-fav-idle-dim, 0))";
      audio._activeBtn = null;
      audio._activeBar = null;
      audio._activeDim = null;
      if (audio._npProgressBar) audio._npProgressBar.style.width = "0%";
    }

    function getPlaybackCover(f, id) {
      const stored = f && f.covers && (
        f.covers.card ||
        f.covers["card@2x"] ||
        f.covers.list ||
        f.covers.cover
      );
      // Older local favorites may not have a stored covers object. Fall back to
      // osu!'s deterministic beatmapset cover URL so the mini-player still gets
      // artwork even for those entries.
      return stored || (id ? `https://assets.ppy.sh/beatmaps/${id}/covers/card.jpg` : "");
    }

    // Starts a track by id/record, linking up whichever card is currently
    // on screen for it (if any - long lists build cards lazily) and the
    // Now Playing bar. `navigated` marks a track reached via Back/Next/
    // auto-next/shuffle rather than a direct click on its own preview
    // button, which is what gates the "skip if not on Hina" check in
    // ensureAudio().
    function startPlayback(id, f, opts = {}) {
      const { navigated = false, direction = 1, skipAttempt = 0 } = opts;
      const audio = ensureAudio();
      resetActiveCardUI(audio);
      audio.pause();

      const previewUrl = previewSourceUrl(id, f.preview || `https://b.ppy.sh/preview/${id}.mp3`);
      audio._queueNavigated = navigated;
      audio._queueDirection = direction;
      audio._queueSkipAttempt = skipAttempt;
      audio._npCurrentId = id;
      audio._npCurrentTitle = f.title || f.title_unicode || "Unknown";
      audio._npCurrentArtist = f.artist || f.artist_unicode || "";

      const playbackCover = getPlaybackCover(f, id);
      if (audio._npThumb) {
        if (playbackCover) {
          audio._npThumb.src = playbackCover;
          audio._npThumb.style.visibility = "visible";
        } else {
          audio._npThumb.removeAttribute("src");
          audio._npThumb.style.visibility = "hidden";
        }
      }
      if (audio._npBg) {
        audio._npBg.style.backgroundImage = playbackCover
          ? 'url("' + playbackCover.replace(/"/g, '\"') + '")'
          : "none";
      }

      const cardEl = listEl.querySelector('[data-fav-id="' + id + '"]');
      if (cardEl) {
        const btn = cardEl.querySelector(".osu-fav-preview-btn");
        const barWrap = cardEl.querySelector(".osu-fav-progress-wrap");
        const bar = cardEl.querySelector(".osu-fav-progress-bar");
        const dim = cardEl.querySelector(".osu-fav-dim-overlay");
        if (btn) {
          audio._activeBtn = btn;
          btn.innerHTML = pauseSVG();
          btn._playing = true;
          btn.style.opacity = "var(--osu-fav-active-opacity, 0.8)";
          btn.style.borderColor = "var(--osu-fav-accent)";
          btn.style.color = "var(--osu-fav-accent)";
        }
        if (barWrap) barWrap.style.display = "block";
        if (bar) { audio._activeBar = bar; bar.style.width = "0%"; }
        if (dim) { audio._activeDim = dim; dim.style.background = "rgba(51,51,51,var(--osu-fav-hover-dim, 0.65))"; }
      }

      if (audio._npBar) {
        audio._npBar.style.display = !settingsOpen ? "flex" : "none";
        if (audio._npTitle) audio._npTitle.textContent = audio._npCurrentTitle;
        if (audio._npArtist) audio._npArtist.textContent = audio._npCurrentArtist;
        if (audio._npProgressBar) audio._npProgressBar.style.width = "0%";
      }

      // Cache lookup is local (IndexedDB) and normally resolves in a few ms,
      // but it's still async - guard against the user navigating to a
      // *different* track while this one is in flight, so a slow lookup
      // can't clobber whatever's playing by the time it resolves.
      const requestedId = id;
      resolveCachedMediaUrl(previewUrl).then((resolvedUrl) => {
        if (audio._npCurrentId !== requestedId) return;
        audio.src = resolvedUrl;
        audio.play().catch(() => {
          resetActiveCardUI(audio);
          if (audio._npBar) audio._npBar.style.display = "none";
        });
      });
    }

    // Moves to the next (direction 1) or previous (direction -1) track in
    // the currently visible, sorted/filtered list. Shuffle picks a random
    // track instead of stepping in order. skipAttempt is only set when
    // we're being called again because the last pick turned out not to be
    // on Hinamizawa - it caps how many times we'll auto-skip in a row so a
    // list with nothing cached doesn't chain into an infinite loop.
    function queueAdvance(direction, opts = {}) {
      const entries = renderList._entries || [];
      if (!entries.length) return;
      const skipAttempt = opts.skipAttempt || 0;
      if (skipAttempt > entries.length) return;

      const audio = ensureAudio();
      const currentIdx = entries.findIndex(([eid]) => eid === audio._npCurrentId);

      let nextIdx;
      if (musicShuffleEnabled() && entries.length > 1) {
        do {
          nextIdx = Math.floor(Math.random() * entries.length);
        } while (nextIdx === currentIdx);
      } else if (currentIdx === -1) {
        nextIdx = direction > 0 ? 0 : entries.length - 1;
      } else {
        nextIdx = (currentIdx + direction + entries.length) % entries.length;
      }

      const [id, f] = entries[nextIdx];
      startPlayback(id, f, { navigated: true, direction, skipAttempt });
    }

    // Wire this panel's Now Playing bar + queue functions into the
    // (page-lifetime, singleton) audio element. The bar itself is mounted
    // directly in this panel's content area, so it never scrolls away with
    // the list/settings view.
    const npAudio = ensureAudio();
    npAudio._npBar = nowPlayingBar;
    npAudio._npTitle = npTitle;
    npAudio._npArtist = npArtist;
    npAudio._npPlayBtn = npPlayBtn;
    npAudio._npProgressBar = npProgressBar;
    npAudio._npThumb = npThumb;
    npAudio._npBg = npBg;
    npAudio._queueAdvance = queueAdvance;

    // Reconcile the freshly-rendered favorite cards with the singleton audio.
    // renderList() can replace the DOM node for the current song while playback
    // is still alive; never let the detached node remain the active UI owner.
    function syncCurrentCardUI() {
      const audio = window._osuFavAudio;
      if (!audio || !audio._npCurrentId) return;
      const cardEl = listEl.querySelector('[data-fav-id="' + audio._npCurrentId + '"]');
      if (!cardEl) return;

      const btn = cardEl.querySelector(".osu-fav-preview-btn");
      const barWrap = cardEl.querySelector(".osu-fav-progress-wrap");
      const bar = cardEl.querySelector(".osu-fav-progress-bar");
      const dim = cardEl.querySelector(".osu-fav-dim-overlay");

      // Clear the old card refs first; then link them to this newly-mounted node.
      audio._activeBtn = btn || null;
      audio._activeBar = bar || null;
      audio._activeDim = dim || null;

      if (btn) {
        const playing = !audio.paused;
        btn.innerHTML = playing ? pauseSVG() : playSVG();
        btn._playing = playing;
        btn.style.opacity = playing
          ? "var(--osu-fav-active-opacity, 0.8)"
          : "var(--osu-fav-idle-opacity, 0.15)";
        btn.style.borderColor = playing ? "var(--osu-fav-accent)" : "#333";
        btn.style.color = playing ? "var(--osu-fav-accent)" : "#999";
      }
      if (barWrap) barWrap.style.display = !audio.paused ? "block" : "none";
      if (bar) {
        const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
        bar.style.width = pct + "%";
      }
      if (dim) {
        dim.style.background = !audio.paused
          ? "rgba(51,51,51,var(--osu-fav-hover-dim, 0.65))"
          : "rgba(51,51,51,var(--osu-fav-idle-dim, 0))";
      }
    }

    if (npAudio.src && npAudio._npCurrentId) {
      nowPlayingBar.style.display = !settingsOpen ? "flex" : "none";
      npTitle.textContent = npAudio._npCurrentTitle || "";
      npArtist.textContent = npAudio._npCurrentArtist || "";
      const currentFav = getFavorites()[npAudio._npCurrentId];
      const currentCover = getPlaybackCover(currentFav, npAudio._npCurrentId);
      if (currentCover) {
        npThumb.src = currentCover;
        npThumb.style.visibility = "visible";
        npBg.style.backgroundImage = 'url("' + currentCover.replace(/"/g, '\"') + '")';
      } else {
        npThumb.removeAttribute("src");
        npThumb.style.visibility = "hidden";
        npBg.style.backgroundImage = "none";
      }
      npPlayBtn.innerHTML = npAudio.paused ? playSVG() : pauseSVG();
      npProgressBar.style.width =
        npAudio.duration ? (npAudio.currentTime / npAudio.duration) * 100 + "%" : "0%";
      syncCurrentCardUI();
    }

    // ── View switching ───────────────────────────────────────
    function setView(showSettings) {
      settingsOpen = showSettings;
      toolbar.style.display = showSettings ? "none" : "flex";
      listEl.style.display = showSettings ? "none" : "block";
      settingsView.style.display = showSettings ? "block" : "none";
      searchInput.style.display = showSettings ? "none" : "block";
      footer.style.display = showSettings ? "block" : "none";
      nowPlayingBar.style.display = !showSettings && npAudio.src && npAudio._npCurrentId ? "flex" : "none";
      bottomBar.setAttribute("data-view", showSettings ? "settings" : "favorites");
      settingsBtn.style.color = showSettings ? "var(--osu-fav-accent)" : "#999";
      settingsBtn.style.borderColor = showSettings ? "var(--osu-fav-accent)" : "#333";
      settingsBtn.title = showSettings ? "Back to favorites" : "Settings";
      if (showSettings) {
        renderSettingsView();
      } else {
        // Returning to the list from Settings rebuilds rows so controls pick
        // up changed settings, then reconnects the current audio track to the
        // newly-created card instead of leaving stale detached DOM refs.
        renderList();
        requestAnimationFrame(syncCurrentCardUI);
      }
    }

    // ── Helpers ────────────────────────────────────────────
    function statusColor(s) {
      return (
        {
          ranked: "#4caf50",
          loved: "var(--osu-fav-accent)",
          qualified: "#4fc3f7",
          approved: "#4caf50",
          pending: "#ff9800",
          wip: "#f44336",
          graveyard: "#666",
          vip: "#f6c243",
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

    // ── Settings view helpers ────────────────────────────────
    function sectionLabel(text) {
      const el = document.createElement("div");
      el.style.cssText =
        "font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--osu-fav-accent);padding:14px 0 8px";
      el.textContent = text;
      return el;
    }

    function divider() {
      const d = document.createElement("div");
      d.style.cssText = "height:1px;background:#222;margin:4px 0";
      return d;
    }

    function settingsRow(labelText, controlEl, subtitleText) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0";
      const left = document.createElement("div");
      left.style.cssText = "flex:1;min-width:0";
      const lbl = document.createElement("div");
      lbl.style.cssText = "font-size:11px;color:#ddd;font-weight:500";
      lbl.textContent = labelText;
      left.appendChild(lbl);
      if (subtitleText) {
        const sub = document.createElement("div");
        sub.style.cssText = "font-size:10px;color:#666;margin-top:2px;line-height:1.4";
        // Usually plain text, but a row can also pass a Node/DocumentFragment
        // (e.g. to embed a real hyperlink inside the subtitle)
        if (typeof subtitleText === "string") sub.textContent = subtitleText;
        else sub.appendChild(subtitleText);
        left.appendChild(sub);
      }
      row.append(left, controlEl);
      return row;
    }

    // Pink pill switch — matches the accent color used throughout the panel
    function makeToggleSwitch(initialOn, onChange) {
      const wrap = document.createElement("button");
      wrap.type = "button";
      let on = initialOn;
      wrap.style.cssText = `position:relative;width:34px;height:18px;border-radius:9px;flex-shrink:0;padding:0;cursor:pointer;border:1px solid ${on ? "var(--osu-fav-accent)" : "#333"};background:${on ? "var(--osu-fav-accent)" : "#222"};transition:background .15s,border-color .15s`;
      const knob = document.createElement("span");
      knob.style.cssText = `position:absolute;top:1px;left:${on ? "17px" : "1px"};width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s`;
      wrap.appendChild(knob);
      wrap.addEventListener("click", () => {
        on = !on;
        wrap.style.background = on ? "var(--osu-fav-accent)" : "#222";
        wrap.style.borderColor = on ? "var(--osu-fav-accent)" : "#333";
        knob.style.left = on ? "17px" : "1px";
        onChange(on);
      });
      return wrap;
    }

    // Two/three-way segmented control — mirrors the sort-button pill style
    function makeSegmented(options, initial, onChange) {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:flex;gap:2px;background:#111;border:1px solid #333;border-radius:3px;padding:2px;flex-shrink:0";
      let current = initial;
      const btns = {};
      options.forEach(({ value, label }) => {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.style.cssText = `font-size:10px;font-weight:500;padding:3px 10px;border:none;border-radius:2px;cursor:pointer;background:${value === current ? "var(--osu-fav-accent)" : "transparent"};color:${value === current ? "#fff" : "#666"}`;
        btn.addEventListener("click", () => {
          if (current === value) return;
          current = value;
          options.forEach((o) => {
            btns[o.value].style.background = o.value === current ? "var(--osu-fav-accent)" : "transparent";
            btns[o.value].style.color = o.value === current ? "#fff" : "#666";
          });
          onChange(current);
        });
        btns[value] = btn;
        wrap.appendChild(btn);
      });
      return wrap;
    }

    // Native <select> for settings with many choices — segmented pills work
    // well for 2-3 options, but a real dropdown scales better once there
    // are this many (every mirror × video variant, plus both Official
    // variants, plus "not set").
    function makeDropdown(options, initial, onChange) {
      const select = document.createElement("select");
      select.style.cssText =
        "background:#111;border:1px solid #333;border-radius:3px;color:#ddd;" +
        "font-size:10px;font-family:inherit;padding:4px 6px;cursor:pointer;flex-shrink:0;max-width:150px";
      options.forEach(({ value, label }) => {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        if (value === initial) o.selected = true;
        select.appendChild(o);
      });
      select.addEventListener("change", () => onChange(select.value));
      return select;
    }

    // 0–100 percentage slider with a live-updating label — used by Appearance
    function makeSlider(initialPct, onChange) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;align-items:center;gap:8px;flex-shrink:0;width:130px";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "100";
      slider.value = String(initialPct);
      slider.style.cssText = "flex:1;min-width:0;accent-color:var(--osu-fav-accent);cursor:pointer";
      const valSpan = document.createElement("span");
      valSpan.style.cssText = "font-size:10px;color:#666;width:32px;text-align:right;flex-shrink:0";
      valSpan.textContent = initialPct + "%";
      slider.addEventListener("input", () => {
        valSpan.textContent = slider.value + "%";
        onChange(Number(slider.value) / 100);
      });
      wrap.append(slider, valSpan);
      return wrap;
    }

    // Color swatch that opens the native picker without letting it hang off
    // the edge of the screen. The panel is docked flush against the right
    // edge of the viewport, so a real <input type="color"> sitting in a
    // settings row only has ~14px of clearance to its right — Chrome anchors
    // the picker popup to the input's own position and doesn't reliably flip
    // it back on screen, so the gradient/RGB fields end up clipped or
    // unreachable. Instead we show a plain, purely decorative swatch box in
    // the row (so the layout looks identical to before) and keep the real
    // functional <input> invisible, teleporting it right next to the swatch
    // just before it opens — offset to the side that actually has room, and
    // clamped so its full footprint always stays on screen.
    function makeColorInput(initialHex, onChange) {
      const swatch = document.createElement("div");
      swatch.style.cssText =
        `width:40px;height:24px;border:1px solid #333;border-radius:3px;cursor:pointer;` +
        `background:${initialHex};flex-shrink:0`;

      const input = document.createElement("input");
      input.type = "color";
      input.value = initialHex;
      input.style.cssText =
        "position:fixed;opacity:0;width:1px;height:1px;padding:0;border:0;pointer-events:none";
      document.body.appendChild(input);

      swatch.addEventListener("click", () => {
        const w = 260, h = 300; // generous estimate of the native picker's footprint
        const rect = swatch.getBoundingClientRect();

        // Prefer opening just to the left of the swatch — the panel is
        // docked to the right edge, so that's almost always where the
        // clearance is. Fall back to the right if there isn't enough room
        // on the left, then clamp either way so it can't run off-screen.
        let left = rect.left - w - 8;
        if (left < 8) left = rect.right + 8;
        left = Math.max(8, Math.min(window.innerWidth - w - 8, left));

        const top = Math.max(8, Math.min(window.innerHeight - h - 8, rect.top));

        input.style.left = left + "px";
        input.style.top = top + "px";
        input.click();
      });

      input.addEventListener("input", () => {
        swatch.style.background = input.value;
        onChange(input.value);
      });

      // The input lives on <body>, independent of the swatch's own position
      // in the settings row — clean it up if the row is ever torn down
      // (e.g. Settings re-rendered) so orphaned inputs don't pile up.
      const cleanup = () => input.remove();
      settingsView.addEventListener("osu-fav-settings-teardown", cleanup, { once: true });

      return swatch;
    }

    // ── Render settings view ─────────────────────────────────
    function renderSettingsView() {
      // Clean up any real <input type="color"> elements a previous render
      // parked on <body> (see makeColorInput) before we rebuild everything.
      settingsView.dispatchEvent(new Event("osu-fav-settings-teardown"));
      settingsView.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.style.cssText = "padding:0 14px 20px";
      // Attach immediately (while still empty) rather than at the end of this
      // function — some sub-sections (e.g. Library Maintenance) sync their
      // initial state via document.getElementById, which only finds nodes
      // that are actually part of the live document tree.
      settingsView.appendChild(wrap);

      // ── Backup & Restore (Export / Import) ──
      wrap.appendChild(sectionLabel("Backup & Restore"));

      const backupRow = document.createElement("div");
      backupRow.style.cssText = "display:flex;gap:6px;padding-bottom:4px";

      const exportBtn = makeBtn("Export JSON", "flex:1;text-align:center;padding:6px");
      const importBtn = makeBtn("Import JSON", "flex:1;text-align:center;padding:6px");
      const importFile = document.createElement("input");
      importFile.type = "file";
      importFile.accept = ".json";
      importFile.style.display = "none";
      backupRow.append(exportBtn, importBtn, importFile);
      wrap.appendChild(backupRow);

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
          scheduleAutoBackup();
          renderList();
          showToast(`Added ${added}. Total: ${Object.keys(existing).length}`);
        } catch (err) {
          reportError("Import backup", err);
        }
        e.target.value = "";
      });

      wrap.appendChild(divider());

      // ── Version / update check ──
      const verLabel = document.createElement("div");
      verLabel.style.cssText = "font-size:10px;color:#666;margin-bottom:6px";
      verLabel.textContent = "Running v" + getCurrentVersion();
      wrap.appendChild(verLabel);

      const checkUpdateBtn = makeBtn("Check for update", "width:100%;box-sizing:border-box;text-align:center;padding:6px;margin-bottom:4px");
      wrap.appendChild(checkUpdateBtn);
      checkUpdateBtn.addEventListener("click", () => {
        checkUpdateBtn.textContent = "Checking...";
        checkUpdateBtn.disabled = true;
        checkVersionUpdate(true)
          .then((latest) => {
            if (latest) {
              showToast("Update available: v" + latest + " — reinstall from the repo to update");
              // Offer a one-click jump to the install URL
              setTimeout(() => {
                window.open(
                  "https://github.com/starhollow2008/LOF/raw/main/osu-local-favorites.user.js",
                  "_blank",
                );
              }, 500);
            } else {
              showToast("You're on the latest version (v" + getCurrentVersion() + ")");
            }
          })
          .catch(() => showToast("Update check failed — try again later"))
          .then(() => {
            checkUpdateBtn.textContent = "Check for update";
            checkUpdateBtn.disabled = false;
          });
      });

      wrap.appendChild(divider());

      // ── osu! API v2 (OAuth) ──
      wrap.appendChild(sectionLabel("osu! API"));

      const apiConnected = osuApiIsConnected();
      if (!apiConnected) {
        const apiHint = document.createElement("div");
        apiHint.style.cssText = "font-size:10px;color:#666;line-height:1.5;margin-bottom:8px";
        apiHint.innerHTML =
          "Connect the official osu! API v2 for reliable metadata enrichment. Create an " +
          '<a href="https://osu.ppy.sh/home/account/edit#new-oauth-app" target="_blank" style="color:var(--osu-fav-accent);text-decoration:none">new OAuth application →</a>' +
          " with callback URL <code style='color:#aaa'>https://osu.ppy.sh/osu-local-favorites</code>, then paste its Client ID and Secret below.";
        wrap.appendChild(apiHint);
      } else {
        const apiStatus = document.createElement("div");
        apiStatus.style.cssText = "font-size:11px;color:#8c8;margin-bottom:6px";
        apiStatus.textContent = "✔ Connected" + (GM_getValue(OSU_API_USERNAME_KEY, "") ? " as " + GM_getValue(OSU_API_USERNAME_KEY, "") : "") + " — enrichment uses the API";
        wrap.appendChild(apiStatus);
      }

      if (!apiConnected) {
        const apiIdInput = document.createElement("input");
        apiIdInput.type = "text";
        apiIdInput.inputMode = "numeric";
        apiIdInput.placeholder = "Client ID";
        apiIdInput.value = GM_getValue(OSU_API_CLIENT_ID_KEY, "");
        const apiSecretInput = document.createElement("input");
        apiSecretInput.type = "password";
        apiSecretInput.placeholder = "Client Secret";
        apiSecretInput.value = GM_getValue(OSU_API_CLIENT_SECRET_KEY, "");
        for (const inp of [apiIdInput, apiSecretInput]) {
          inp.style.cssText = "width:100%;box-sizing:border-box;padding:6px 10px;background:#111;border:1px solid #333;border-radius:3px;color:#ddd;font-size:12px;outline:none;margin-bottom:6px";
          inp.addEventListener("focus", () => (inp.style.borderColor = "var(--osu-fav-accent)"));
          inp.addEventListener("blur", () => (inp.style.borderColor = "#333"));
          wrap.appendChild(inp);
        }

        const apiConnectBtn = makeBtn("Connect osu! API", "width:100%;box-sizing:border-box;text-align:center;padding:6px;margin-bottom:4px");
        wrap.appendChild(apiConnectBtn);
        apiConnectBtn.addEventListener("click", () => {
          const id = apiIdInput.value.trim();
          const secret = apiSecretInput.value.trim();
          if (!id || !secret || Number.isNaN(Number(id))) {
            showToast("Enter a valid numeric Client ID and a Secret");
            return;
          }
          GM_setValue(OSU_API_CLIENT_ID_KEY, id);
          GM_setValue(OSU_API_CLIENT_SECRET_KEY, secret);
          // Redirects to osu!'s authorize page; we resume on /osu-local-favorites?code=…
          osuApiStartAuth();
        });
      } else {
        const apiDisconnectBtn = makeBtn("Disconnect", "width:100%;box-sizing:border-box;text-align:center;padding:6px;margin-bottom:4px;color:#f88");
        wrap.appendChild(apiDisconnectBtn);
        apiDisconnectBtn.addEventListener("click", () => {
          osuApiDisconnect();
          showToast("Disconnected from osu! API");
          renderSettingsView();
        });
      }

      wrap.appendChild(divider());

      // ── GitHub Gist Backup ──
      wrap.appendChild(sectionLabel("GitHub Gist Backup"));

      const token = GM_getValue(GH_TOKEN_KEY, "");
      const username = GM_getValue(GH_USERNAME_KEY, "");

      if (!token) {
        const hint = document.createElement("div");
        hint.style.cssText = "font-size:10px;color:#666;line-height:1.5;margin-bottom:8px";
        hint.innerHTML =
          "Connect a GitHub account to back up your favorites to a Gist. " +
          '<a href="https://github.com/settings/tokens/new?scopes=gist&description=osu%20Local%20Favorites" target="_blank" style="color:var(--osu-fav-accent);text-decoration:none">Create a token →</a>';
        wrap.appendChild(hint);

        const tokenInput = document.createElement("input");
        tokenInput.type = "password";
        tokenInput.placeholder = "Paste a token with 'gist' scope";
        tokenInput.style.cssText =
          "width:100%;box-sizing:border-box;padding:6px 10px;background:#111;border:1px solid #333;border-radius:3px;color:#ddd;font-size:12px;outline:none;margin-bottom:6px";
        tokenInput.addEventListener("focus", () => (tokenInput.style.borderColor = "var(--osu-fav-accent)"));
        tokenInput.addEventListener("blur", () => (tokenInput.style.borderColor = "#333"));
        wrap.appendChild(tokenInput);

        const connectBtn = makeBtn("Connect GitHub", "width:100%;box-sizing:border-box;text-align:center;padding:6px");
        wrap.appendChild(connectBtn);

        connectBtn.addEventListener("click", () => {
          const t = tokenInput.value.trim();
          if (!t) {
            showToast("Enter a token first");
            return;
          }
          connectBtn.textContent = "Connecting...";
          connectBtn.disabled = true;
          ghGetUser(t)
            .then((user) => {
              GM_setValue(GH_TOKEN_KEY, t);
              GM_setValue(GH_USERNAME_KEY, user.login);
              return ghFindExistingGist(t).then((found) => {
                if (found) {
                  GM_setValue(GH_GIST_ID_KEY, found.id);
                  GM_setValue(GH_GIST_URL_KEY, found.html_url || "");
                  showToast("Connected — linked existing backup gist");
                } else {
                  showToast("Connected as " + user.login);
                }
              });
            })
            .catch((err) => reportError("GitHub connect", err))
            .then(() => {
              renderSettingsView();
              updateFooterStatus();
            });
        });
      } else {
        const statusRow = document.createElement("div");
        statusRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:10px";
        const dot = document.createElement("span");
        dot.style.cssText = "width:6px;height:6px;border-radius:50%;background:#4caf50;flex-shrink:0";
        const statusText = document.createElement("span");
        statusText.style.cssText = "font-size:11px;color:#ddd;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        statusText.textContent = "Connected as " + (username || "GitHub user");
        const disconnectBtn = makeBtn("Disconnect");
        statusRow.append(dot, statusText, disconnectBtn);
        wrap.appendChild(statusRow);

        disconnectBtn.addEventListener("click", () => {
          GM_setValue(GH_TOKEN_KEY, "");
          GM_setValue(GH_USERNAME_KEY, "");
          GM_setValue(GH_AUTO_BACKUP_KEY, false);
          showToast("Disconnected from GitHub");
          renderSettingsView();
          updateFooterStatus();
        });

        const autoOn = GM_getValue(GH_AUTO_BACKUP_KEY, false);
        const autoToggle = makeToggleSwitch(autoOn, (on) => {
          GM_setValue(GH_AUTO_BACKUP_KEY, on);
          showToast(on ? "Auto-backup enabled" : "Switched to manual backup");
          updateFooterStatus();
          if (on) scheduleAutoBackup();
        });
        wrap.appendChild(
          settingsRow("Auto-update", autoToggle, "Automatically push newly added maps to the Gist"),
        );

        const privacy = GM_getValue(GH_PRIVACY_KEY, "private");
        const privacyControl = makeSegmented(
          [
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ],
          privacy,
          (val) => {
            GM_setValue(GH_PRIVACY_KEY, val);
            const existingGistId = GM_getValue(GH_GIST_ID_KEY, "");
            if (existingGistId) {
              GM_setValue(GH_GIST_ID_KEY, "");
              GM_setValue(GH_GIST_URL_KEY, "");
              showToast("Visibility changed — a new gist will be created on next backup");
              renderSettingsView();
            }
          },
        );
        wrap.appendChild(
          settingsRow("Gist visibility", privacyControl, "GitHub can't change visibility later, so switching creates a new gist"),
        );

        const actionRow = document.createElement("div");
        actionRow.style.cssText = "display:flex;gap:6px;margin-top:10px";
        const backupNowBtn = makeBtn("Backup now", "flex:1;text-align:center;padding:6px");
        const restoreBtn = makeBtn("Restore from Gist", "flex:1;text-align:center;padding:6px");
        const gistIdNow = GM_getValue(GH_GIST_ID_KEY, "");
        if (!gistIdNow) restoreBtn.style.opacity = "0.5";
        actionRow.append(backupNowBtn, restoreBtn);
        wrap.appendChild(actionRow);

        backupNowBtn.addEventListener("click", () => {
          backupNowBtn.textContent = "Backing up...";
          backupNowBtn.disabled = true;
          performGistBackup()
            .then(() => {
              showToast("Backup complete!");
              updateFooterStatus();
              renderSettingsView();
            })
            .catch((err) => reportError("Gist backup", err))
            .then(() => {
              backupNowBtn.disabled = false;
              backupNowBtn.textContent = "Backup now";
            });
        });

        restoreBtn.addEventListener("click", () => {
          const gistId = GM_getValue(GH_GIST_ID_KEY, "");
          if (!gistId) {
            showToast("No backup gist linked yet — run a backup first");
            return;
          }
          restoreBtn.textContent = "Restoring...";
          restoreBtn.disabled = true;
          ghGetGistContent(token, gistId)
            .then((data) => {
              if (typeof data !== "object" || Array.isArray(data))
                throw new Error("Malformed backup data");
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
              showToast(`Restored ${added} maps from Gist backup`);
            })
            .catch((err) => reportError("Gist restore", err))
            .then(() => {
              restoreBtn.disabled = false;
              restoreBtn.textContent = "Restore from Gist";
            });
        });

        const fetchRow = document.createElement("div");
        fetchRow.style.cssText = "display:flex;gap:6px;margin-top:6px";
        const fetchInput = document.createElement("input");
        fetchInput.type = "text";
        fetchInput.placeholder = "Gist ID or URL";
        fetchInput.style.cssText =
          "flex:1;min-width:0;box-sizing:border-box;padding:6px 10px;background:#111;" +
          "border:1px solid #333;border-radius:3px;color:#ddd;font-size:11px;outline:none";
        fetchInput.addEventListener("focus", () => (fetchInput.style.borderColor = "var(--osu-fav-accent)"));
        fetchInput.addEventListener("blur", () => (fetchInput.style.borderColor = "#333"));
        const fetchBtn = makeBtn("Fetch", "flex-shrink:0;padding:6px 12px");
        fetchRow.append(fetchInput, fetchBtn);
        wrap.appendChild(fetchRow);

        const fetchHint = document.createElement("div");
        fetchHint.style.cssText = "font-size:10px;color:#666;margin-top:4px;line-height:1.4";
        fetchHint.textContent =
          "Pull from any gist — your own or someone else's shared list — without " +
          "changing what Backup now targets. Handy on a new device before your first backup.";
        wrap.appendChild(fetchHint);

        fetchBtn.addEventListener("click", () => {
          const raw = fetchInput.value.trim();
          if (!raw) {
            showToast("Paste a gist ID or URL first");
            return;
          }
          const gistId = parseGistId(raw);
          fetchBtn.textContent = "Fetching...";
          fetchBtn.disabled = true;
          ghGetGistContent(token, gistId)
            .then((data) => {
              if (typeof data !== "object" || Array.isArray(data))
                throw new Error("Malformed backup data");
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
              scheduleAutoBackup();
              renderList();
              fetchInput.value = "";
              showToast(`Fetched — added ${added} maps`);
            })
            .catch((err) => reportError("Gist fetch", err))
            .then(() => {
              fetchBtn.disabled = false;
              fetchBtn.textContent = "Fetch";
            });
        });

        const gistUrl = GM_getValue(GH_GIST_URL_KEY, "");
        const lastSync = GM_getValue(GH_LAST_SYNC_KEY, 0);
        const syncInfo = document.createElement("div");
        syncInfo.style.cssText =
          "font-size:10px;color:#666;margin-top:8px;display:flex;justify-content:space-between;align-items:center;gap:8px";
        const syncText = document.createElement("span");
        syncText.textContent = lastSync
          ? "Last synced " + formatDate(new Date(lastSync).toISOString())
          : "Not yet synced";
        syncInfo.appendChild(syncText);
        if (gistUrl) {
          const viewLink = document.createElement("a");
          viewLink.href = gistUrl;
          viewLink.target = "_blank";
          viewLink.textContent = "View on GitHub →";
          viewLink.style.cssText = "color:var(--osu-fav-accent);text-decoration:none;flex-shrink:0";
          syncInfo.appendChild(viewLink);
        }
        wrap.appendChild(syncInfo);
      }

      wrap.appendChild(divider());

      // ── Download Mirrors ──
      wrap.appendChild(sectionLabel("Download Mirrors"));
      const mirrorHint = document.createElement("div");
      mirrorHint.style.cssText = "font-size:10px;color:#666;line-height:1.5;margin-bottom:4px";
      mirrorHint.textContent =
        "osu!'s own download requires being signed in, and some maps have downloads " +
        "disabled entirely. Enable mirrors below to download anyway — they're offered " +
        "on the Download button in this panel and injected on beatmap pages.";
      wrap.appendChild(mirrorHint);
      MIRRORS.forEach((mirror) => {
        const toggle = makeToggleSwitch(isMirrorEnabled(mirror), (on) => {
          GM_setValue(mirror.settingKey, on);
        });
        wrap.appendChild(settingsRow(mirror.label, toggle));
      });

      const defaultMirrorControl = makeDropdown(
        [{ value: "", label: "Not set — show options" }, ...getAllDownloadDestinations().map((d) => ({ value: d.key, label: d.label }))],
        GM_getValue(DL_DEFAULT_MIRROR_KEY, ""),
        (val) => GM_setValue(DL_DEFAULT_MIRROR_KEY, val),
      );
      wrap.appendChild(
        settingsRow(
          "Default download mirror",
          defaultMirrorControl,
          "Skips the dropdown and downloads straight from this source. Falls back to showing the dropdown if it's disabled or unavailable (e.g. Official while signed out).",
        ),
      );

      const videoPrefControl = makeSegmented(
        [
          { value: "video", label: "With video" },
          { value: "novideo", label: "No video" },
        ],
        GM_getValue(DL_VIDEO_PREF_KEY, "video"),
        (val) => GM_setValue(DL_VIDEO_PREF_KEY, val),
      );
      wrap.appendChild(
        settingsRow("Preferred video option", videoPrefControl, "Only reorders — every option stays available in the dropdown"),
      );

      const sourcePrefControl = makeSegmented(
        [
          { value: "official", label: "Official first" },
          { value: "mirrors", label: "Mirrors first" },
        ],
        GM_getValue(DL_SOURCE_PREF_KEY, "official"),
        (val) => GM_setValue(DL_SOURCE_PREF_KEY, val),
      );
      wrap.appendChild(
        settingsRow("Preferred source order", sourcePrefControl, "Guests always see mirrors first — Official won't work without signing in"),
      );

      wrap.appendChild(divider());

      // ── Music Playback ──
      wrap.appendChild(sectionLabel("Music Playback"));
      const fullSongHint = document.createElement("div");
      fullSongHint.style.cssText = "font-size:10px;color:#666;line-height:1.5;margin-bottom:4px";
      fullSongHint.textContent =
        "The ▶ preview button in this panel plays osu!'s own ~10s clip by default. " +
        "Hinamizawa's music mirror streams the full track instead whenever it has one " +
        "cached, and falls back to that same clip automatically when it doesn't.";
      wrap.appendChild(fullSongHint);
      const fullSongToggle = makeToggleSwitch(fullSongPreviewsEnabled(), (on) => {
        GM_setValue(PREVIEW_FULLSONG_KEY, on);
      });
      const fullSongSubtitle = document.createDocumentFragment();
      const hinaLink = document.createElement("a");
      hinaLink.href = "https://mirror.hinamizawa.ai";
      hinaLink.target = "_blank";
      hinaLink.rel = "noopener";
      hinaLink.textContent = "mirror.hinamizawa.ai";
      hinaLink.style.cssText = "color:var(--osu-fav-accent);text-decoration:none";
      hinaLink.addEventListener("mouseenter", () => (hinaLink.style.textDecoration = "underline"));
      hinaLink.addEventListener("mouseleave", () => (hinaLink.style.textDecoration = "none"));
      fullSongSubtitle.append("Streams from ", hinaLink, " - no login required");
      wrap.appendChild(settingsRow("Full-length previews", fullSongToggle, fullSongSubtitle));

      const loopToggle = makeToggleSwitch(musicLoopEnabled(), (on) => {
        GM_setValue(MUSIC_LOOP_KEY, on);
      });
      wrap.appendChild(
        settingsRow("Loop track", loopToggle, "Replays the current song instead of stopping when it ends"),
      );

      const autoNextToggle = makeToggleSwitch(musicAutoNextEnabled(), (on) => {
        GM_setValue(MUSIC_AUTONEXT_KEY, on);
      });
      wrap.appendChild(
        settingsRow("Auto next", autoNextToggle, "Plays the next favorite automatically when a track ends - ignored while Loop track is on"),
      );

      const shuffleToggle = makeToggleSwitch(musicShuffleEnabled(), (on) => {
        GM_setValue(MUSIC_SHUFFLE_KEY, on);
      });
      wrap.appendChild(
        settingsRow("Shuffle", shuffleToggle, "Picks the next favorite at random instead of going in list order"),
      );

      const volumeSlider = makeSlider(musicVolumePct(), (frac) => {
        const pct = Math.round(frac * 100);
        GM_setValue(MUSIC_VOLUME_KEY, pct);
        // Applied immediately to whatever's already playing, not just future
        // playback — the audio element is a tab-lifetime singleton, so
        // without this the change wouldn't take effect until the next track.
        if (window._osuFavAudio) window._osuFavAudio.volume = frac;
      });
      wrap.appendChild(
        settingsRow("Preview volume", volumeSlider, "Applies to both the panel's preview player and the Now Playing bar"),
      );

      wrap.appendChild(divider());

      // ── Media Cache ──
      wrap.appendChild(sectionLabel("Media Cache"));
      const cacheHint = document.createElement("div");
      cacheHint.style.cssText = "font-size:10px;color:#666;line-height:1.5;margin-bottom:4px";
      cacheHint.textContent =
        "Background covers and preview clips are stored locally so reloading the page or " +
        "reopening the panel doesn't re-request them. \"Never\" turns this off entirely; " +
        "\"Always\" keeps a cached copy until you clear it below.";
      wrap.appendChild(cacheHint);

      const cacheDurationControl = makeDropdown(
        [
          { value: "custom", label: "Custom..." },
          { value: "30min", label: "30 minutes" },
          { value: "1h", label: "1 hour" },
          { value: "6h", label: "6 hours" },
          { value: "12h", label: "12 hours" },
          { value: "24h", label: "24 hours" },
          { value: "1week", label: "1 week" },
          { value: "1month", label: "1 month" },
          { value: "always", label: "Always" },
          { value: "never", label: "Never" },
        ],
        cacheDurationMode(),
        (val) => {
          GM_setValue(CACHE_DURATION_KEY, val);
          renderSettingsView(); // reveal/hide the custom-minutes row below
        },
      );
      wrap.appendChild(
        settingsRow(
          "Cache duration",
          cacheDurationControl,
          "How long a cached cover/preview stays valid before it's re-fetched",
        ),
      );

      if (cacheDurationMode() === "custom") {
        const customInput = document.createElement("input");
        customInput.type = "number";
        customInput.min = "1";
        customInput.step = "1";
        customInput.value = String(cacheCustomMinutes());
        customInput.style.cssText =
          "width:70px;background:#111;border:1px solid #333;border-radius:3px;color:#ddd;" +
          "font-size:10px;font-family:inherit;padding:4px 6px;flex-shrink:0";
        customInput.addEventListener("change", () => {
          const n = Math.max(1, Math.round(Number(customInput.value) || 60));
          customInput.value = String(n);
          GM_setValue(CACHE_CUSTOM_MINUTES_KEY, n);
        });
        wrap.appendChild(settingsRow("Custom duration (minutes)", customInput));
      }

      const cacheStatsText = document.createElement("div");
      cacheStatsText.style.cssText = "font-size:10px;color:#666;margin:4px 0 8px";
      cacheStatsText.textContent = "Checking cache size…";
      wrap.appendChild(cacheStatsText);
      cacheStats().then(({ count, bytes }) => {
        cacheStatsText.textContent = count
          ? `${count} item${count === 1 ? "" : "s"} cached, ${formatCacheBytes(bytes)}`
          : "Nothing cached yet";
      });

      const clearCacheBtn = makeBtn("Clear cache", "width:100%;box-sizing:border-box;text-align:center;padding:6px");
      clearCacheBtn.addEventListener("click", () => {
        clearCacheBtn.disabled = true;
        clearCacheBtn.textContent = "Clearing…";
        cacheClearAll().then(() => {
          clearCacheBtn.disabled = false;
          clearCacheBtn.textContent = "Clear cache";
          cacheStatsText.textContent = "Nothing cached yet";
        });
      });
      wrap.appendChild(clearCacheBtn);

      wrap.appendChild(divider());

      // ── Appearance ──
      wrap.appendChild(sectionLabel("Appearance"));
      const theme = getThemeSettings();

      const colorSwatch = makeColorInput(theme.accent, (hex) => {
        GM_setValue(THEME_ACCENT_KEY, hex);
        applyTheme();
      });
      wrap.appendChild(settingsRow("Accent color", colorSwatch));

      const heartColorSwatch = makeColorInput(theme.heartColor, (hex) => {
        GM_setValue(THEME_HEART_KEY, hex);
        applyTheme();
      });
      wrap.appendChild(
        settingsRow(
          "Heart fill color",
          heartColorSwatch,
          "Independent of accent — keeps our heart distinct from osu!'s own",
        ),
      );

      wrap.appendChild(
        settingsRow(
          "Play button idle opacity",
          makeSlider(Math.round(theme.idleOpacity * 100), (v) => {
            GM_setValue(THEME_IDLE_OPACITY_KEY, v);
            applyTheme();
          }),
        ),
      );
      wrap.appendChild(
        settingsRow(
          "Cover dim on idle",
          makeSlider(Math.round(theme.idleDim * 100), (v) => {
            GM_setValue(THEME_IDLE_DIM_KEY, v);
            applyTheme();
          }),
          "Baseline darkening on cover art before you hover — 0 leaves it untouched",
        ),
      );
      wrap.appendChild(
        settingsRow(
          "Cover dim on hover",
          makeSlider(Math.round(theme.hoverDim * 100), (v) => {
            GM_setValue(THEME_HOVER_DIM_KEY, v);
            applyTheme();
          }),
        ),
      );
      wrap.appendChild(
        settingsRow(
          "Play button active opacity",
          makeSlider(Math.round(theme.activeOpacity * 100), (v) => {
            GM_setValue(THEME_ACTIVE_OPACITY_KEY, v);
            applyTheme();
          }),
        ),
      );

      const resetThemeBtn = makeBtn(
        "Reset appearance to defaults",
        "width:100%;box-sizing:border-box;text-align:center;padding:6px;margin-top:6px",
      );
      resetThemeBtn.addEventListener("click", () => {
        GM_setValue(THEME_ACCENT_KEY, THEME_DEFAULTS.accent);
        GM_setValue(THEME_HEART_KEY, THEME_DEFAULTS.heartColor);
        GM_setValue(THEME_IDLE_OPACITY_KEY, THEME_DEFAULTS.idleOpacity);
        GM_setValue(THEME_IDLE_DIM_KEY, THEME_DEFAULTS.idleDim);
        GM_setValue(THEME_HOVER_DIM_KEY, THEME_DEFAULTS.hoverDim);
        GM_setValue(THEME_ACTIVE_OPACITY_KEY, THEME_DEFAULTS.activeOpacity);
        applyTheme();
        renderSettingsView();
      });
      wrap.appendChild(resetThemeBtn);

      wrap.appendChild(divider());

      // ── Library Maintenance ──
      wrap.appendChild(sectionLabel("Library Maintenance"));
      const maintHint = document.createElement("div");
      maintHint.style.cssText = "font-size:10px;color:#666;line-height:1.5;margin-bottom:8px";
      maintHint.textContent =
        "Re-fetches full metadata — tags, source, genre, language, BPM, status, cover — " +
        "for every favorited map. Useful if fields look stale or were saved in an older, " +
        "differently-formatted version. Runs one map at a time to respect osu!'s rate limits.";
      wrap.appendChild(maintHint);

      const queueLen = getEnrichQueue().length;
      if (queueLen > 0) {
        const queueNote = document.createElement("div");
        queueNote.style.cssText = "font-size:10px;color:var(--osu-fav-accent);line-height:1.5;margin-bottom:8px";
        queueNote.textContent =
          `${queueLen} map${queueLen === 1 ? "" : "s"} missing genre/tags/language — ` +
          "filling in automatically in the background as you browse (no need to run the button below for these).";
        wrap.appendChild(queueNote);
      }

      const reenrichBtn = document.createElement("button");
      reenrichBtn.id = "osu-fav-reenrich-btn";
      reenrichBtn.style.cssText =
        "font-size:10px;padding:6px 10px;border:1px solid #333;border-radius:3px;background:transparent;color:#999;cursor:pointer;width:100%;box-sizing:border-box";
      reenrichBtn.addEventListener("mouseenter", () => {
        if (!_reenrichRunning) {
          reenrichBtn.style.borderColor = "var(--osu-fav-accent)";
          reenrichBtn.style.color = "var(--osu-fav-accent)";
        }
      });
      reenrichBtn.addEventListener("mouseleave", () => {
        if (!_reenrichRunning) {
          reenrichBtn.style.borderColor = "#333";
          reenrichBtn.style.color = "#999";
        }
      });
      reenrichBtn.addEventListener("click", () => {
        if (_reenrichRunning) cancelGlobalReenrichment();
        else runGlobalReenrichment();
      });
      wrap.appendChild(reenrichBtn);

      const reenrichProgress = document.createElement("div");
      reenrichProgress.id = "osu-fav-reenrich-progress";
      reenrichProgress.style.cssText = "display:none;margin-top:8px";
      const reenrichBarTrack = document.createElement("div");
      reenrichBarTrack.style.cssText = "height:4px;background:#333;border-radius:2px;overflow:hidden";
      const reenrichBar = document.createElement("div");
      reenrichBar.id = "osu-fav-reenrich-bar";
      reenrichBar.style.cssText = "height:100%;width:0%;background:var(--osu-fav-accent);border-radius:2px;transition:width .2s";
      reenrichBarTrack.appendChild(reenrichBar);
      const reenrichText = document.createElement("div");
      reenrichText.id = "osu-fav-reenrich-text";
      reenrichText.style.cssText = "font-size:10px;color:#666;margin-top:4px;text-align:center";
      reenrichProgress.append(reenrichBarTrack, reenrichText);
      wrap.appendChild(reenrichProgress);

      // Sync button label/progress bar to the real state in case a run is
      // already in flight (e.g. started, then user switched view and back)
      updateReenrichmentUI(false, false);

      wrap.appendChild(divider());

      // ── Danger Zone ──
      wrap.appendChild(sectionLabel("Danger Zone"));
      const removeAllBtn = document.createElement("button");
      removeAllBtn.textContent = "Remove all favorites";
      removeAllBtn.style.cssText =
        "font-size:10px;padding:6px 10px;border:1px solid #555;border-radius:3px;background:none;color:#888;cursor:pointer;width:100%";
      wrap.appendChild(removeAllBtn);

      let confirmingRemoveAll = false;
      removeAllBtn.addEventListener("click", () => {
        if (!confirmingRemoveAll) {
          confirmingRemoveAll = true;
          removeAllBtn.textContent = "Click again to confirm";
          removeAllBtn.style.cssText =
            "font-size:10px;padding:6px 10px;border:1px solid #ff4444;border-radius:3px;background:#ff4444;color:#fff;cursor:pointer;width:100%;font-weight:600";
          setTimeout(() => {
            if (confirmingRemoveAll) {
              confirmingRemoveAll = false;
              removeAllBtn.textContent = "Remove all favorites";
              removeAllBtn.style.cssText =
                "font-size:10px;padding:6px 10px;border:1px solid #555;border-radius:3px;background:none;color:#888;cursor:pointer;width:100%";
            }
          }, 3000);
        } else {
          setFavorites({});
          updateFloatingHeart();
          scheduleAutoBackup();
          renderList();
          showToast("All favorites removed");
          setView(false);
        }
      });
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

      // Genre/tag filter — terms are stored as lowercase keys (see
      // showGenreFilterMenu). Multiple "include" terms are OR'd together;
      // any "exclude" term always drops the entry, even if it also matched
      // an include. A term matches either the favorite's genre or any one
      // of its space-separated tags (favMatchesGenreTerm).
      const genreKeys = Object.keys(genreFilterState);
      if (genreKeys.length) {
        const includeTerms = genreKeys.filter((g) => genreFilterState[g] === "include");
        const excludeTerms = genreKeys.filter((g) => genreFilterState[g] === "exclude");
        entries = entries.filter(([, f]) => {
          if (excludeTerms.some((k) => favMatchesGenreTerm(f, k))) return false;
          if (includeTerms.length && !includeTerms.some((k) => favMatchesGenreTerm(f, k))) return false;
          return true;
        });
      }

      // Collection filter
      if (activeCollectionId) {
        const col = getCollections()[activeCollectionId];
        const idSet = new Set(col && Array.isArray(col.ids) ? col.ids : []);
        entries = entries.filter(([id]) => idSet.has(id));
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

      // Snapshot for the Now Playing bar's Back/Next/shuffle - always the
      // currently visible, filtered/sorted order.
      renderList._entries = entries;

      listEl.innerHTML = "";
      // Invalidate any chunk-append from a previous render (also covers the
      // early-return paths below).
      renderList._token = (renderList._token || 0) + 1;

      // Disconnect any previous lazy-load observer so orphaned refs don't linger
      if (renderList._imgObserver) {
        renderList._imgObserver.disconnect();
        renderList._imgObserver = null;
      }
      // IntersectionObserver rooted on the scroll container, 100px look-ahead on each side
      const imgObserver = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const img = entry.target;
            obs.unobserve(img);
            if (img.dataset.src) {
              const url = img.dataset.src;
              delete img.dataset.src;
              // IndexedDB lookup is local and fast, so it's fine to wait for
              // it before assigning src - avoids a network fetch now and a
              // second, cached-copy swap-in moments later (which would
              // otherwise cause a visible flicker on every card).
              resolveCachedMediaUrl(url).then((resolvedUrl) => {
                img.src = resolvedUrl;
              });
            }
          });
        },
        { root: listEl, rootMargin: "100px 0px", threshold: 0 },
      );
      renderList._imgObserver = imgObserver;

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


      // Card BUILDER — rows are constructed lazily, one chunk per animation
      // frame (see renderChunk below), so opening the panel with 500+ favorites
      // doesn't build ~15k DOM nodes inside the click handler.
      const buildCard = ([id, f]) => {
        const card = document.createElement("div");
        card.dataset.favId = id;
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
          "position:relative;width:56px;height:42px;border-radius:2px;overflow:hidden;flex-shrink:0;background:#1a1a1a;display:flex;align-items:center;justify-content:center;cursor:pointer";
        if (coverUrl) {
          const img = document.createElement("img");
          // Don't set src yet — the IntersectionObserver will do it when the row
          // scrolls within 100px of the list viewport
          img.dataset.src = coverUrl;
          img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
          img.addEventListener("error", () => {
            img.remove();
            coverEl.style.fontSize = "16px";
            coverEl.style.color = "#444";
            // insertBefore instead of textContent= so dimOverlay & previewBtn
            // (appended after this block) are not destroyed
            coverEl.insertBefore(document.createTextNode("?"), coverEl.firstChild);
          });
          coverEl.appendChild(img);
          imgObserver.observe(img);
        } else {
          coverEl.style.cssText += ";font-size:16px;color:#444";
          coverEl.textContent = "?";
        }

        // Dim overlay — sits at --osu-fav-idle-dim normally (0 by default,
        // i.e. invisible) and brightens to --osu-fav-hover-dim on hover/while playing
        const dimOverlay = document.createElement("div");
        dimOverlay.className = "osu-fav-dim-overlay";
        dimOverlay.style.cssText =
          "position:absolute;inset:0;background:rgba(51,51,51,var(--osu-fav-idle-dim, 0));transition:background 0.15s;pointer-events:none";
        coverEl.appendChild(dimOverlay);

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
            "font-size:10px;color:var(--osu-fav-accent);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px";
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

        const dateRow = document.createElement("div");
        dateRow.style.cssText = "display:flex;align-items:center;gap:5px;margin-top:1px";

        const dateDiv = document.createElement("span");
        dateDiv.style.cssText =
          "font-size:9px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        dateDiv.textContent = formatDate(f.favourited_at);

        // Add-to-collection dropdown — sits right next to the date-added text.
        // Shows a checkmark + count once the map is in at least one collection.
        const collCount = () => collectionsContainingMap(id).length;
        const addToCollBtn = document.createElement("button");
        addToCollBtn.type = "button";
        function refreshAddToCollBtn() {
          const n = collCount();
          addToCollBtn.textContent = n ? `\u2713 ${n}` : "+ Playlist";
          addToCollBtn.title = n
            ? `In ${n} collection${n > 1 ? "s" : ""} — click to manage`
            : "Add to a collection";
          addToCollBtn.style.borderColor = n ? "var(--osu-fav-accent)" : "#333";
          addToCollBtn.style.color = n ? "var(--osu-fav-accent)" : "#666";
        }
        addToCollBtn.style.cssText =
          "font-size:8px;font-weight:600;padding:1px 5px;border-radius:2px;flex-shrink:0;cursor:pointer;background:transparent";
        refreshAddToCollBtn();
        addToCollBtn.style.border = `1px solid ${collCount() ? "var(--osu-fav-accent)" : "#333"}`;
        addToCollBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          showAddToCollectionMenu(addToCollBtn, id, () => {
            refreshAddToCollBtn();
            addToCollBtn.style.borderColor = collCount() ? "var(--osu-fav-accent)" : "#333";
            // Membership changed — if a collection filter is active, this
            // card may need to appear/disappear from the visible list.
            if (activeCollectionId) renderList();
          });
        });

        dateRow.append(dateDiv, addToCollBtn);

        // Progress bar (shown during playback)
        const progressWrap = document.createElement("div");
        progressWrap.className = "osu-fav-progress-wrap";
        progressWrap.style.cssText = "height:2px;background:#333;border-radius:1px;margin-top:3px;overflow:hidden;display:none";
        const progressBar = document.createElement("div");
        progressBar.className = "osu-fav-progress-bar";
        progressBar.style.cssText = "height:100%;width:0%;background:var(--osu-fav-accent);border-radius:1px";
        progressWrap.appendChild(progressBar);

        info.append(titleDiv, artistDiv, metaDiv, dateRow, progressWrap);

        // Actions
        const actions = document.createElement("div");
        actions.style.cssText =
          "display:flex;flex-direction:column;gap:4px;flex-shrink:0;justify-content:center";

        const openLink = document.createElement("a");
        openLink.href = f.url || `https://osu.ppy.sh/beatmapsets/${id}`;
        openLink.target = "_blank";
        openLink.textContent = "Open";
        openLink.style.cssText =
          "font-size:10px;padding:4px 8px;border:1px solid #333;border-radius:2px;color:#999;text-decoration:none;text-align:center;display:block;white-space:nowrap";
        openLink.addEventListener("mouseenter", () => {
          openLink.style.borderColor = "var(--osu-fav-accent)";
          openLink.style.color = "var(--osu-fav-accent)";
        });
        openLink.addEventListener("mouseleave", () => {
          openLink.style.borderColor = "#333";
          openLink.style.color = "#999";
        });

        // If a default mirror is configured (Settings → Download Mirrors)
        // and it's actually usable right now (mirror still enabled, or
        // Official while actually signed in), skip the dropdown entirely
        // and go straight to a real download link. Otherwise fall back to
        // the normal "Download ▾" trigger — resolveDefaultMirror() already
        // returns null for anything that wouldn't work, so this never
        // hands out a dead link.
        //
        // Separately: even with no default set, buildDownloadOptions() can
        // still only have exactly one entry (e.g. a signed-out guest with
        // every mirror disabled — Official is the only option, "requires
        // sign-in" and all). A "▾" dropdown that opens to one single row is
        // just a pointless extra click, so that case also collapses to a
        // plain link, same as the default-mirror path.
        const defaultMirror = resolveDefaultMirror(id);
        let soleOption = null;
        if (!defaultMirror) {
          const opts = buildDownloadOptions(id);
          if (opts.length === 1) soleOption = opts[0];
        }
        const downloadStyle =
          "font-size:10px;padding:4px 8px;border:1px solid #333;border-radius:2px;background:none;color:#999;" +
          "cursor:pointer;text-align:center;white-space:nowrap;width:100%;text-decoration:none;display:block;box-sizing:border-box";

        let downloadLink;
        if (defaultMirror || soleOption) {
          const target = defaultMirror || soleOption;
          downloadLink = document.createElement("a");
          downloadLink.href = target.url;
          downloadLink.target = "_blank";
          downloadLink.rel = "noopener";
          downloadLink.textContent = "Download";
          downloadLink.title = defaultMirror
            ? `Download via ${target.label} — change default in Settings`
            : `Download via ${target.label}`;
        } else {
          downloadLink = document.createElement("button");
          downloadLink.type = "button";
          downloadLink.title = "Download map (official + mirrors)";
          downloadLink.textContent = "Download ▾";
          downloadLink.addEventListener("click", (e) => {
            e.stopPropagation();
            showDownloadMenu(downloadLink, id);
          });
        }
        downloadLink.style.cssText = downloadStyle;
        downloadLink.addEventListener("mouseenter", () => {
          downloadLink.style.borderColor = "var(--osu-fav-accent)";
          downloadLink.style.color = "var(--osu-fav-accent)";
        });
        downloadLink.addEventListener("mouseleave", () => {
          downloadLink.style.borderColor = "#333";
          downloadLink.style.color = "#999";
        });

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "Remove";
        removeBtn.style.cssText =
          "font-size:10px;padding:4px 8px;border:1px solid #333;border-radius:2px;background:none;color:#999;cursor:pointer;white-space:nowrap";
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
          scheduleAutoBackup();
          renderList();
        });

        // Preview button - singleton audio (module-level ensureAudio()), only one plays at a time
        ensureAudio();

        const previewUrl = previewSourceUrl(id, f.preview || `https://b.ppy.sh/preview/${id}.mp3`);

        // Play button — lives inside the cover, centred, shown on hover or while playing
        const previewBtn = document.createElement("button");
        previewBtn.className = "osu-fav-preview-btn";
        previewBtn.innerHTML = playSVG();
        previewBtn.title = "Preview audio";
        previewBtn.style.cssText =
          "position:absolute;inset:0;margin:auto;width:fit-content;height:fit-content;" +
          "font-size:11px;padding:2px 6px;border:1px solid #333;border-radius:2px;" +
          "background:none;color:#999;cursor:pointer;text-align:center;line-height:1;" +
          "opacity:var(--osu-fav-idle-opacity, 0.15);transition:opacity 0.15s";

        // Show/hide button on cover hover; restore original border/color on hover
        coverEl.addEventListener("mouseenter", () => {
          previewBtn.style.opacity = "var(--osu-fav-active-opacity, 0.8)";
          dimOverlay.style.background = "rgba(51,51,51,var(--osu-fav-hover-dim, 0.65))";
          if (!previewBtn._playing) { previewBtn.style.borderColor = "var(--osu-fav-accent)"; previewBtn.style.color = "var(--osu-fav-accent)"; }
        });
        coverEl.addEventListener("mouseleave", () => {
          if (!previewBtn._playing) {
            previewBtn.style.opacity = "var(--osu-fav-idle-opacity, 0.15)";
            previewBtn.style.borderColor = "#333";
            previewBtn.style.color = "#999";
            dimOverlay.style.background = "rgba(51,51,51,var(--osu-fav-idle-dim, 0))";
          }
        });

        previewBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const audio = window._osuFavAudio;
          // Compare by id, not by src string - a cached play sets audio.src
          // to a local blob: URL, which never string-matches previewUrl.
          const isSame = audio._npCurrentId === id;
          if (isSame) {
            if (!audio.paused) {
              audio.pause();
              previewBtn.innerHTML = playSVG();
              previewBtn._playing = false;
              previewBtn.style.opacity = "var(--osu-fav-idle-opacity, 0.15)";
              previewBtn.style.borderColor = "#333";
              previewBtn.style.color = "#999";
              dimOverlay.style.background = "rgba(51,51,51,var(--osu-fav-idle-dim, 0))";
            } else {
              // Re-link the bar/dim to this card every time we (re)start
              // playback, not just on a genuinely new src — if the previous
              // play ran to completion, the "ended" handler already cleared
              // audio._activeBar/_activeDim and hid the progress wrap, so a
              // plain audio.play() here would resume sound with nothing
              // wired up to draw progress for it.
              audio._activeBtn = previewBtn;
              audio._activeBar = progressBar;
              audio._activeDim = dimOverlay;
              progressWrap.style.display = "block";
              audio.play();
              previewBtn.innerHTML = pauseSVG();
              previewBtn._playing = true;
              previewBtn.style.opacity = "var(--osu-fav-active-opacity, 0.8)";
              previewBtn.style.borderColor = "var(--osu-fav-accent)";
              previewBtn.style.color = "var(--osu-fav-accent)";
              dimOverlay.style.background = "rgba(51,51,51,var(--osu-fav-hover-dim, 0.65))";
            }
            return;
          }
          // Different track - hand off to the shared player so the Now
          // Playing bar and Back/Next queue stay in sync too.
          startPlayback(id, f, { navigated: false });
        });

        coverEl.appendChild(previewBtn);
        actions.append(openLink, downloadLink, removeBtn);
        card.append(coverEl, info, actions);
        return card;
      };

      // Chunked build+append — mounting 500+ rows in one synchronous pass
      // blocked the click handler for seconds and forced full-layout reflows.
      // Smaller chunks keep each frame comfortably under the ~50ms budget
      // Chrome flags as janky, at the cost of slightly more frames to finish
      // mounting a very long list — imperceptible either way while scrolled
      // near the top, and it's non-blocking regardless.
      const CHUNK_SIZE = 25;
      const renderToken = renderList._token; // set at top of this function
      let cursor = 0;
      const renderChunk = () => {
        if (renderList._token !== renderToken) return; // superseded by newer render
        const end = Math.min(cursor + CHUNK_SIZE, entries.length);
        const chunk = document.createDocumentFragment();
        for (; cursor < end; cursor++) chunk.appendChild(buildCard(entries[cursor]));
        listEl.appendChild(chunk);
        if (cursor < entries.length) requestAnimationFrame(renderChunk);
      };
      if (entries.length) requestAnimationFrame(renderChunk);
    }

    // ── Mobile search bar behavior ─────────────────────────────
    // On narrow screens the search field collapses while the favorites list is
    // scrolled down, giving the cards more vertical room. The mini-player is
    // deliberately outside the scrolling list, so it remains pinned while the
    // search bar hides/reappears.
    let lastListScrollTop = 0;
    let searchBarCollapsed = false;
    function updateMobileSearchBar() {
      const isMobile = window.matchMedia("(max-width: 600px)").matches;
      if (!isMobile) {
        searchInput.style.maxHeight = "40px";
        searchInput.style.opacity = "1";
        searchInput.style.marginBottom = "0";
        searchInput.style.paddingTop = "6px";
        searchInput.style.paddingBottom = "6px";
        searchInput.style.borderWidth = "1px";
        searchInput.style.pointerEvents = "auto";
        header.style.height = "100px";
        header.style.maxHeight = "100px";
        header.style.paddingTop = "10px";
        header.style.paddingBottom = "8px";
        headerTop.style.marginBottom = "8px";
        searchBarCollapsed = false;
        return;
      }

      const scrollTop = listEl.scrollTop;
      const scrollingDown = scrollTop > lastListScrollTop + 2;
      const scrollingUp = scrollTop < lastListScrollTop - 2;
      if (scrollTop <= 4 || scrollingUp) searchBarCollapsed = false;
      else if (scrollingDown) searchBarCollapsed = true;
      lastListScrollTop = scrollTop;

      searchInput.style.maxHeight = searchBarCollapsed ? "0" : "40px";
      searchInput.style.opacity = searchBarCollapsed ? "0" : "1";
      searchInput.style.marginBottom = searchBarCollapsed ? "-1px" : "0";
      searchInput.style.paddingTop = searchBarCollapsed ? "0" : "6px";
      searchInput.style.paddingBottom = searchBarCollapsed ? "0" : "6px";
      searchInput.style.borderWidth = searchBarCollapsed ? "0" : "1px";
      searchInput.style.pointerEvents = searchBarCollapsed ? "none" : "auto";

      // Collapse the header itself with the search field. The input alone can
      // disappear while osu!'s global CSS still leaves a large header box.
      const headerHeight = searchBarCollapsed ? "54px" : "100px";
      header.style.height = headerHeight;
      header.style.maxHeight = headerHeight;
      header.style.paddingTop = "10px";
      header.style.paddingBottom = "8px";
      headerTop.style.marginBottom = searchBarCollapsed ? "0" : "8px";
    }
    listEl.addEventListener("scroll", updateMobileSearchBar, { passive: true });
    window.addEventListener("resize", updateMobileSearchBar);

    // ── Assemble & wire events ─────────────────────────────
    // Bottom UI is a panel-level sibling of the scrolling content, exactly like
    // the top header: it is absolutely pinned to the panel bottom and never
    // participates in the scrollable list/settings viewport.
    const bottomBar = document.createElement("div");
    bottomBar.id = "osu-fav-bottom-bar";
    bottomBar.style.cssText =
      "position:absolute;left:0;right:0;bottom:0;z-index:20;overflow:hidden;" +
      "background:#1a1a1a;box-shadow:0 -3px 12px rgba(0,0,0,.35);" +
      "padding-bottom:0;box-sizing:border-box;min-height:0;height:auto;";
    bottomBar.append(nowPlayingBar, footer);
    panel.append(header, ...(githubBanner ? [githubBanner] : []), toolbar, contentArea, bottomBar);
    document.body.appendChild(panel);
    updateSortBtns();
    renderList();
    updateFooterStatus();
    updateMobileSearchBar();

    // Always check for updates on panel open (force=true skips 24h throttle)
    const currentVersion = getCurrentVersion();
    checkVersionUpdate(true).then((latestVersion) => {
      if (latestVersion && isNewerVersion(currentVersion, latestVersion)) {
        showPanelUpdateOverlay(latestVersion);
      }
    });
  }

  // ═══ Menu commands ═══
  // These run at top-level, before init() — an unguarded throw here (rather
  // than the graceful no-op-stub behavior GM_getValue/GM_setValue fall back
  // to in some environments) would silently prevent everything below,
  // including init() itself, from ever running.
  try {
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("View Local Favorites", showFavoritesPanel);
      GM_registerMenuCommand("Check for Updates", () => {
        showOsuFavToast("Checking for updates...");
        checkVersionUpdate(true).then((latestVersion) => {
          const currentVersion = getCurrentVersion();
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
              "https://github.com/starhollow2008/LOF/raw/main/osu-local-favorites.user.js",
              "_blank",
            );
          } else {
            showOsuFavToast(`You are up to date! (v${currentVersion})`);
          }
        });
      });
    } else {
      console.warn(
        "[osu-local-favorites] GM_registerMenuCommand not supported by this userscript manager — menu commands disabled",
      );
    }
  } catch (e) {
    console.warn("[osu-local-favorites] menu command registration failed:", e);
  }

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
    // we don't need to inject our guest fallback — our click interceptor handles the native
    // button. Osu!'s own class/title FLIPS once a beatmapset is already favourited
    // (…-square-favourite/"favourite this beatmap" → …-square-unfavourite/"unfavourite
    // this beatmap"), so both states must be checked or an already-favourited map's native
    // button goes undetected and we'd inject a visually-identical duplicate heart next to it.
    if (
      document.querySelector('[class*="-square-favourite"]') ||
      document.querySelector('[class*="-square-unfavourite"]') ||
      document.querySelector("button[data-orig-title='favourite this beatmap']") ||
      document.querySelector("button[data-orig-title='unfavourite this beatmap']") ||
      document.querySelector("button[title='favourite this beatmap']") ||
      document.querySelector("button[title='unfavourite this beatmap']")
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
      '<span class="' + (fav ? "fas" : "far") + ' fa-heart" style="color:var(--osu-fav-heart-color)"></span>' +
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
        heart.style.color = "var(--osu-fav-heart-color)";
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
        // Context not resolvable yet (card still mid-render) — leave unmarked
        // so the next pass retries instead of skipping this element forever.
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

  // Detects osu!plus (limjeck/osuplus) already having injected its own mirror
  // buttons on this page — it tags them with this exact class in its
  // makeMirror() function. If present, we skip adding our own to avoid a
  // cluttered duplicate row of near-identical buttons.
  function isOsuPlusMirrorsPresent() {
    return !!document.querySelector(".js-beatmapset-download-link");
  }

  // Builds a button matching osu!'s own native download-button markup
  // exactly (same classes osu!'s big buttons and osu!plus's mirror buttons
  // use) — so ours inherit the page's real CSS instead of looking like a
  // custom pill glued on top of it.
  function makeNativeStyleLink(url, topName, bottomName) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.setAttribute("data-turbolinks", "false");
    a.className = "btn-osu-big btn-osu-big--beatmapset-header osu-fav-mirror-link";
    a.innerHTML =
      '<span class="btn-osu-big__content">' +
      '<span class="btn-osu-big__left">' +
      `<span class="btn-osu-big__text-top">${topName}</span>` +
      (bottomName ? `<span class="btn-osu-big__text-bottom">${bottomName}</span>` : "") +
      "</span>" +
      '<span class="btn-osu-big__icon"><span class="fa-fw"><i class="fas fa-download"></i></span></span>' +
      "</span>";
    return a;
  }

  // Injects native-styled mirror-download buttons onto the beatmapset detail
  // page, right after the official download buttons. These work regardless
  // of login state or a beatmapset's download_disabled flag — a solid
  // fallback for anything the official button can't do. Cheap to call
  // repeatedly; only rebuilds when the current beatmapset id actually
  // changes, and stands down entirely if osu!plus already covers this.
  function injectMirrorButtons() {
    const bmid = getBeatmapId();
    if (!bmid) return;

    const existing = document.getElementById("osu-fav-mirror-row");

    if (isOsuPlusMirrorsPresent()) {
      if (existing) existing.remove();
      return;
    }

    const enabledMirrors = MIRRORS.filter(isMirrorEnabled);
    if (enabledMirrors.length === 0) {
      if (existing) existing.remove();
      return;
    }
    if (existing && existing.dataset.beatmapsetId === String(bmid)) return; // already current
    if (existing) existing.remove();

    const moreContainer = document.querySelector(".beatmapset-header__more");
    const buttonsContainer = document.querySelector(".beatmapset-header__buttons");
    if (!moreContainer && !buttonsContainer) return;

    const row = document.createElement("div");
    row.id = "osu-fav-mirror-row";
    row.dataset.beatmapsetId = String(bmid);
    row.style.cssText = "display:contents";

    enabledMirrors.forEach((mirror) => {
      mirror.variants(bmid).forEach((variant) => {
        row.appendChild(makeNativeStyleLink(variant.url, variant.top, variant.bottom));
      });
    });

    // Match osu!plus's own insertion point exactly: before "…more" if it
    // exists, otherwise appended into the main buttons row.
    if (moreContainer) {
      moreContainer.before(row);
    } else {
      buttonsContainer.appendChild(row);
    }
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
  // getCurrentVersion() reads directly from Tampermonkey's GM_info API, which always
  // mirrors the @version header — no separate constant to keep in sync.
  function getCurrentVersion() {
    // Primary: Tampermonkey/Violentmonkey expose GM_info.script.version from the @version tag
    if (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) {
      return GM_info.script.version;
    }
    // Fallback: scan script tags in the document for a @version comment (development use)
    try {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        const v = (s.textContent || "").match(/@version\s+([0-9.]+)/);
        if (v) return v[1];
      }
    } catch (_) { }
    return "0.0.0";
  }

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
    const currentVersion = getCurrentVersion();
    const lastCheck = GM_getValue("osu_last_version_check", 0);
    const checkInterval = 12 * 60 * 60 * 1000; // 12 hours

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
        // Always fetch the live main branch so version checks pick up real releases
        url: "https://raw.githubusercontent.com/starhollow2008/LOF/main/osu-local-favorites.user.js",
        timeout: 10000,
        onload: function (response) {
          GM_setValue("osu_last_version_check", Date.now());
          const text = response.responseText || "";
          // Only scan the UserScript header block (first 2 KB) for speed
          const header = text.slice(0, 2048);
          const match = header.match(/@version\s+(\d+\.\d+\.\d+)/);
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

  // ═══ Update prompt UI ═══
  // Shown on page load when a new version is detected and the panel isn't open.
  // Reuses the same palette as the panel so it looks consistent.
  function showUpdatePrompt(latestVersion) {
    const dismissed = GM_getValue("osu_dismissed_version", "");
    if (dismissed === latestVersion) return;
    if (document.getElementById("osu-local-update-prompt")) return;

    // Inject slide-in keyframe if not already present
    if (!document.getElementById("osu-fav-panel-style")) {
      const s = document.createElement("style");
      s.id = "osu-fav-panel-style";
      s.textContent =
        "#osu-fav-list::-webkit-scrollbar{width:4px}" +
        "#osu-fav-list::-webkit-scrollbar-thumb{background:#333;border-radius:2px}" +
        "#osu-fav-list::-webkit-scrollbar-thumb:hover{background:var(--osu-fav-accent)}" +
        "@keyframes osuFavSlideDown{from{max-height:0;opacity:0;overflow:hidden}to{max-height:50px;opacity:1}}" +
        "@keyframes osuFavSlideUp{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}";
      document.head.appendChild(s);
    }

    const modal = document.createElement("div");
    modal.id = "osu-local-update-prompt";
    // Matches panel: dark #111 bg, #333 border, same font stack, same shadow
    Object.assign(modal.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "100002",
      width: "300px",
      background: "#111",
      border: "1px solid #333",
      borderRadius: "4px",
      color: "#ddd",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: "13px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
      overflow: "hidden",
      animation: "osuFavSlideUp 0.25s ease-out",
    });

    // Gradient accent bar — same as displayUpdateBanner inside the panel
    const accentBar = document.createElement("div");
    accentBar.style.cssText =
      "background: var(--osu-fav-accent);padding:8px 14px;" +
      "display:flex;align-items:center;justify-content:space-between;" +
      "font-weight:600;font-size:12px;color:#fff;gap:8px;border-bottom:1px solid rgba(0,0,0,0.15)";

    const accentLabel = document.createElement("span");
    accentLabel.innerHTML = `New version <b>v${latestVersion}</b> available!`;

    const accentClose = document.createElement("button");
    accentClose.textContent = "✕";
    accentClose.title = "Dismiss";
    accentClose.style.cssText =
      "background:none;border:none;color:#fff;cursor:pointer;font-size:12px;" +
      "opacity:0.8;font-weight:bold;padding:0 2px;flex-shrink:0";
    accentClose.addEventListener("mouseenter", () => (accentClose.style.opacity = "1"));
    accentClose.addEventListener("mouseleave", () => (accentClose.style.opacity = "0.8"));
    accentClose.addEventListener("click", () => {
      modal.remove();
      GM_setValue("osu_dismissed_version", latestVersion);
    });

    accentBar.append(accentLabel, accentClose);

    // Body — same text color and line-height as panel text
    const body = document.createElement("div");
    body.style.cssText = "padding:12px 14px;line-height:1.5;font-size:12px;color:#bbb";
    body.innerHTML =
      `<b style="color:#ddd">osu! Local Favorites</b> has an update ready.<br>` +
      `Install it now to get the latest fixes and features.`;

    // Footer buttons — mirror the toolbar makeBtn style from the panel
    const footer = document.createElement("div");
    footer.style.cssText =
      "display:flex;justify-content:flex-end;gap:6px;padding:8px 14px;" +
      "border-top:1px solid #222;background:#1a1a1a";

    const laterBtn = document.createElement("button");
    laterBtn.textContent = "Later";
    laterBtn.style.cssText =
      "font-size:10px;padding:4px 10px;border:1px solid #333;border-radius:3px;" +
      "background:transparent;color:#888;cursor:pointer;font-weight:500";
    laterBtn.addEventListener("mouseenter", () => {
      laterBtn.style.borderColor = "var(--osu-fav-accent)";
      laterBtn.style.color = "var(--osu-fav-accent)";
    });
    laterBtn.addEventListener("mouseleave", () => {
      laterBtn.style.borderColor = "#333";
      laterBtn.style.color = "#888";
    });
    laterBtn.addEventListener("click", () => {
      modal.remove();
      GM_setValue("osu_dismissed_version", latestVersion);
    });

    // "Update" button — same style as the in-panel banner's Update button
    const updateBtn = document.createElement("button");
    updateBtn.textContent = "Update Now";
    updateBtn.style.cssText =
      "font-size:10px;padding:4px 10px;border:none;border-radius:3px;" +
      "background:var(--osu-fav-accent);color:#fff;cursor:pointer;font-weight:600;transition:background 0.2s";
    updateBtn.addEventListener("mouseenter", () => (updateBtn.style.background = "var(--osu-fav-accent-dark)"));
    updateBtn.addEventListener("mouseleave", () => (updateBtn.style.background = "var(--osu-fav-accent)"));
    updateBtn.addEventListener("click", () => {
      window.open(
        "https://github.com/starhollow2008/LOF/raw/main/osu-local-favorites.user.js",
        "_blank",
      );
      modal.remove();
    });

    footer.append(laterBtn, updateBtn);
    modal.append(accentBar, body, footer);
    document.body.appendChild(modal);
  }

  // ═══ Init ═══
  function init() {
    applyTheme();

    // osu!'s own qtip tooltips/popups (difficulty hover cards, user cards,
    // achievement popups, etc.) sit at z-index ~512 on the live site — far
    // below the favorites panel's z-index (100000+). Whenever a tooltip
    // would land underneath the panel's screen area (fixed to the right
    // edge, full viewport height), it rendered completely invisible instead
    // of on top like it should. This is injected unconditionally at init,
    // not folded into the panel's own lazily-created stylesheet, so it's in
    // effect from the very first hover — not just after the panel has been
    // opened once.
    if (!document.getElementById("osu-fav-qtip-style")) {
      const qtipStyle = document.createElement("style");
      qtipStyle.id = "osu-fav-qtip-style";
      qtipStyle.textContent = ".qtip{z-index:100003!important}";
      document.head.appendChild(qtipStyle);
    }

    injectInterceptor();
    // OAuth callback must be handled as early as possible so the user never
    // sees osu!'s 404 page for /osu-local-favorites.
    osuApiHandleOAuthCallback();

    // One-time-per-favorite migration: back-fill the enrichment queue with
    // any favorite that's missing genre data. osu!'s API always returns a
    // genre object (even "Unspecified" has one), so an empty genre string
    // reliably means this favorite was saved from a listing card and either
    // never got enriched or a past attempt didn't survive to completion —
    // both are exactly what the queue+drainer above now handle. Cheap to
    // run every load: IDs already in the queue are skipped by addToEnrichQueue,
    // and once a favorite has real data it never gets re-added.
    try {
      const favs = getFavorites();
      const favsNeedingGenre = Object.keys(favs).filter((id) => !favs[id].genre);
      if (favsNeedingGenre.length) {
        favsNeedingGenre.forEach(addToEnrichQueue);
      }
    } catch (e) { /* never break page load over this */ }
    if (getEnrichQueue().length) ensureEnrichDrainerRunning();

    // ═══ Cross-tab sync ═══
    // When another tab writes to the favorites key, refresh all UI in this tab.
    // GM_addValueChangeListener isn't implemented at all in some userscript
    // managers (a hard ReferenceError rather than a graceful no-op stub like
    // GM_getValue/GM_setValue get) — left unguarded, that throw would abort
    // every line below it in this function, including the MutationObserver
    // setup further down that keeps the page's hearts working after the
    // first render. Cross-tab sync is a nice-to-have; losing it silently is
    // far better than losing everything after it.
    if (typeof GM_addValueChangeListener === "function") {
      try {
        GM_addValueChangeListener(STORAGE_KEY, (_key, _oldVal, _newVal, remote) => {
          if (!remote) return; // ignore writes from this same tab

          // Re-render floating heart (filled/outline SVG) for the current beatmap
          updateFloatingHeart();

          // Rebuild the panel if it's already open
          const panel = document.getElementById("osu-local-fav-panel");
          if (panel) {
            panel.remove();
            showFavoritesPanel();
          }

          // Re-check all visible card hearts (clear the "already scanned" flag first)
          document.querySelectorAll("[data-osu-fav-checked]").forEach((btn) => {
            btn.removeAttribute("data-osu-fav-checked");
          });
          refreshButtons();
        });
      } catch (e) {
        console.warn("[osu-local-favorites] cross-tab sync unavailable:", e);
      }
    } else {
      console.warn(
        "[osu-local-favorites] GM_addValueChangeListener not supported by this userscript manager — cross-tab sync disabled",
      );
    }

    ensureHeartIndicator();
    addFavoriteAllButtons();
    addGuestFavoriteButton();
    enableGuestDownloads();
    injectMirrorButtons();

    // Auto-check version update on script load
    checkVersionUpdate().then((latestVersion) => {
      const currentVersion = getCurrentVersion();
      if (latestVersion && isNewerVersion(currentVersion, latestVersion)) {
        showUpdatePrompt(latestVersion);
      }
    });

    // Debounced observer — runs at most once per 600ms to avoid freezing the page
    let timer = null;
    const debouncedRefresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        // Skip while the tab is in the background — a MutationObserver on
        // the whole document body fires on osu!'s own live-updating content
        // too (dashboard activity feed, notification counts, relative
        // timestamps, etc.), not just our own changes, so on a busy page
        // this can otherwise re-run every ~600ms indefinitely even while
        // nobody's looking at the tab. The visibilitychange listener below
        // catches up in one pass as soon as it's foregrounded again, so
        // nothing actually goes stale — this just stops paying for it while
        // backgrounded.
        if (document.hidden) return;
        refreshButtons();
        if (!document.getElementById("osu-local-fav-ind"))
          ensureHeartIndicator();
        addFavoriteAllButtons();
        addGuestFavoriteButton();
        updateFloatingHeart();
        enableGuestDownloads();
        injectMirrorButtons();
      }, 600);
    };

    let mainObserver = null;
    function attachMainObserver() {
      if (mainObserver) mainObserver.disconnect();
      if (!document.body) return;
      mainObserver = new MutationObserver(debouncedRefresh);
      mainObserver.observe(document.body, { childList: true, subtree: true });
    }
    attachMainObserver();

    // ═══ Turbolinks / back-forward resiliency ═══
    // osu!'s site navigates via Turbolinks — going back restores a *cached
    // snapshot* of the page rather than loading it fresh. That snapshot is a
    // clone of whatever was on the page when it got cached, and cloning does
    // not carry over addEventListener-based handlers. Our own injected
    // elements (floating heart, panel, guest button, mirror row) come back
    // looking identical but dead — same ids/classes, so our own "already
    // there, skip" guards leave the lifeless clone in place instead of
    // rebuilding a working one, and everything reads as "unresponsive" until
    // a manual page reload. The MutationObserver above silently stops
    // working here too, since it's watching whatever <body> existed at
    // attach time and Turbolinks replaces <body> wholesale on every
    // navigation. Wiping the known injected ids/classes and reattaching the
    // observer on every Turbolinks navigation (cache-restore or fresh) fixes
    // both issues at once.
    function hardResync() {
      ["osu-local-fav-ind", "osu-local-fav-panel", "osu-local-guest-fav-btn", "osu-fav-mirror-row", "osu-fav-dl-menu"]
        .forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.remove();
        });
      document.querySelectorAll(".osu-fav-all-btn").forEach((el) => el.remove());
      document.querySelectorAll("[data-osu-fav-checked]").forEach((btn) => btn.removeAttribute("data-osu-fav-checked"));
      attachMainObserver();
      ensureHeartIndicator();
      addFavoriteAllButtons();
      addGuestFavoriteButton();
      updateFloatingHeart();
      enableGuestDownloads();
      injectMirrorButtons();
      refreshButtons();
    }

    // Turbolinks (classic) fires "turbolinks:load"; Hotwire Turbo renamed it
    // to "turbo:load" — listen for both since we can't be sure which is live.
    document.addEventListener("turbolinks:load", hardResync);
    document.addEventListener("turbo:load", hardResync);
    // Fallback for a genuine browser back/forward-cache restore, in case any
    // navigation path bypasses Turbolinks entirely.
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) hardResync();
    });

    // Polling for SPA navigation (low overhead)
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        ensureHeartIndicator();
        addGuestFavoriteButton();
        enableGuestDownloads();
        injectMirrorButtons();
        debouncedRefresh();
      }
    }, 800);

    // Periodic fallback scan — the MutationObserver above catches almost
    // everything, but some osu! content (e.g. the lazy-loaded "Beatmaps" tab
    // on profile pages, which only fetches its data once scrolled into view)
    // renders on its own schedule and can occasionally land between observer
    // callbacks. This is a cheap, unconditional re-scan that guarantees
    // hearts, the "Favorite all" button, and download links all settle into
    // the correct state within ~1.5s no matter what triggered the render.
    // Skipped while backgrounded for the same reason as debouncedRefresh
    // above — a background tab has no reason to keep re-scanning the page
    // every 1.5s forever; the visibilitychange listener below runs one pass
    // immediately on returning to the tab instead.
    setInterval(() => {
      if (document.hidden) return;
      refreshButtons();
      addFavoriteAllButtons();
      addGuestFavoriteButton();
      enableGuestDownloads();
      injectMirrorButtons();
      if (!document.getElementById("osu-local-fav-ind")) ensureHeartIndicator();
    }, 1500);

    // Catch up in one pass as soon as the tab is foregrounded again, so
    // pausing the two scans above while hidden never leaves anything stale
    // for longer than it takes to switch back to the tab.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      refreshButtons();
      addFavoriteAllButtons();
      addGuestFavoriteButton();
      updateFloatingHeart();
      enableGuestDownloads();
      injectMirrorButtons();
      if (!document.getElementById("osu-local-fav-ind")) ensureHeartIndicator();
    });

    // Initial refresh after page settles
    setTimeout(refreshButtons, 800);
    setTimeout(refreshButtons, 2000);
    setTimeout(addGuestFavoriteButton, 1200);
    setTimeout(addGuestFavoriteButton, 2500);
    setTimeout(enableGuestDownloads, 1000);
    setTimeout(enableGuestDownloads, 2200);
    setTimeout(injectMirrorButtons, 1000);
    setTimeout(injectMirrorButtons, 2200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
