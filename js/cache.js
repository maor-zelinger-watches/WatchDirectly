/**
 * cache.js — Client-side persistence for WatchDirectly
 *
 * Single owner of every localStorage key the feed writes. Import from
 * here instead of touching localStorage directly, so cache behavior is
 * testable in isolation and storage failures are handled in one place.
 *
 * Guarantees:
 * - Reads self-heal: a corrupt or invalid payload is cleared and reported
 *   as absent, never thrown.
 * - Writes never throw: quota errors and private-browsing restrictions
 *   degrade to "no cache" (the app re-fetches), not a crash.
 *
 * Keys owned here:
 * - wd_feed_cache   — page-1 feed snapshot {videos, total} (stale-while-revalidate)
 * - wd_search_index — full catalog for search {videos} (stale-while-revalidate)
 * - wd_my_stars     — starred channel names, instant paint before server reconcile
 * - wd_show_shorts  — Shorts toggle preference
 * ('wd_user' is the auth session, owned by auth.js — a credential, not a cache.)
 */

export const CACHE_KEYS = {
  FEED: 'wd_feed_cache',
  SEARCH_INDEX: 'wd_search_index',
  STARS: 'wd_my_stars',
  SHOW_SHORTS: 'wd_show_shorts',
};

// --- storage primitives — never throw -------------------------------

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) { /* nothing to heal */ }
}

// --- feed cache (stale-while-revalidate snapshot) --------------------

/**
 * Loads the cached page-1 feed.
 * Returns {videos, total} or null. Invalid payloads (corrupt JSON,
 * non-array videos, missing/zero total — pagination math needs it)
 * are cleared and reported as absent.
 */
export function loadFeedCache() {
  const raw = read(CACHE_KEYS.FEED);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    const videos = Array.isArray(data.videos) ? data.videos : [];
    if (videos.length === 0 || typeof data.total !== 'number' || data.total === 0) {
      remove(CACHE_KEYS.FEED);
      return null;
    }
    return { videos, total: data.total };
  } catch (e) {
    remove(CACHE_KEYS.FEED);
    return null;
  }
}

/** Saves the page-1 feed snapshot. Best-effort — quota failures are silent. */
export function saveFeedCache(videos, total) {
  return write(CACHE_KEYS.FEED, JSON.stringify({ videos, total }));
}

export function clearFeedCache() {
  remove(CACHE_KEYS.FEED);
}

// --- search index (full catalog, stale-while-revalidate) -------------

/**
 * Loads the cached search index (the whole catalog).
 * Returns an array of videos, or null when absent/corrupt. A non-array
 * or empty payload is cleared and reported as absent so search rebuilds.
 */
export function loadSearchIndex() {
  const raw = read(CACHE_KEYS.SEARCH_INDEX);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    const videos = Array.isArray(data) ? data : (Array.isArray(data.videos) ? data.videos : null);
    if (!videos || videos.length === 0) {
      remove(CACHE_KEYS.SEARCH_INDEX);
      return null;
    }
    return videos;
  } catch (e) {
    remove(CACHE_KEYS.SEARCH_INDEX);
    return null;
  }
}

/**
 * Saves the full search index. Best-effort — the catalog can be large, so a
 * quota failure just leaves search to rebuild from the network next session.
 */
export function saveSearchIndex(videos) {
  if (!Array.isArray(videos) || videos.length === 0) return false;
  return write(CACHE_KEYS.SEARCH_INDEX, JSON.stringify({ videos }));
}

export function clearSearchIndex() {
  remove(CACHE_KEYS.SEARCH_INDEX);
}

// --- starred creators (instant paint, reconciled by the server) ------

/**
 * Loads the cached starred channel names as a Set.
 * Corrupt or non-array payloads are cleared and yield an empty Set.
 */
export function loadStarredChannels() {
  const raw = read(CACHE_KEYS.STARS);
  if (!raw) return new Set();

  try {
    const stored = JSON.parse(raw);
    if (!Array.isArray(stored)) {
      remove(CACHE_KEYS.STARS);
      return new Set();
    }
    return new Set(stored);
  } catch (e) {
    remove(CACHE_KEYS.STARS);
    return new Set();
  }
}

/** Saves starred channels. Accepts a Set or an array. */
export function saveStarredChannels(channels) {
  return write(CACHE_KEYS.STARS, JSON.stringify([...channels]));
}

export function clearStarredChannels() {
  remove(CACHE_KEYS.STARS);
}

// --- shorts toggle preference ----------------------------------------

/** Whether Shorts are visible. Defaults to true when unset or unreadable. */
export function loadShowShorts() {
  return read(CACHE_KEYS.SHOW_SHORTS) !== 'false';
}

export function saveShowShorts(show) {
  return write(CACHE_KEYS.SHOW_SHORTS, String(!!show));
}
