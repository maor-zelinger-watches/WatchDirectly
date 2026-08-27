/**
 * cache.js — Client-side persistence for How You Watch
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

// --- cache freshness (schema version + TTL) --------------------------
//
// The large stale-while-revalidate snapshots (feed, search index) carry a
// {version, savedAt} envelope. A payload whose version doesn't match this
// build's schema, or that's older than the TTL, is treated as absent and
// self-heals (cleared on read) exactly like a corrupt one — so a flaky build
// can't strand a session on a months-old catalog with no way to notice.

export const CACHE_VERSION = 1;      // bump when a payload's shape changes
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/** Wraps a payload with the current schema version and a save timestamp. */
function stamp(payload) {
  return { ...payload, version: CACHE_VERSION, savedAt: Date.now() };
}

/** True only for a payload of the current version saved within the TTL. */
function isFresh(data) {
  return !!data
    && data.version === CACHE_VERSION
    && typeof data.savedAt === 'number'
    && (Date.now() - data.savedAt) <= CACHE_MAX_AGE_MS;
}

// --- feed cache (stale-while-revalidate snapshot) --------------------

/**
 * Loads the cached page-1 feed.
 * Returns {videos, total} or null. Payloads that are corrupt JSON, stale
 * (wrong version or older than the TTL), or invalid (non-array videos,
 * missing/zero total — pagination math needs it) are cleared and reported
 * as absent.
 */
export function loadFeedCache() {
  const raw = read(CACHE_KEYS.FEED);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    if (!isFresh(data)) {
      remove(CACHE_KEYS.FEED);
      return null;
    }
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
  return write(CACHE_KEYS.FEED, JSON.stringify(stamp({ videos, total })));
}

export function clearFeedCache() {
  remove(CACHE_KEYS.FEED);
  cancelPendingFeedSnapshot();
}

// Coalesced, capped feed-cache write for the hot path (votes/comments).
//
// A full JSON.stringify of the accumulated feed on every vote/comment (twice
// per vote, counting the reconcile) is wasted work: the restore only needs the
// top pages, and back-to-back mutations each re-serialize the whole list. So
// this defers the write to an idle callback (falling back to a trailing timer),
// keeps only the LATEST snapshot, and caps it to the first N items.
export const FEED_CACHE_SNAPSHOT_MAX = 60; // ~6 pages at PAGE_SIZE 10; the deep
                                           // tail re-fetches on scroll

let pendingFeedSnapshot = null;
let feedSnapshotHandle = null;
let feedSnapshotViaIdle = false;

function flushFeedSnapshot() {
  feedSnapshotHandle = null;
  const snap = pendingFeedSnapshot;
  pendingFeedSnapshot = null;
  if (!snap) return;
  const videos = Array.isArray(snap.videos)
    ? snap.videos.slice(0, FEED_CACHE_SNAPSHOT_MAX)
    : snap.videos;
  saveFeedCache(videos, snap.total);
}

/** Drops any queued snapshot so a clear isn't overwritten by a late write. */
function cancelPendingFeedSnapshot() {
  if (feedSnapshotHandle === null) return;
  if (feedSnapshotViaIdle && typeof globalThis.cancelIdleCallback === 'function') {
    globalThis.cancelIdleCallback(feedSnapshotHandle);
  } else if (!feedSnapshotViaIdle) {
    clearTimeout(feedSnapshotHandle);
  }
  feedSnapshotHandle = null;
  pendingFeedSnapshot = null;
}

/**
 * Queues a capped feed-cache write, coalescing bursts into one deferred save.
 * Never writes synchronously — the actual serialization runs at idle time (or
 * on a short trailing timer where requestIdleCallback is unavailable).
 */
export function saveFeedCacheSoon(videos, total) {
  pendingFeedSnapshot = { videos, total };
  if (feedSnapshotHandle !== null) return; // a flush is already queued
  const ric = typeof globalThis.requestIdleCallback === 'function'
    ? globalThis.requestIdleCallback
    : null;
  if (ric) {
    feedSnapshotViaIdle = true;
    feedSnapshotHandle = ric(flushFeedSnapshot, { timeout: 2000 });
  } else {
    feedSnapshotViaIdle = false;
    feedSnapshotHandle = setTimeout(flushFeedSnapshot, 500);
  }
}

// --- search index (full catalog, stale-while-revalidate) -------------

/**
 * Loads the cached search index (the whole catalog).
 * Returns an array of videos, or null when absent/corrupt/stale. A payload
 * that's the wrong version, older than the TTL, or non-array/empty is cleared
 * and reported as absent so search rebuilds. (A stale-version catalog would
 * otherwise run the whole session as the search corpus — see the module doc.)
 */
export function loadSearchIndex() {
  const raw = read(CACHE_KEYS.SEARCH_INDEX);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    if (!isFresh(data)) {
      remove(CACHE_KEYS.SEARCH_INDEX);
      return null;
    }
    const videos = Array.isArray(data.videos) ? data.videos : null;
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
  return write(CACHE_KEYS.SEARCH_INDEX, JSON.stringify(stamp({ videos })));
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
