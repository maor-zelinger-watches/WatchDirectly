/**
 * views.js — View routing: tabs, search, and category filtering.
 *
 * Owns which list the feed container shows — the chronological Latest
 * feed, the Top This Week ranking, the Starred feed, or filtered search
 * results — and the search index that powers filtering across the whole
 * catalog. The paginated Latest feed itself (loading, prefetch,
 * revalidation) lives in app.js; this module only re-renders lists that
 * are already in memory.
 */

import { state, isFilterActive, activeFilter } from './state.js';
import { api } from './api-client.js';
import { CONFIG } from './config.js';
import { filterVideos, sortVideos, dedupeVideos } from './feed.js';
import { renderList } from './cards.js';
import { prefetchComments } from './comments-ui.js';
import { exitFullscreen } from './fullscreen.js';
import { isSignedIn } from './auth.js';
import { showToast } from './toast.js';
import { sanitizeHtml } from './utils.js';
import { loadFeedCache, loadSearchIndex, saveSearchIndex } from './cache.js';

// True while the current index build is running off a cached catalog, so a
// network failure can degrade to that cache instead of failing search.
let indexFromCache = false;

/** Fires every registered onProgress callback with the current (partial) index. */
function notifyIndexProgress() {
  for (const cb of state.searchIndexProgress) {
    // A stale render callback throwing must not abort the build for the others.
    try { cb(state.searchIndex); } catch (e) { /* ignore */ }
  }
}

/**
 * Instant, network-free starting point for search: everything already in
 * memory (the scrolled feed) plus the cached page-1 snapshot, deduped.
 * Lets the first keystroke match against something before any chunk lands.
 */
function seedFromMemory() {
  const parts = [];
  if (Array.isArray(state.videos) && state.videos.length) parts.push(...state.videos);
  const cachedFeed = loadFeedCache();
  if (cachedFeed && cachedFeed.videos.length) parts.push(...cachedFeed.videos);
  return dedupeVideos(parts);
}

/** Same identity key dedupeVideos uses: url when present, else video_id. */
function indexKey(v) {
  return v && v.url ? String(v.url).trim().toLowerCase() : `id:${v && v.video_id}`;
}

/**
 * Merges a freshly fetched chunk into the index. Fresh rows REPLACE stale
 * same-key rows — dedupeVideos' engagement contest is only right within a
 * single fetch (the doubled-article case); across fetches the re-fetched row
 * is newer truth even when its counts went down (an un-vote), so competing
 * on engagement would freeze counts at their cached high-water mark.
 * Keeps the index newest-first: chunks resolve in arbitrary order, and
 * category-only filtering renders index order directly.
 */
function mergeIndexChunk(index, chunkVideos) {
  const fresh = dedupeVideos(chunkVideos); // collapse intra-fetch doubles
  const freshKeys = new Set(fresh.map(indexKey));
  return sortVideos(index.filter(v => !freshKeys.has(indexKey(v))).concat(fresh));
}

/**
 * Fetches the whole catalog in parallel chunks, merging each into the live
 * index as it arrives (fresh rows replace stale seed/cache rows).
 * Every merge notifies progress subscribers so results paint incrementally.
 * Uses offset pagination — unlike cursors, pages are order-independent and
 * can be fetched concurrently. Returns the complete index.
 */
async function buildSearchIndex() {
  const chunk = CONFIG.SEARCH_CHUNK_SIZE;
  const cap = CONFIG.SEARCH_INDEX_LIMIT;

  // First chunk is the newest page and tells us the catalog total.
  const first = await api.fetchFeed(1, chunk);
  const firstVideos = first.videos || [];
  state.searchIndex = mergeIndexChunk(state.searchIndex || [], firstVideos);
  notifyIndexProgress();

  const total = Math.min(first.total || firstVideos.length, cap);
  if (firstVideos.length > 0 && total > firstVideos.length) {
    const pages = [];
    for (let p = 2; (p - 1) * chunk < total; p++) pages.push(p);
    await Promise.all(pages.map(p =>
      api.fetchFeed(p, chunk)
        .then(data => {
          state.searchIndex = mergeIndexChunk(state.searchIndex, data.videos || []);
          notifyIndexProgress();
        })
        // A dropped chunk just means those items miss this session's index.
        .catch(() => { /* best-effort */ })
    ));
  }

  return state.searchIndex;
}

/**
 * Ensures the full-catalog search index is (being) built, so search and
 * filters reach everything, not just the pages scrolled so far.
 *
 * Returns a promise that resolves with the COMPLETE index. Pass `onProgress`
 * to also paint partial results: it's called with the current index right
 * away (from an in-memory/cached seed) and again after each chunk merges in.
 * The seed makes the first keystroke feel instant; the resolved promise is
 * the authoritative final state (empty-state, prefetch) for callers to render.
 */
export function ensureSearchIndex(onProgress) {
  // Already complete: fire the callback once (don't retain it — there's no
  // build left to clear the subscriber set) and hand back the final index.
  if (state.searchIndexComplete) {
    if (typeof onProgress === 'function' && state.searchIndex && state.searchIndex.length) {
      try { onProgress(state.searchIndex); } catch (e) { /* ignore */ }
    }
    return Promise.resolve(state.searchIndex);
  }

  if (typeof onProgress === 'function') {
    state.searchIndexProgress.add(onProgress);
    // Late subscriber (index already seeded/partial): paint immediately.
    if (state.searchIndex && state.searchIndex.length) {
      try { onProgress(state.searchIndex); } catch (e) { /* ignore */ }
    }
  }

  // Seed synchronously so progress subscribers have something to show now.
  if (!state.searchIndex) {
    const cached = loadSearchIndex();
    if (cached && cached.length) {
      state.searchIndex = cached;
      indexFromCache = true;
    } else {
      state.searchIndex = seedFromMemory();
      indexFromCache = false;
    }
    if (state.searchIndex.length) notifyIndexProgress();
  }

  if (!state.searchIndexPromise) {
    state.searchIndexPromise = buildSearchIndex()
      .then(full => {
        state.searchIndex = full;
        state.searchIndexComplete = true;
        saveSearchIndex(full);
        state.searchIndexProgress.clear();
        return full;
      })
      .catch(error => {
        // A cached catalog is a good-enough fallback — run the session on it
        // rather than failing search outright over a flaky network.
        if (indexFromCache && state.searchIndex && state.searchIndex.length) {
          state.searchIndexComplete = true;
          state.searchIndexProgress.clear();
          return state.searchIndex;
        }
        // Nothing usable — reset so the next keystroke retries from scratch.
        state.searchIndexPromise = null;
        state.searchIndex = null;
        state.searchIndexProgress.clear();
        throw error;
      });
  }

  return state.searchIndexPromise;
}

export function setupFeedControls() {
  const input = document.getElementById('search-input');
  const chipsContainer = document.getElementById('category-chips');
  if (!input) return;

  // Content-type chips are a fixed set — render them right away, no fetch needed.
  renderTypeChips(chipsContainer);

  // The channel→host map (search matching) still comes from the creator list.
  fetch('./creators.json')
    .then(r => r.json())
    .then(creators => {
      const hosts = {};
      for (const c of creators) {
        if (c.channel_name && c.host) hosts[c.channel_name] = c.host;
      }
      state.hostsByChannel = hosts;
    })
    .catch(() => { /* host matching is an enhancement — search still works without it */ });

  // Warm the search index as soon as the user shows intent
  input.addEventListener('focus', () => {
    ensureSearchIndex().catch(() => {});
  }, { once: true });

  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.filter.query = input.value;
      update();
    }, 250);
  });
}

/**
 * Renders whichever view is active, honoring the current search/filter.
 * Single entry point for the search box, chips, and tab switches.
 */
export function update() {
  // Every render path may wipe the container — never destroy an active
  // fullscreen card (it would leave the page scroll-locked with no exit).
  if (state.fullscreenVideoId) exitFullscreen();

  if (state.view === 'top') {
    renderTop();
  } else if (state.view === 'starred') {
    renderStarred();
  } else {
    applyFilter();
  }
}

export function setupTabs() {
  document.querySelectorAll('.feed-tab').forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
}

// Bumped on every tab switch so an older switch's async work (top list,
// starred index) can't repaint — or error-revert — the tab the user has
// since moved on from.
let viewToken = 0;

/**
 * Switches between the chronological "Latest" feed and the "Top This Week"
 * upvote ranking. The top list is fetched once, then cached for the session.
 */
async function switchView(view) {
  if (view === state.view) return;
  const token = ++viewToken;
  state.view = view;

  document.querySelectorAll('.feed-tab').forEach(t => {
    const active = t.dataset.view === view;
    t.classList.toggle('feed-tab--active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  window.scrollTo({ top: 0 });

  // A superseded switch bails before its skeleton cleanup — clear any
  // skeleton it left showing before this view takes over the container.
  document.getElementById('feed-skeleton').style.display = 'none';

  if (view === 'top' && !state.topLoaded) {
    const container = document.getElementById('feed-container');
    const skeleton = document.getElementById('feed-skeleton');
    const sentinel = document.getElementById('load-more-container');
    state.renderToken++;
    container.innerHTML = '';
    state.expandedComments.clear();
    sentinel.style.display = 'none';
    skeleton.style.display = '';
    try {
      const data = await api.fetchTopWeek(50);
      // Cache the list even if this switch is stale — reopening the tab
      // then renders instantly. Only the DOM work below needs the guard.
      state.topVideos = data.videos || [];
      // Don't freeze an empty result for the whole session. An empty list can
      // come from a transient hiccup or a refresh still in flight; leaving
      // topLoaded false lets reopening the tab refetch instead of sticking.
      state.topLoaded = state.topVideos.length > 0;
    } catch (e) {
      console.error('Failed to load top videos:', e);
      // A newer switch owns the tabs and container now — don't yank the
      // user to Latest over a request they've already navigated away from.
      if (token !== viewToken) return;
      showToast('Failed to load top videos. Please try again.', 'error');
      state.view = 'latest';
      document.querySelectorAll('.feed-tab').forEach(t => {
        const active = t.dataset.view === 'latest';
        t.classList.toggle('feed-tab--active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      skeleton.style.display = 'none';
      applyFilter();
      return;
    }
    if (token !== viewToken) return;
    skeleton.style.display = 'none';
  }

  // First open of Starred needs the full catalog — show the skeleton
  // while it loads instead of leaving the previous view's cards up.
  if (view === 'starred' && isSignedIn() && !state.searchIndexComplete) {
    const container = document.getElementById('feed-container');
    const skeleton = document.getElementById('feed-skeleton');
    const sentinel = document.getElementById('load-more-container');
    state.renderToken++;
    container.innerHTML = '';
    state.expandedComments.clear();
    sentinel.style.display = 'none';
    skeleton.style.display = '';
    try {
      await ensureSearchIndex();
    } catch (e) {
      /* renderStarred surfaces the error toast */
    }
    if (token !== viewToken) return;
    skeleton.style.display = 'none';
  }

  // Only the most recent switch may repaint — a stale update() here
  // caused redundant re-renders and lost scroll on rapid tab flips.
  if (token !== viewToken) return;
  update();
}

/**
 * Renders the Top This Week list (already fetched), honoring any active filter.
 * No infinite scroll — the weekly list is bounded.
 */
function renderTop() {
  const container = document.getElementById('feed-container');
  const sentinel = document.getElementById('load-more-container');
  const empty = document.getElementById('feed-empty');
  if (!container) return;

  sentinel.style.display = 'none';

  let list = state.topVideos || [];
  if (isFilterActive()) list = filterVideos(list, activeFilter());

  state.renderToken++;
  container.innerHTML = '';
  state.expandedComments.clear();
  renderList(container, list);

  empty.querySelector('p').textContent = isFilterActive()
    ? 'No videos match your search.'
    : 'No videos yet this week. Check back soon!';
  empty.style.display = list.length === 0 ? '' : 'none';

  prefetchComments(list.slice(0, CONFIG.PAGE_SIZE));
}

/**
 * Renders the Starred feed: every video from creators the signed-in user
 * has starred, newest first, honoring any active search filter.
 * Uses the full search index so starred feeds reach the whole catalog.
 */
async function renderStarred() {
  const container = document.getElementById('feed-container');
  const sentinel = document.getElementById('load-more-container');
  const empty = document.getElementById('feed-empty');
  if (!container) return;

  sentinel.style.display = 'none';

  if (!isSignedIn()) {
    state.renderToken++;
    container.innerHTML = '';
    state.expandedComments.clear();
    empty.querySelector('p').textContent = 'Sign in to see videos from your starred creators.';
    empty.style.display = '';
    return;
  }

  let index;
  try {
    index = await ensureSearchIndex();
  } catch (error) {
    console.error('Failed to load starred feed:', error);
    showToast('Starred feed is unavailable right now. Please try again.', 'error');
    // Show a visible fallback instead of a dead blank screen
    if (state.view === 'starred') {
      state.renderToken++;
      container.innerHTML = '';
      state.expandedComments.clear();
      empty.querySelector('p').textContent = 'Starred feed is unavailable right now. Please try again.';
      empty.style.display = '';
    }
    return;
  }

  // The view may have changed while the index was loading
  if (state.view !== 'starred') return;

  let list = sortVideos(index.filter(v => state.myStars.has(v.channel_name)));
  // Same render cap as applyFilter — a one-letter search over a large starred
  // catalog would otherwise paint thousands of cards in one go.
  if (isFilterActive()) list = filterVideos(list, activeFilter()).slice(0, CONFIG.SEARCH_RENDER_LIMIT);

  state.renderToken++;
  container.innerHTML = '';
  state.expandedComments.clear();
  renderList(container, list);

  empty.querySelector('p').textContent = state.myStars.size === 0
    ? 'No starred creators yet. Tap the ☆ next to a channel name to build your feed.'
    : (isFilterActive()
      ? 'No videos match your search.'
      : 'No videos from your starred creators yet.');
  empty.style.display = list.length === 0 ? '' : 'none';

  prefetchComments(list.slice(0, CONFIG.PAGE_SIZE));
}

// Fixed content-type chips. '' is the exclusive "All" chip; the rest map to
// mediaType() values and are multi-selectable.
const TYPE_CHIPS = [
  { value: '', label: 'All' },
  { value: 'video', label: 'Videos' },
  { value: 'article', label: 'Articles' },
  { value: 'short', label: 'Shorts' },
];
const ALL_TYPE_VALUES = TYPE_CHIPS.filter(c => c.value).map(c => c.value);

// Fired after every chip change, once visibility is applied. app.js registers
// the Latest-feed top-up here (pull more pages when the filtered feed is
// shallow) — registered rather than imported so views.js stays a dependency
// of app.js, not the other way around.
let onTypeFilterChanged = null;
export function setOnTypeFilterChanged(cb) { onTypeFilterChanged = cb; }

function renderTypeChips(container) {
  if (!container) return;

  container.innerHTML = TYPE_CHIPS.map(({ value, label }) =>
    `<button type="button" class="chip" data-type="${sanitizeHtml(value)}">${sanitizeHtml(label)}</button>`
  ).join('');

  container.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      toggleType(chip.dataset.type);
      syncTypeChips(container);
      // Pure CSS visibility flip — no re-render, no search-index build.
      // Re-rendering here is what froze the app: a type-only filter matches
      // most of the catalog, and painting thousands of cards per click
      // (again per index chunk) locked the main thread.
      applyTypeVisibility();
      if (onTypeFilterChanged) onTypeFilterChanged();
    });
  });

  syncTypeChips(container);
  applyTypeVisibility();
}

/**
 * Reflects state.filter.types onto the feed container as one
 * feed--hide-<type> class per deselected type. Cards carry data-media-type,
 * so hiding is pure CSS — instant, and it composes with every view (Latest,
 * Top, Starred, search results) because they all render into this container
 * and the container element itself is never replaced.
 */
export function applyTypeVisibility() {
  const container = document.getElementById('feed-container');
  if (!container) return;
  const selected = new Set(state.filter.types);
  const showAll = selected.size === 0;
  for (const value of ALL_TYPE_VALUES) {
    container.classList.toggle(`feed--hide-${value}`, !showAll && !selected.has(value));
  }
}

/**
 * Applies the multi-select rules to state.filter.types:
 * - "All" (empty value) clears every type selection.
 * - Any type toggles on/off, and clears "All".
 * - Selecting every type (or clearing the last one) collapses back to "All".
 */
function toggleType(value) {
  if (!value) {
    state.filter.types = [];
    return;
  }
  const set = new Set(state.filter.types);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  // Everything selected is the same as nothing selected: "All".
  state.filter.types = ALL_TYPE_VALUES.every(v => set.has(v)) ? [] : [...set];
}

/** Reflects state.filter.types onto the chip active classes. */
function syncTypeChips(container) {
  const selected = new Set(state.filter.types);
  container.querySelectorAll('.chip').forEach(chip => {
    const value = chip.dataset.type;
    const active = value ? selected.has(value) : selected.size === 0;
    chip.classList.toggle('chip--active', active);
  });
}

/**
 * Renders the feed for the current filter state.
 * Active filter: matches from the full search index, no infinite scroll.
 * Cleared filter: restores the normal paginated feed from state.videos.
 */
async function applyFilter() {
  const container = document.getElementById('feed-container');
  const sentinel = document.getElementById('load-more-container');
  const empty = document.getElementById('feed-empty');
  if (!container) return;

  const token = ++state.filterRenderToken;

  if (!isFilterActive()) {
    // Restore the normal infinite-scroll feed
    state.renderToken++;
    container.innerHTML = '';
    state.expandedComments.clear();
    renderList(container, state.videos);
    empty.querySelector('p').textContent = 'No videos yet. Check back soon!';
    empty.style.display = state.videos.length === 0 ? '' : 'none';
    sentinel.style.display = state.hasMore ? '' : 'none';
    return;
  }

  sentinel.style.display = 'none';

  // Paints the matches for the current index snapshot. `final` is held back
  // until the index is complete — a slow chunk that would add a match must
  // not flash "No videos match" or prefetch a soon-to-change result set.
  const renderMatches = (index, final) => {
    if (token !== state.filterRenderToken || state.view !== 'latest') return;
    const matches = filterVideos(index, activeFilter());
    // A broad query (a single letter matches almost everything) must not
    // paint the whole index — cap the render; results are ranked best-first.
    const shown = matches.slice(0, CONFIG.SEARCH_RENDER_LIMIT);
    state.renderToken++;
    container.innerHTML = '';
    state.expandedComments.clear();
    renderList(container, shown);
    if (matches.length > shown.length) {
      const note = document.createElement('p');
      note.className = 'feed-truncation-note';
      note.textContent = `Showing the top ${shown.length} of ${matches.length} matches — keep typing to narrow your search.`;
      container.appendChild(note);
    }
    empty.querySelector('p').textContent = 'No videos match your search.';
    empty.style.display = (final && matches.length === 0) ? '' : 'none';
    if (final) prefetchComments(shown.slice(0, CONFIG.PAGE_SIZE));
  };

  let index;
  try {
    // Render each chunk as it lands; the promise resolves with the full index.
    index = await ensureSearchIndex(partial => renderMatches(partial, false));
  } catch (error) {
    if (token !== state.filterRenderToken || state.view !== 'latest') return;
    console.error('Failed to load search index:', error);
    showToast('Search is unavailable right now. Please try again.', 'error');
    return;
  }

  renderMatches(index, true);
}
