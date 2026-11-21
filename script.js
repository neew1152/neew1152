(() => {
  "use strict";

  const USER = "neew1152";
  const EMPTY_LABELS = { repos: "repositories", certs: "certificates", gists: "Gists" };
  const TABS = Object.keys(EMPTY_LABELS);
  const IMG_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
  const PREVIEW_CACHE_KEY = `portal_previews_${USER}`;
  const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

  const RE_MD_EXT = /^(?:md|markdown|mdx)$/;
  const RE_HTML_EXT = /^html?$/;
  const RE_FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
  const RE_FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
  const RE_DATA_URI = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=]+$/i;
  const RE_DATA_PREFIX = /^data:/i;
  const RE_HTTP_PREFIX = /^https?:\/\//i;
  const RE_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  const RE_BLOB_ORIGIN = /^blob:(?:https?:\/\/|null\/)/i;
  const RE_CTRL = /[\u0000-\u001f\u007f]/;
  const RE_REL_PREFIX = /^(?:\.\/|\/)+/;

  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
  }

  let currentTab = "repos";
  let ready = false;
  let previewCache = null;
  let previewCacheDirty = false;
  let flushTimer = 0;

  const state = { repos: [], certs: [], gists: [], errors: {} };
  const tasks = {};
  const renderedBoxes = new Map();

  const init = () => {
    setupTabs();
    loadData();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  /* =========================================================
     Storage & Preview Cache
     ========================================================= */

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }

  function getPreviewCache() {
    if (previewCache) return previewCache;
    const raw = storageGet(PREVIEW_CACHE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          previewCache = parsed;
          return previewCache;
        }
      } catch {}
    }
    previewCache = Object.create(null);
    return previewCache;
  }

  function readPreviewCache(key, version, now) {
    const cache = getPreviewCache();
    if (!Object.prototype.hasOwnProperty.call(cache, key)) return null;
    const entry = cache[key];
    if (!entry || entry.v !== version) return null;
    if (entry.p) {
      const safe = sanitizeUrl(entry.p, true);
      return safe ? { hit: true, preview: safe } : null;
    }
    if (entry.p === "" && now - (entry.t || 0) < NEGATIVE_TTL_MS) {
      return { hit: true, preview: null };
    }
    return null;
  }

  function writePreviewCache(key, version, preview) {
    const cache = getPreviewCache();
    cache[key] = preview ? { v: version, p: preview } : { v: version, p: "", t: Date.now() };
    previewCacheDirty = true;
    scheduleCacheFlush();
  }

  function deletePreviewCache(key) {
    const cache = getPreviewCache();
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      delete cache[key];
      previewCacheDirty = true;
      scheduleCacheFlush();
    }
  }

  function flushPreviewCache() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = 0;
    }
    if (!previewCacheDirty || !previewCache) return;
    previewCacheDirty = false;
    storageSet(PREVIEW_CACHE_KEY, JSON.stringify(previewCache));
  }

  function scheduleCacheFlush() {
    if (!previewCacheDirty || flushTimer) return;
    flushTimer = setTimeout(flushPreviewCache, 400);
  }

  window.addEventListener("pagehide", flushPreviewCache);

  /* =========================================================
     Portal Tabs & Data Loading
     ========================================================= */

  function setupTabs() {
    const nav = document.querySelector(".tab-nav");
    const tabs = Array.from(document.querySelectorAll(".tab-btn")).filter((t) =>
      TABS.includes(t.dataset.tab)
    );
    if (nav) nav.setAttribute("role", "tablist");

    const sync = () => {
      for (const t of tabs) {
        const active = t.dataset.tab === currentTab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
        t.setAttribute("tabindex", active ? "0" : "-1");
      }
    };

    const activate = (id) => {
      if (currentTab === id) return;
      currentTab = id;
      sync();
      if (!ready) return;
      render();
      warmPreviews(id);
    };

    sync();
    tabs.forEach((tab, idx) => {
      const id = tab.dataset.tab;
      tab.setAttribute("role", "tab");
      tab.addEventListener("click", () => activate(id));
      tab.addEventListener("keydown", (e) => {
        let nextIdx = -1;
        if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
        else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") nextIdx = 0;
        else if (e.key === "End") nextIdx = tabs.length - 1;
        if (nextIdx >= 0) {
          e.preventDefault();
          tabs[nextIdx].focus();
          activate(tabs[nextIdx].dataset.tab);
        }
      });

      const warm = () => {
        if (!ready) return;
        warmPreviews(id);
        tab.removeEventListener("pointerenter", warm);
        tab.removeEventListener("focus", warm);
      };
      tab.addEventListener("pointerenter", warm, { passive: true });
      tab.addEventListener("focus", warm);
    });
  }

  async function loadData() {
    const grid = document.getElementById("grid-container");
    if (!grid) return;

    grid.setAttribute("aria-busy", "true");
    grid.replaceChildren(msgNode("Loading portal data..."));

    const shrinkRepos = (rs) => {
      if (!Array.isArray(rs)) return [];
      const out = [];
      for (const r of rs) {
        if (!r || r.fork) continue;
        out.push({
          id: r.id,
          name: r.name,
          full_name: r.full_name,
          html_url: r.html_url,
          description: r.description,
          default_branch: r.default_branch,
          size: r.size,
          language: r.language,
          pushed_at: r.pushed_at,
        });
      }
      return out;
    };

    const shrinkGists = (gs) => {
      if (!Array.isArray(gs)) return [];
      const out = [];
      for (const g of gs) {
        if (!g) continue;
        const files = {};
        if (g.files) {
          for (const [k, v] of Object.entries(g.files)) {
            if (v) files[k] = { raw_url: v.raw_url, language: v.language, size: v.size };
          }
        }
        out.push({
          id: g.id,
          description: g.description,
          html_url: g.html_url,
          updated_at: g.updated_at,
          files,
        });
      }
      return out;
    };

    try {
      const user = encodeURIComponent(USER);
      const [reposRes, certsRes, gistsRes] = await Promise.all([
        fetchJson(
          `https://api.github.com/users/${user}/repos?sort=updated&per_page=100`,
          `portal_cache_repos_${USER}`,
          shrinkRepos
        ),
        fetchJson("data.json"),
        fetchJson(
          `https://api.github.com/users/${user}/gists?per_page=100`,
          `portal_cache_gists_${USER}`,
          shrinkGists
        ),
      ]);

      const now = Date.now();
      const cache = getPreviewCache();
      const validRepoKeys = Array.isArray(reposRes.data) ? new Set() : null;
      const validGistKeys = Array.isArray(gistsRes.data) ? new Set() : null;

      const cJson = certsRes.data;
      if (cJson) {
        const rawCerts = Array.isArray(cJson) ? cJson : Array.isArray(cJson.certs) ? cJson.certs : [];
        const certs = [];
        for (const c of rawCerts) {
          if (!c || typeof c.filename !== "string" || !c.filename.trim()) continue;
          const ext = extOf(c.filename);
          const rel = encodePath(c.filename);
          const href = rel ? `assets/certs/${rel}` : "#";
          const preview = IMG_EXTS.has(ext) ? href : sanitizeUrl(c.preview_image, true) || null;
          certs.push({
            isCert: true,
            filename: c.filename,
            href,
            title: titleOf(stemOf(c.filename)),
            desc: c.description || "",
            alwaysDesc: true,
            preview,
            loading: !preview && ext === "pdf" && href !== "#" && typeof pdfjsLib !== "undefined",
            fallback: ["📄", (ext || "FILE").toUpperCase()],
          });
        }
        state.certs = certs;
      } else {
        state.errors.certs = certsRes.error;
      }

      if (Array.isArray(reposRes.data)) {
        const repos = [];
        for (const r of reposRes.data) {
          if (!r || r.fork) continue;
          const cacheKey = `r:${r.id}`;
          const cacheVer = r.pushed_at || String(r.size || 0);
          validRepoKeys.add(cacheKey);
          const cached = readPreviewCache(cacheKey, cacheVer, now);
          const preview = cached ? cached.preview : null;
          const checked = Boolean(cached && cached.hit);

          repos.push({
            href: r.html_url,
            title: titleOf(r.name),
            desc: r.description || "No description provided.",
            alwaysDesc: true,
            preview,
            loading: !preview && !checked && Boolean(r.default_branch && r.size > 0),
            fallback: ["💻", (r.language || "REPO").toUpperCase()],
            fullName: r.full_name,
            branch: encodePath(r.default_branch),
            cacheKey,
            cacheVer,
          });
        }
        state.repos = repos;
      } else {
        state.errors.repos = reposRes.error;
      }

      if (Array.isArray(gistsRes.data)) {
        const gists = [];
        for (const g of gistsRes.data) {
          if (!g) continue;
          const files = g.files || {};
          const { first, firstFile, imgUrl, textFile } = inspectGistFiles(files);
          const stem = stemOf(first);
          const rawDesc = (g.description || "").trim();
          const lowerDesc = rawDesc.toLowerCase();
          const hideDesc =
            !rawDesc || lowerDesc === first.toLowerCase() || lowerDesc === stem.toLowerCase();

          const cacheKey = `g:${g.id}`;
          const cacheVer = g.updated_at || textFile?.raw_url || "";
          validGistKeys.add(cacheKey);

          let preview = imgUrl;
          let checked = false;
          if (!preview && textFile) {
            const cached = readPreviewCache(cacheKey, cacheVer, now);
            if (cached) {
              preview = cached.preview;
              checked = true;
            }
          }

          gists.push({
            href: g.html_url,
            title: titleOf(stem),
            desc: hideDesc ? "" : rawDesc,
            preview,
            loading: !preview && !checked && Boolean(textFile),
            fallback: ["📝", firstFile?.language || (extOf(first) || "gist").toUpperCase()],
            files,
            textFile,
            cacheKey,
            cacheVer,
          });
        }
        state.gists = gists;
      } else {
        state.errors.gists = gistsRes.error;
      }

      if (validRepoKeys || validGistKeys) {
        for (const k of Object.keys(cache)) {
          if (
            (validRepoKeys && k.startsWith("r:") && !validRepoKeys.has(k)) ||
            (validGistKeys && k.startsWith("g:") && !validGistKeys.has(k))
          ) {
            delete cache[k];
            previewCacheDirty = true;
          }
        }
        scheduleCacheFlush();
      }

      ready = true;
      render();
      warmPreviews(currentTab).then(() => {
        for (const t of TABS) {
          if (t !== currentTab) warmPreviews(t);
        }
      });
    } finally {
      grid.setAttribute("aria-busy", "false");
    }
  }

  function inspectGistFiles(files) {
    let firstKey = "";
    let firstFile = null;
    let imgUrl = null;
    let mdFile = null;
    let htmlFile = null;
    let textFile = null;

    for (const [k, f] of Object.entries(files)) {
      if (!firstKey) {
        firstKey = k;
        firstFile = f;
      }
      if (!f) continue;

      const ext = extOf(k);
      if (!imgUrl && f.raw_url && IMG_EXTS.has(ext)) {
        imgUrl = sanitizeUrl(f.raw_url);
      }

      const lang = f.language;
      if (!mdFile && (RE_MD_EXT.test(ext) || lang === "Markdown")) {
        mdFile = f;
      } else if (!htmlFile && (RE_HTML_EXT.test(ext) || lang === "HTML")) {
        htmlFile = f;
      } else if (!textFile && (!ext || lang === "Text")) {
        textFile = f;
      }
    }

    const bestText = mdFile || htmlFile || textFile;
    return {
      first: firstKey || "Gist",
      firstFile,
      imgUrl,
      textFile:
        bestText && bestText.raw_url && !(typeof bestText.size === "number" && bestText.size > 512 * 1024)
          ? bestText
          : null,
    };
  }

  async function fetchJson(url, cacheKey, shrink) {
    let cachedEntry = null;
    if (cacheKey) {
      const raw = storageGet(cacheKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "data" in parsed) {
            cachedEntry = parsed;
          } else if (Array.isArray(parsed)) {
            cachedEntry = { data: parsed };
          }
        } catch {}
      }
    }

    try {
      const headers = cachedEntry?.etag ? { "If-None-Match": cachedEntry.etag } : undefined;
      let res;
      try {
        res = await fetch(url, headers ? { headers } : undefined);
      } catch (err) {
        if (!headers) throw err;
        res = await fetch(url);
      }

      if (res.status === 304 && cachedEntry) {
        return { data: cachedEntry.data };
      }
      if (!res.ok) {
        throw new Error(
          res.status === 403 || res.status === 429
            ? "GitHub API rate limit exceeded."
            : `Failed to load (HTTP ${res.status}).`
        );
      }
      const data = await res.json();
      if (cacheKey) {
        const etag = res.headers.get("etag") || undefined;
        const shrunk = shrink ? shrink(data) : data;
        storageSet(cacheKey, JSON.stringify({ etag, data: shrunk }));
      }
      return { data };
    } catch (err) {
      if (cachedEntry?.data) return { data: cachedEntry.data };
      return { error: err?.message || "Network error." };
    }
  }

  /* =========================================================
     16:9 Preview Loading & Caching
     ========================================================= */

  function pool(limit, items, fn) {
    if (!items.length) return Promise.resolve();
    let i = 0;
    const workers = Math.min(limit, items.length);
    return Promise.all(
      Array.from({ length: workers }, async () => {
        while (i < items.length) {
          const item = items[i++];
          try {
            await fn(item);
          } catch {} finally {
            if (item.loading) finishPreviewCheck(item);
          }
        }
      })
    );
  }

  function warmPreviews(tab) {
    if (tasks[tab]) return tasks[tab];
    const items = state[tab].filter((it) => !it.preview && it.loading);

    const warmText = (getUrl, resolveImg) =>
      pool(6, items, async (it) => {
        const res = await fetch(getUrl(it));
        if (!res.ok) {
          if (res.status === 404) writePreviewCache(it.cacheKey, it.cacheVer, "");
          return;
        }
        const img = extractFirstImage(await res.text(), (u) => resolveImg(u, it));
        writePreviewCache(it.cacheKey, it.cacheVer, img || "");
        if (img) updatePreview(it, img);
      }).finally(flushPreviewCache);

    if (tab === "repos") {
      tasks[tab] = warmText(
        (r) => `https://raw.githubusercontent.com/${r.fullName}/${r.branch}/README.md`,
        (u, r) => resolveRepoImg(u, r.fullName, r.branch)
      );
    } else if (tab === "certs") {
      tasks[tab] = pool(2, items, async (c) => {
        try {
          const img = await renderPdf(c.href);
          if (img) updatePreview(c, img);
        } catch (err) {
          console.error(`Error rendering PDF preview for ${c.filename}:`, err);
        }
      });
    } else if (tab === "gists") {
      tasks[tab] = warmText(
        (g) => g.textFile.raw_url,
        (u, g) => resolveGistImg(u, g.files)
      );
    }

    return tasks[tab];
  }

  async function renderPdf(url) {
    const task = pdfjsLib.getDocument(url);
    let canvas, pdf, page;

    try {
      pdf = await task.promise;
      page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(1.5, 720 / Math.max(1, base.width), 1080 / Math.max(1, base.height)),
      });

      canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return null;

      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const blob = await new Promise((r) => canvas.toBlob(r, "image/webp", 0.85));
      return blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/jpeg", 0.85);
    } finally {
      if (canvas) canvas.width = canvas.height = 0;
      try {
        page?.cleanup?.();
        await pdf?.destroy?.();
        await task.destroy?.();
      } catch {}
    }
  }

  /* =========================================================
     Image Extraction & URL Safety
     ========================================================= */

  function isLikelyBadge(url) {
    try {
      const u = new URL(url, "https://r.invalid/");
      const host = u.hostname.toLowerCase();
      if (
        host === "img.shields.io" ||
        host === "badgen.net" ||
        host === "badge.fury.io" ||
        host === "coveralls.io" ||
        host === "codecov.io" ||
        host === "david-dm.org" ||
        host.endsWith(".shields.io")
      ) {
        return true;
      }
      if (/\/badge\.svg$|\/workflows\/[^/]+\/badge\.svg/i.test(u.pathname)) return true;
    } catch {}
    return false;
  }

  function extractFirstImage(content, resolveFn) {
    if (!content || !/!\[|<img/i.test(content)) return null;

    let clean = content;
    if (clean.includes("```") || clean.includes("~~~")) {
      const parts = [];
      let fenceChar = "";
      let fenceLen = 0;

      for (const line of clean.split(/\r?\n/)) {
        if (fenceLen) {
          const m = RE_FENCE_CLOSE.exec(line);
          if (m && m[1][0] === fenceChar && m[1].length >= fenceLen) fenceLen = 0;
        } else if (line.includes("```") || line.includes("~~~")) {
          const m = RE_FENCE_OPEN.exec(line);
          if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
            fenceChar = m[1][0];
            fenceLen = m[1].length;
          } else {
            parts.push(line);
          }
        } else {
          parts.push(line);
        }
      }
      clean = parts.join("\n");
    }

    clean = clean
      .replace(/<!--(?:[^-]|-(?!->))*-->/g, "")
      .replace(/``[^`\r\n]+``|`[^`\r\n]+`/g, "");

    const reImg =
      /!\[[^\]]*\]\(\s*(?:<([^>]+)>|(?![\s)])([^\s()]*(?:\([^\s()]*\)[^\s()]*)*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)|!\[([^\]]*)\]\[([^\]]*)\]|<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;

    let m;
    let refs = null;

    while ((m = reImg.exec(clean))) {
      let raw = "";
      if (m[1] || m[2]) {
        raw = (m[1] || m[2]).trim();
      } else if (m[3] !== undefined) {
        if (!refs) {
          refs = new Map();
          for (const rm of clean.matchAll(/^[ \t]{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm)) {
            const k = rm[1].trim().toLowerCase();
            if (k && !refs.has(k)) refs.set(k, (rm[2] || rm[3]).trim());
          }
        }
        raw = refs.get((m[4] || m[3]).trim().toLowerCase()) || "";
      } else {
        raw = (m[5] || m[6] || m[7] || "").replace(/&amp;|&#(?:38|x26);/gi, "&").trim();
      }

      if (raw) {
        const url = resolveFn(raw);
        const safe = url && sanitizeUrl(url, true);
        if (safe && !isLikelyBadge(safe)) return safe;
      }
    }

    return null;
  }

  function resolveRepoImg(raw, fullName, branch) {
    if (RE_DATA_PREFIX.test(raw)) return raw;
    const url = raw.startsWith("//") ? `https:${raw}` : raw;

    if (RE_HTTP_PREFIX.test(url)) {
      try {
        const u = new URL(url);
        if (
          u.hostname.toLowerCase() === "github.com" &&
          /^\/[^/]+\/[^/]+\/blob\//i.test(u.pathname) &&
          !u.searchParams.has("raw")
        ) {
          u.searchParams.set("raw", "true");
        }
        return u.href;
      } catch {
        return null;
      }
    }

    if (RE_SCHEME.test(url)) return null;
    const rel = url.replace(RE_REL_PREFIX, "");
    if (!rel) return null;

    try {
      const prefix = `/${fullName}/${branch}/`;
      const u = new URL(rel, `https://raw.githubusercontent.com${prefix}`);
      return u.origin === "https://raw.githubusercontent.com" && u.pathname.startsWith(prefix)
        ? u.href
        : null;
    } catch {
      return null;
    }
  }

  function resolveGistImg(raw, files) {
    if (RE_DATA_PREFIX.test(raw)) return raw;
    const url = raw.startsWith("//") ? `https:${raw}` : raw;
    if (RE_HTTP_PREFIX.test(url)) return url;
    if (RE_SCHEME.test(url) || !files) return null;

    const qIdx = url.search(/[?#]/);
    const clean = (qIdx >= 0 ? url.slice(0, qIdx) : url).replace(RE_REL_PREFIX, "");
    if (!clean) return null;

    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {}
    const slashIdx = decoded.lastIndexOf("/");
    const base = slashIdx >= 0 ? decoded.slice(slashIdx + 1) : decoded;
    return files[clean]?.raw_url || files[decoded]?.raw_url || (base && files[base]?.raw_url) || null;
  }

  function sanitizeUrl(raw, allowData = false, allowBlob = false) {
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s || RE_CTRL.test(s) || s.startsWith("\\")) return null;

    if (allowData && RE_DATA_URI.test(s)) return s;
    if (allowBlob && s.slice(0, 5).toLowerCase() === "blob:") {
      try {
        const u = new URL(s);
        return u.protocol === "blob:" && RE_BLOB_ORIGIN.test(u.href) ? u.href : null;
      } catch {
        return null;
      }
    }
    if (!s.startsWith("//") && !RE_SCHEME.test(s)) {
      try {
        return new URL(s, "https://r.invalid/").origin === "https://r.invalid" ? s : null;
      } catch {
        return null;
      }
    }
    try {
      const u = new URL(s.startsWith("//") ? `https:${s}` : s);
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
    } catch {
      return null;
    }
  }

  /* =========================================================
     DOM Rendering
     ========================================================= */

  function render() {
    const grid = document.getElementById("grid-container");
    if (!grid) return;

    renderedBoxes.clear();
    const items = state[currentTab];
    if (!items.length) {
      const err = state.errors[currentTab];
      const msg = err
        ? currentTab === "certs"
          ? "Unable to load certificates."
          : err
        : `No ${EMPTY_LABELS[currentTab]} found.`;
      grid.replaceChildren(msgNode(msg, Boolean(err)));
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < items.length; i++) {
      frag.append(createCard(items[i], i));
    }
    grid.replaceChildren(frag);
  }

  function createCard(item, index = 0) {
    const card = el("a", "card");
    card.href = sanitizeUrl(item.href) || "#";
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.style.setProperty("--card-index", String(index));

    const box = fillPreview(item, el("div", "card-preview"));
    renderedBoxes.set(item, box);
    card.append(box);

    const header = el("div", "card-header-row", el("h3", "card-title", item.title));
    const body = el("div", "card-body", header);
    if (item.alwaysDesc || item.desc) body.append(el("p", "card-desc", item.desc));

    card.append(body);
    return card;
  }

  function finishPreviewCheck(item) {
    item.loading = false;
    const box = renderedBoxes.get(item);
    if (box) box.classList.remove("is-loading");
  }

  function updatePreview(item, rawUrl) {
    const safe = sanitizeUrl(rawUrl, true, true);
    if (!safe) return;
    item.preview = safe;
    item.loading = false;

    const box = renderedBoxes.get(item);
    if (box) fillPreview(item, box);
  }

  function fillPreview(item, box) {
    const src = item.preview;
    box.classList.toggle("is-loading", Boolean(item.loading && !src));

    if (src) {
      const img = el("img");
      img.alt = item.title;
      img.loading = "lazy";
      img.decoding = "async";
      if (item.isCert || item.contain) img.classList.add("is-contain");

      img.addEventListener(
        "load",
        () => {
          if (!item.isCert && img.naturalWidth > 0 && img.naturalHeight > 0) {
            const ratio = img.naturalWidth / img.naturalHeight;
            if (ratio < 1.15 || ratio > 2.6) {
              item.contain = true;
              img.classList.add("is-contain");
            }
          }
        },
        { once: true }
      );
      img.addEventListener(
        "error",
        () => {
          if (src.startsWith("blob:")) URL.revokeObjectURL(src);
          item.preview = null;
          item.loading = false;
          item.contain = false;
          if (item.cacheKey) deletePreviewCache(item.cacheKey);
          fillPreview(item, box);
        },
        { once: true }
      );
      img.src = src;
      box.replaceChildren(img);
    } else if (item.fallback) {
      box.replaceChildren(
        el("div", "card-preview-fallback", item.fallback[0], el("span", "", item.fallback[1]))
      );
    }
    return box;
  }

  /* =========================================================
     Helpers
     ========================================================= */

  function el(tag, className, ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function msgNode(text, isError = false) {
    return el("div", isError ? "loading-state is-error" : "loading-state", text);
  }

  const titleOf = (s) => String(s || "").replace(/[-_]+/g, " ").trim();
  const stemOf = (f) => {
    const i = f.lastIndexOf(".");
    return i > 0 ? f.slice(0, i) : f;
  };
  const extOf = (f) => {
    const i = f.lastIndexOf(".");
    return i > 0 && i < f.length - 1 ? f.slice(i + 1).toLowerCase() : "";
  };
  const encodePath = (p) =>
    String(p || "")
      .trim()
      .split("/")
      .filter((s) => s && s !== "." && s !== "..")
      .map((s) => {
        try {
          return decodeURIComponent(s) === s ? encodeURIComponent(s) : s;
        } catch {
          return encodeURIComponent(s);
        }
      })
      .join("/");
})();