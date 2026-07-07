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
import { filterVideos, sortVideos } from './feed.js';
import { renderList } from './cards.js';
import { prefetchComments } from './comments-ui.js';
import { exitFullscreen } from './fullscreen.js';
import { isSignedIn } from './auth.js';
import { showToast } from './toast.js';
import { sanitizeHtml } from './utils.js';

/**
 * Loads the full catalog once (titles, channels, categories) so search
 * and filters work across everything, not just the pages scrolled so far.
 * If the catalog has outgrown SEARCH_INDEX_LIMIT, a second fetch sized
 * from the server's total grabs the whole thing — older videos must not
 * silently drop out of search.
 */
export function ensureSearchIndex() {
  if (state.searchIndex) return Promise.resolve(state.searchIndex);

  if (!state.searchIndexPromise) {
    state.searchIndexPromise = api.fetchFeed(1, CONFIG.SEARCH_INDEX_LIMIT)
      .then(data => {
        const videos = data.videos || [];
        if ((data.total || 0) > videos.length) {
          // Best-effort: a failed follow-up shouldn't discard the first page
          return api.fetchFeed(1, data.total)
            .then(full => full.videos || videos)
            .catch(() => videos);
        }
        return videos;
      })
      .then(videos => {
        state.searchIndex = videos;
        return state.searchIndex;
      })
      .catch(error => {
        // Allow a retry on the next keystroke
        state.searchIndexPromise = null;
        throw error;
      });
  }

  return state.searchIndexPromise;
}

export function setupFeedControls() {
  const input = document.getElementById('search-input');
  const chipsContainer = document.getElementById('category-chips');
  if (!input) return;

  // Category chips and the channel→host search map come from the curated creator list
  fetch('./creators.json')
    .then(r => r.json())
    .then(creators => {
      const categories = [...new Set(creators.map(c => c.category))];
      renderCategoryChips(chipsContainer, categories);
      const hosts = {};
      for (const c of creators) {
        if (c.channel_name && c.host) hosts[c.channel_name] = c.host;
      }
      state.hostsByChannel = hosts;
    })
    .catch(() => { /* chips are an enhancement — search still works without them */ });

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
  if (view === 'starred' && isSignedIn() && !state.searchIndex) {
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
  if (isFilterActive()) list = filterVideos(list, activeFilter());

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

function renderCategoryChips(container, categories) {
  if (!container) return;

  container.innerHTML = ['All', ...categories].map(label => {
    const value = label === 'All' ? '' : label;
    const active = value === state.filter.category ? ' chip--active' : '';
    return `<button type="button" class="chip${active}" data-category="${sanitizeHtml(value)}">${sanitizeHtml(label)}</button>`;
  }).join('');

  container.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      state.filter.category = chip.dataset.category;
      container.querySelectorAll('.chip').forEach(c => {
        c.classList.toggle('chip--active', c === chip);
      });
      update();
    });
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

  let index;
  try {
    index = await ensureSearchIndex();
  } catch (error) {
    console.error('Failed to load search index:', error);
    showToast('Search is unavailable right now. Please try again.', 'error');
    return;
  }

  // The filter or view may have changed while the index was loading
  if (token !== state.filterRenderToken || state.view !== 'latest') return;

  const matches = filterVideos(index, activeFilter());

  state.renderToken++;
  container.innerHTML = '';
  state.expandedComments.clear();
  sentinel.style.display = 'none';

  renderList(container, matches);

  empty.querySelector('p').textContent = 'No videos match your search.';
  empty.style.display = matches.length === 0 ? '' : 'none';

  prefetchComments(matches.slice(0, CONFIG.PAGE_SIZE));
}
