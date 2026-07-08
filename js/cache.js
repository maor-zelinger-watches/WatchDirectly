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
 * - wd_top_cache    — Top This Week first-page snapshot {videos, total, cursor}
 * - wd_channels     — curated creator list {creators} (small, fully cached)
 * - wd_my_stars     — starred channel names, instant paint before server reconcile
 * - wd_filter_types — persisted content-type chip selection ([] = "All")
 * ('wd_user' is the auth session, owned by auth.js — a credential, not a cache.)
 */

export const CACHE_KEYS = {
  FEED: 'wd_feed_cache',
  SEARCH_INDEX: 'wd_search_index',
  TOP: 'wd_top_cache',
  CHANNELS: 'wd_channels',
  STARS: 'wd_my_stars',
  FILTER_TYPES: 'wd_filter_types',
};

// The content-type values a saved selection may contain — must mirror the
// chips in views.js. Unknown values in a stored payload mean it's stale or
// tampered, so the whole payload is discarded and the default applies.
const VALID_FILTER_TYPES = ['video', 'article', 'short'];

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

// --- Top This Week (first-page snapshot, stale-while-revalidate) -----

/**
 * Loads the cached Top This Week first page.
 * Returns {videos, total, cursor} or null. Only the first ranked page is
 * cached — deeper pages are re-fetched on scroll — so the payload stays small
 * and the revalidate can fully reconcile (add/remove/reorder) the window it
 * covers. Invalid payloads (corrupt JSON, empty videos) are cleared.
 * `cursor` may be '' (end of the week) or a string; both are valid.
 */
export function loadTopCache() {
  const raw = read(CACHE_KEYS.TOP);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    const videos = Array.isArray(data.videos) ? data.videos : [];
    if (videos.length === 0) {
      remove(CACHE_KEYS.TOP);
      return null;
    }
    return {
      videos,
      total: typeof data.total === 'number' ? data.total : videos.length,
      cursor: typeof data.cursor === 'string' ? data.cursor : undefined,
    };
  } catch (e) {
    remove(CACHE_KEYS.TOP);
    return null;
  }
}

/** Saves the Top first-page snapshot. Best-effort — quota failures are silent. */
export function saveTopCache(videos, total, cursor) {
  if (!Array.isArray(videos) || videos.length === 0) return false;
  return write(CACHE_KEYS.TOP, JSON.stringify({ videos, total, cursor }));
}

export function clearTopCache() {
  remove(CACHE_KEYS.TOP);
}

// --- Channels (curated creator list, fully cached) -------------------

/**
 * Loads the cached creator list.
 * Returns an array of creators, or null when absent/corrupt. The list is
 * small and curated, so the whole thing is cached; a non-array or empty
 * payload is cleared and reported as absent so the tab rebuilds from network.
 */
export function loadChannelsCache() {
  const raw = read(CACHE_KEYS.CHANNELS);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    const creators = Array.isArray(data) ? data : (Array.isArray(data.creators) ? data.creators : null);
    if (!creators || creators.length === 0) {
      remove(CACHE_KEYS.CHANNELS);
      return null;
    }
    return creators;
  } catch (e) {
    remove(CACHE_KEYS.CHANNELS);
    return null;
  }
}

/** Saves the creator list. Best-effort — quota failures are silent. */
export function saveChannelsCache(creators) {
  if (!Array.isArray(creators) || creators.length === 0) return false;
  return write(CACHE_KEYS.CHANNELS, JSON.stringify({ creators }));
}

export function clearChannelsCache() {
  remove(CACHE_KEYS.CHANNELS);
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

// --- content-type filter selection (persists across sessions) --------

/**
 * Loads the saved content-type chip selection.
 * Returns an array of type values, or null when nothing was ever saved (so
 * the caller applies the default). A saved empty array [] is a real value —
 * it means the user chose "All" — and is returned as-is, distinct from null.
 * Corrupt payloads or ones with unknown type values are cleared and reported
 * as absent so the default takes over.
 */
export function loadFilterTypes() {
  const raw = read(CACHE_KEYS.FILTER_TYPES);
  if (raw === null) return null;

  try {
    const stored = JSON.parse(raw);
    if (!Array.isArray(stored) || stored.some(v => !VALID_FILTER_TYPES.includes(v))) {
      remove(CACHE_KEYS.FILTER_TYPES);
      return null;
    }
    // Normalize to canonical order and drop duplicates.
    return VALID_FILTER_TYPES.filter(v => stored.includes(v));
  } catch (e) {
    remove(CACHE_KEYS.FILTER_TYPES);
    return null;
  }
}

/** Saves the content-type chip selection ([] = "All"). Best-effort. */
export function saveFilterTypes(types) {
  if (!Array.isArray(types)) return false;
  return write(CACHE_KEYS.FILTER_TYPES, JSON.stringify(types));
}

export function clearFilterTypes() {
  remove(CACHE_KEYS.FILTER_TYPES);
}
