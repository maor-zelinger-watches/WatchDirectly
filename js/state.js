/**
 * state.js — Shared mutable application state.
 *
 * A single object every feature module imports and mutates directly —
 * the same discipline app.js used before it was split, now with one
 * owner file. Fields are grouped by the module that primarily drives
 * them; cross-module reads are expected (e.g. prefetch checks view,
 * views check hasMore).
 *
 * Derived helpers that are pure reads of this state live here too, so
 * modules don't need to reach into each other for them.
 */

export const state = {
  videos: [],          // All loaded videos so far
  currentPage: 0,      // Last page that was loaded
  totalVideos: 0,      // Total available from API
  nextCursor: undefined, // server cursor after the last rendered page:
                         // string = resume here ('' = end of catalog),
                         // undefined = backend without cursors (page math)
  loading: false,      // Prevents concurrent fetches
  hasMore: true,       // Whether more pages exist
  expandedComments: new Set(),
  commentsCache: {},   // videoId -> { comments, tree } — prefetched comment data
  initialLoadComplete: false,
  filter: { query: '', types: [] }, // types: content-type multi-select ('video'|'article'|'short');
                                    // [] === All. Applied as pure CSS visibility, never a re-render.
  searchIndex: null,        // videos available to search — seeded from memory/cache,
                            // grows as index chunks land (may be partial mid-build)
  searchIndexComplete: false, // true once the whole catalog is loaded (or restored
                              // from cache); until then searchIndex is best-effort
  searchIndexPromise: null, // in-flight index build (dedupes concurrent requests)
  searchIndexProgress: new Set(), // onProgress callbacks fired as chunks merge in
  filterRenderToken: 0,     // invalidates stale filter renders after async index load
  view: 'latest',           // 'latest' (chronological), 'top' (weekly upvotes), 'starred', or 'channels'
  prefetchBuffer: [],       // [{page, videos}] fetched ahead, contiguous from currentPage+1
  prefetching: false,       // single refill loop at a time
  prefetchToken: 0,         // invalidates in-flight refills when pagination resets
  pendingFetchPage: 0,      // page loadNextPage is fetching on demand (0 = none)
  revalidating: false,      // revalidateFeed owns the DOM — pagination pauses
  topVideos: null,          // cached Top This Week list
  topLoaded: false,         // whether the top list has been fetched
  myVotes: new Set(),       // video IDs the signed-in user has upvoted
  myStars: new Set(),       // channel names the signed-in user has starred
  hostsByChannel: {},       // channel_name -> host, from creators.json (search matching)
  creators: null,           // full creators.json list, loaded once (Channels tab + host map)
  renderToken: 0,           // invalidates deferred short inserts after a re-render
  fullscreenVideoId: null,      // video expanded to fullscreen, or null
  fullscreenReturnId: null,     // topmost visible card before fullscreen (scroll anchor)
  fullscreenReturnScrollY: 0,   // exact scroll offset before fullscreen
  fullscreenReturnAnchorTop: null, // the anchor card's viewport offset before fullscreen
};

export function isFilterActive() {
  // Only the query counts: it re-routes rendering through the search index.
  // The type chips (filter.types) are a pure CSS visibility filter and must
  // NOT pause pagination — the feed keeps loading beneath them.
  return !!state.filter.query.trim();
}

/** The current filter plus the channel→host map used for query matching. */
export function activeFilter() {
  return { ...state.filter, hostsByChannel: state.hostsByChannel };
}
