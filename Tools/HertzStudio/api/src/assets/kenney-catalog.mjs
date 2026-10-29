import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const DATA = process.env.HERTZ_STUDIO_DATA
  ? path.resolve(process.env.HERTZ_STUDIO_DATA)
  : path.join(ROOT, "data");
const CACHE_PATH = path.join(DATA, "kenney-catalog-cache.json");
const USER_AGENT = "HERTZ-Studio/0.1 (+local; Kenney free individual-pack index; no All-in-1)";
const CATEGORIES = Object.freeze(["2D", "3D", "UI", "Audio", "Pixel", "Textures"]);
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

function emptyCache() {
  return {
    version: 1,
    sourceUrl: "https://kenney.nl/assets",
    license: "CC0",
    packs: [],
    indexedAt: null,
    stale: true,
    lastError: null,
  };
}

function loadCache() {
  fs.mkdirSync(DATA, { recursive: true });
  if (!fs.existsSync(CACHE_PATH)) return emptyCache();
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return emptyCache();
  }
}

function saveCache(cache) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${CACHE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_PATH);
}

async function fetchText(url) {
  const ctrl = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: ctrl,
  });
  if (!res.ok) {
    const err = new Error(`Kenney HTTP ${res.status} for ${url}`);
    err.code = res.status === 429 ? "rate_limit" : "provider";
    throw err;
  }
  return res.text();
}

/**
 * Parse official Kenney listing HTML (server-rendered pack cards).
 * Does not invent download URLs — only pack page URLs.
 */
export function parseKenneyListingHtml(html, fallbackCategory = null) {
  const packs = [];
  const seen = new Set();
  // Official listing cards use class='cover' (formerly 'image') with background-image thumbnails.
  const cardRe =
    /<a href='(https:\/\/kenney\.nl\/assets\/([^'#?]+))'>\s*<div class='[^']*(?:cover|image)[^']*'\s+style='background-image:url\("([^"]+)"\)'><\/div>\s*<\/a>\s*<h2><a href='[^']+'>([^<]+)<\/a><\/h2>\s*<span class='bold text-muted'>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const sourceUrl = m[1];
    const slug = m[2];
    if (slug.startsWith("category:") || slug.startsWith("series:") || seen.has(slug)) continue;
    seen.add(slug);
    const thumb = m[3].startsWith("http") ? m[3] : `https://kenney.nl${m[3]}`;
    const title = m[4].trim();
    const metaHtml = m[5];
    const cats = [...metaHtml.matchAll(/category:([^']+)/g)].map((x) => decodeURIComponent(x[1]));
    const category = cats[0] || fallbackCategory || "2D";
    packs.push({
      id: `kenney:${slug}`,
      slug,
      name: title,
      description: `${title} — Kenney free individual pack (${category}).`,
      category,
      tags: cats,
      assetTypes: mapCategoryToTypes(category),
      sourceUrl,
      thumbnailUrl: thumb,
      license: "CC0",
      author: "Kenney",
      provider: "kenney",
      downloadUrl: null,
      downloadVerified: false,
      openOnKenney: sourceUrl,
    });
  }
  return packs;
}

function mapCategoryToTypes(category) {
  switch (category) {
    case "3D":
      return ["model_3d"];
    case "UI":
      return ["ui"];
    case "Audio":
      return ["audio"];
    case "Pixel":
      return ["pixel"];
    case "Textures":
      return ["texture"];
    case "2D":
    default:
      return ["sprite", "image_2d"];
  }
}

export async function refreshKenneyCatalog({ force = false } = {}) {
  const existing = loadCache();
  const age = existing.indexedAt ? Date.now() - Date.parse(existing.indexedAt) : Infinity;
  if (!force && existing.packs?.length && age < CACHE_TTL_MS) {
    return { ...existing, stale: false, fromCache: true };
  }

  try {
    const packs = [];
    const seen = new Set();
    for (const category of CATEGORIES) {
      const url = `https://kenney.nl/assets/category:${encodeURIComponent(category)}`;
      const html = await fetchText(url);
      for (const pack of parseKenneyListingHtml(html, category)) {
        if (seen.has(pack.slug)) continue;
        seen.add(pack.slug);
        packs.push(pack);
      }
    }
    // Also index home listing for packs that appear there.
    const home = await fetchText("https://kenney.nl/assets");
    for (const pack of parseKenneyListingHtml(home, null)) {
      if (seen.has(pack.slug)) continue;
      seen.add(pack.slug);
      packs.push(pack);
    }

    const cache = {
      version: 1,
      sourceUrl: "https://kenney.nl/assets",
      license: "CC0",
      packs,
      indexedAt: new Date().toISOString(),
      stale: false,
      lastError: null,
      note: "Cached index of official Kenney free individual packs. Direct ZIP download URLs are not invented; open the pack page or import a downloaded ZIP.",
    };
    saveCache(cache);
    return { ...cache, fromCache: false };
  } catch (err) {
    if (existing.packs?.length) {
      const stale = {
        ...existing,
        stale: true,
        lastError: err.message,
      };
      saveCache(stale);
      return { ...stale, fromCache: true, refreshFailed: true };
    }
    const empty = {
      ...emptyCache(),
      lastError: err.message,
      indexedAt: null,
    };
    saveCache(empty);
    throw err;
  }
}

export async function searchKenneyCatalog({
  q = "",
  category = "",
  page = 1,
  pageSize = 24,
  refresh = false,
} = {}) {
  let cache;
  try {
    cache = await refreshKenneyCatalog({ force: refresh });
  } catch (err) {
    return {
      provider: "kenney",
      pending: true,
      offline: true,
      stale: true,
      results: [],
      total: 0,
      page: 1,
      pageCount: 1,
      error: err.message,
      message: "Kenney catalog unavailable. Cached results empty.",
    };
  }

  let items = cache.packs || [];
  const needle = String(q || "").trim().toLowerCase();
  if (needle) {
    items = items.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.description.toLowerCase().includes(needle) ||
        p.category.toLowerCase().includes(needle) ||
        (p.tags || []).some((t) => t.toLowerCase().includes(needle)) ||
        (p.assetTypes || []).some((t) => t.toLowerCase().includes(needle)),
    );
  }
  if (category) {
    items = items.filter((p) => p.category.toLowerCase() === String(category).toLowerCase());
  }

  const total = items.length;
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(50, Math.max(1, Number(pageSize) || 24));
  const start = (p - 1) * size;
  const slice = items.slice(start, start + size);

  return {
    provider: "kenney",
    pending: false,
    offline: Boolean(cache.refreshFailed),
    stale: Boolean(cache.stale || cache.refreshFailed),
    indexedAt: cache.indexedAt,
    license: "CC0",
    sourceUrl: cache.sourceUrl,
    note: cache.note,
    lastError: cache.lastError,
    total,
    page: p,
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(total / size)),
    results: slice,
  };
}

export function getKenneyPack(idOrSlug) {
  const cache = loadCache();
  const slug = String(idOrSlug || "").replace(/^kenney:/, "");
  return (cache.packs || []).find((p) => p.slug === slug || p.id === idOrSlug) || null;
}

export { CATEGORIES as KENNEY_CATALOG_CATEGORIES, CACHE_PATH as KENNEY_CACHE_PATH };
