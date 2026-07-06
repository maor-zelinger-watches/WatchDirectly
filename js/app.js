/**
 * app.js — Main application controller for WatchDirectly
 * 
 * Single-page feed with inline comments.
 * Infinite scroll: loads one page at a time as user scrolls down.
 */

import { createApiClient } from './api.js';
import { createMediaCard, filterVideos, isShort, sortVideos } from './feed.js';
import {
  loadFeedCache, saveFeedCache,
  loadStarredChannels, saveStarredChannels, clearStarredChannels,
  loadShowShorts, saveShowShorts,
} from './cache.js';
import { buildCommentTree, createCommentThread, createCommentHtml } from './comments.js';
import { initAuth, renderSignInButton, getCurrentUser, isSignedIn, getToken, isTokenExpired, refreshToken, onAuthChange, signOut } from './auth.js';
import { sanitizeHtml } from './utils.js';

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwyt7c8SWw9y0TnKq4RhcV7yLjS1JkXnNThYInpj-EnNYbA3ecgwVSX4gBIACNKHCqu0A/exec',
  GOOGLE_CLIENT_ID: '58088759188-uhqgajeoe8h218h3o6pql634pkcjsu70.apps.googleusercontent.com',
  PAGE_SIZE: 10,
  COMMENT_BATCH_SIZE: 10,     // ids per commentsBatch request (backend caps at 20)
  SEARCH_INDEX_LIMIT: 2000,   // first fetch; if the catalog outgrows it, a
                              // follow-up fetch grabs the rest (see ensureSearchIndex)
  PREFETCH_PAGES_AHEAD: 3,    // pages fetched ahead of the scroll position so
                              // infinite scroll renders instantly from memory
};

// ============================================================
// STATE
// ============================================================

const state = {
  videos: [],          // All loaded videos so far
  currentPage: 0,      // Last page that was loaded
  totalVideos: 0,      // Total available from API
  loading: false,      // Prevents concurrent fetches
  hasMore: true,       // Whether more pages exist
  expandedComments: new Set(),
  commentsCache: {},   // videoId -> { comments, tree } — prefetched comment data
  initialLoadComplete: false,
  filter: { query: '', category: '' },
  searchIndex: null,        // all videos, fetched lazily on first search/filter
  searchIndexPromise: null, // in-flight index fetch (dedupes concurrent requests)
  filterRenderToken: 0,     // invalidates stale filter renders after async index load
  view: 'latest',           // 'latest' (chronological), 'top' (weekly upvotes), or 'starred'
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
  showShorts: true,         // whether Shorts are visible (persisted)
  renderToken: 0,           // invalidates deferred short inserts after a re-render
  fullscreenVideoId: null,      // video expanded to fullscreen, or null
  fullscreenReturnId: null,     // topmost visible card before fullscreen (scroll anchor)
  fullscreenReturnScrollY: 0,   // exact scroll offset before fullscreen
  fullscreenReturnAnchorTop: null, // the anchor card's viewport offset before fullscreen
};

const api = createApiClient(CONFIG.APPS_SCRIPT_URL);

// ============================================================
// SINGLE SHARED IFRAME OBSERVER
// Iframes only load their src when scrolled into view.
// ============================================================

const iframeObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const iframe = entry.target;
      if (iframe.dataset.src) {
        iframe.src = iframe.dataset.src;
        delete iframe.dataset.src;
      }
      iframeObserver.unobserve(iframe);
    }
  });
}, { rootMargin: '150px' });

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  let authRetries = 0;
  function tryInitAuth() {
    if (typeof google !== 'undefined' && google.accounts) {
      initAuth(CONFIG.GOOGLE_CLIENT_ID);
      setupAuthUI();
    } else if (authRetries++ < 50) {
      setTimeout(tryInitAuth, 200);
    }
  }
  tryInitAuth();

  setupInfiniteScroll();
  setupFeedControls();
  setupTabs();
  setupShortsToggle();
  setupFullscreenKeys();
  loadStarsFromStorage();

  const cached = await showCachedFeed();
  if (!cached) {
    loadNextPage();
  } else {
    // Stale-while-revalidate: show cache instantly, then fetch fresh data
    revalidateFeed();
  }
});

// ============================================================
// FEED — Dynamic initial load, then pagination
// ============================================================

async function loadNextPage() {
  if (state.loading || state.revalidating || !state.hasMore || isFilterActive() || state.view !== 'latest') return;
  state.loading = true;

  const skeleton = document.getElementById('feed-skeleton');
  const empty = document.getElementById('feed-empty');
  const sentinel = document.getElementById('load-more-container');

  if (state.currentPage === 0 && !state.initialLoadComplete) {
    skeleton.style.display = '';
    empty.style.display = 'none';
  }

  sentinel.style.display = '';

  try {
    if (!state.initialLoadComplete) {
      // Calculate how many items fill the screen (N + 1)
      const cardHeight = window.innerWidth <= 540 ? 320 : 190;
      const N = Math.ceil(window.innerHeight / cardHeight);
      const initialLimit = Math.min(N + 1, CONFIG.PAGE_SIZE);

      // 1. Fetch N+1 items to show something immediately
      const data = await api.fetchFeed(1, initialLimit);
      const newVideos = data.videos || [];
      state.totalVideos = data.total || 0;
      state.videos = state.videos.concat(newVideos);
      
      skeleton.style.display = 'none';
      await appendCards(newVideos);
      state.initialLoadComplete = true;

      // 2. Fetch the remainder of the first page (up to PAGE_SIZE)
      if (initialLimit < CONFIG.PAGE_SIZE && state.videos.length < state.totalVideos) {
        const fullPageData = await api.fetchFeed(1, CONFIG.PAGE_SIZE);
        const fullVideos = fullPageData.videos || [];
        const remainingVideos = fullVideos.slice(initialLimit);
        
        // Filter out videos already in state
        const uniqueRemaining = remainingVideos.filter(nv => !state.videos.some(sv => sv.video_id === nv.video_id));
        
        state.videos = state.videos.concat(uniqueRemaining);
        await appendCards(uniqueRemaining);
      }

      state.currentPage = 1;
      state.hasMore = state.videos.length < state.totalVideos;
      saveFeedCache(state.videos, state.totalVideos);

      // Prefetch comments for all loaded cards in the background
      prefetchComments(state.videos);

      // Start filling the read-ahead buffer so the first scroll is instant
      refillPrefetchBuffer();

      if (state.videos.length === 0) {
        empty.style.display = '';
      }

    } else {
      // Normal infinite scroll for page 2 onwards. The read-ahead buffer
      // usually has this page already — render it with zero network wait.
      const nextPage = state.currentPage + 1;
      let newVideos = takeBufferedPage(nextPage);

      if (!newVideos) {
        // Outscrolled the prefetch — fall back to fetching on demand.
        // pendingFetchPage stops a concurrent refill response for this same
        // page from poisoning the buffer head (currentPage only advances
        // after this await); the token check discards OUR response if the
        // pagination was reset (feed revalidation) while we waited.
        const epoch = state.prefetchToken;
        state.pendingFetchPage = nextPage;
        try {
          const data = await api.fetchFeed(nextPage, CONFIG.PAGE_SIZE);
          if (epoch !== state.prefetchToken) return;
          newVideos = data.videos || [];
          state.totalVideos = data.total || 0;
        } finally {
          state.pendingFetchPage = 0;
        }
      }

      state.currentPage = nextPage;

      // Filter out items already in state to handle pagination overlap (e.g., when new items were added since last fetch)
      const uniqueNewVideos = newVideos.filter(nv => !state.videos.some(sv => sv.video_id === nv.video_id));

      state.videos = state.videos.concat(uniqueNewVideos);
      // An empty page means we've walked past the real end of the catalog.
      // The server total can overcount what forward pagination can reach
      // (items prepended mid-session shift pages; the dedupe above drops
      // the duplicates), so an unreachable total must not keep hasMore
      // true — that would spin the retrigger loop on empty fetches forever.
      state.hasMore = newVideos.length > 0 && state.videos.length < state.totalVideos;

      await appendCards(uniqueNewVideos);

      // Prefetch comments for newly loaded cards
      prefetchComments(uniqueNewVideos);

      // Top the buffer back up to PREFETCH_PAGES_AHEAD
      refillPrefetchBuffer();
    }
  } catch (error) {
    console.error('Failed to load feed:', error);
    if (state.videos.length === 0) {
      showToast('Failed to load feed. Please try again.', 'error');
    }
  } finally {
    state.loading = false;
    skeleton.style.display = 'none';

    if (!state.hasMore || isFilterActive() || state.view !== 'latest') {
      sentinel.style.display = 'none';
    } else {
      sentinel.style.display = '';
      // If the sentinel is still within the root margin after loading, 
      // trigger the next load manually. The IntersectionObserver won't re-fire
      // if it never exited the threshold while state.loading was true.
      requestAnimationFrame(() => {
        const rect = sentinel.getBoundingClientRect();
        if (rect.top > 0 && rect.top <= window.innerHeight + 600) {
          loadNextPage();
        }
      });
    }
  }
}

// ============================================================
// READ-AHEAD BUFFER
// Keeps PREFETCH_PAGES_AHEAD pages fetched beyond the rendered feed so
// infinite scroll renders from memory. Entries are contiguous, starting
// at currentPage+1; a pagination reset (feed revalidation) invalidates
// both the buffer and any refill fetch still in flight.
// ============================================================

/** Total videos sitting in the buffer, for end-of-catalog math. */
function bufferedVideoCount() {
  return state.prefetchBuffer.reduce((n, entry) => n + entry.videos.length, 0);
}

/** Whether the server still has pages we haven't fetched (rendered or buffered). */
function hasUnfetchedPages() {
  return state.videos.length + bufferedVideoCount() < state.totalVideos;
}

/** The next page the refill loop should fetch: after the last buffered page.
 *  Counts a page being direct-fetched by loadNextPage as taken, so a refill
 *  response for it is discarded instead of poisoning the buffer head. */
function nextPageToFetch() {
  const last = state.prefetchBuffer[state.prefetchBuffer.length - 1];
  return (last ? last.page : Math.max(state.currentPage, state.pendingFetchPage)) + 1;
}

/** Drops the buffer and cancels any in-flight refill (pagination reset). */
function invalidatePrefetchBuffer() {
  state.prefetchBuffer = [];
  state.prefetchToken++;
}

/**
 * Takes the buffered videos for `page` if they're at the head of the
 * buffer. Anything else means the buffer no longer lines up with the
 * feed's pagination — discard it rather than render out-of-order pages.
 */
function takeBufferedPage(page) {
  if (state.prefetchBuffer.length === 0) return null;
  if (state.prefetchBuffer[0].page === page) {
    return state.prefetchBuffer.shift().videos;
  }
  invalidatePrefetchBuffer();
  return null;
}

/**
 * Fetches pages sequentially until the buffer holds PREFETCH_PAGES_AHEAD
 * pages (or the catalog is exhausted). One loop runs at a time; responses
 * that no longer line up with the pagination — because the user consumed
 * pages mid-flight or the feed revalidated — are discarded, and the loop
 * recomputes what to fetch next.
 */
async function refillPrefetchBuffer() {
  if (state.prefetching || !state.initialLoadComplete) return;
  state.prefetching = true;
  const token = state.prefetchToken;

  try {
    while (
      token === state.prefetchToken &&
      state.prefetchBuffer.length < CONFIG.PREFETCH_PAGES_AHEAD &&
      hasUnfetchedPages()
    ) {
      const page = nextPageToFetch();
      const data = await api.fetchFeed(page, CONFIG.PAGE_SIZE);
      if (token !== state.prefetchToken) return;

      if (data.total) state.totalVideos = data.total;
      const videos = data.videos || [];
      if (videos.length === 0) {
        // Past the real end — the server total overcounts what forward
        // pagination can reach (items prepended mid-session shift pages).
        // Clamp the total to what's actually rendered + buffered so
        // scrolling drains the remaining buffer, then stops cleanly.
        state.totalVideos = state.videos.length + bufferedVideoCount();
        state.hasMore = state.videos.length < state.totalVideos;
        if (!state.hasMore && state.view === 'latest' && !isFilterActive()) {
          const sentinel = document.getElementById('load-more-container');
          if (sentinel) sentinel.style.display = 'none';
        }
        break;
      }

      // A scroll may have consumed pages while this fetch was in flight;
      // only append if the response still extends the buffer contiguously.
      if (page === nextPageToFetch()) {
        state.prefetchBuffer.push({ page, videos });
      }
    }
  } catch (e) {
    /* network hiccup — scrolling falls back to on-demand fetching */
  } finally {
    state.prefetching = false;
    // A pagination reset mid-loop invalidated this run — service the new
    // token now instead of waiting for the next scroll.
    if (token !== state.prefetchToken) refillPrefetchBuffer();
  }
}

/**
 * Builds a card element from a media item and wires up its comment
 * toggle. Caller inserts it into the DOM, then calls observeLazyIframe —
 * observing must happen after insertion so the first intersection
 * snapshot already sees an attached, visible element.
 */
function buildCard(video) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = createMediaCard(video);
  const card = wrapper.firstElementChild;

  const toggle = card.querySelector('.media-card__comments-toggle');
  if (toggle) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleComments(toggle.dataset.videoId);
    });
  }

  const voteBtn = card.querySelector('.media-card__vote');
  if (voteBtn) {
    if (state.myVotes.has(voteBtn.dataset.videoId)) {
      voteBtn.classList.add('media-card__vote--active');
      voteBtn.setAttribute('aria-pressed', 'true');
    }
    voteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleVote(voteBtn.dataset.videoId);
    });
  }

  const starBtn = card.querySelector('.media-card__star');
  if (starBtn) {
    if (state.myStars.has(video.channel_name)) {
      markStarButton(starBtn, true);
    }
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStar(video.channel_name);
    });
  }

  const expandBtn = card.querySelector('.media-card__expand');
  if (expandBtn) {
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen(card);
    });
  }

  return card;
}

function observeLazyIframe(card) {
  const iframe = card.querySelector('iframe[data-src]');
  if (iframe) {
    iframeObserver.observe(iframe);
  }
}

/**
 * Append video cards one at a time with staggered timing.
 * Long-form videos and articles render first; Shorts are held back and
 * slide in afterward at their chronological position, so the main
 * content is on screen before the short-form filler arrives.
 * Returns a Promise that resolves when the long-form cards are in
 * (Shorts keep animating in after resolution).
 */
function appendCards(videos) {
  return new Promise((resolve) => {
    // Paginated cards belong only to the unfiltered Latest feed — a filter
    // render or another view owns the container otherwise.
    if (videos.length === 0 || isFilterActive() || state.view !== 'latest') {
      resolve();
      return;
    }

    const feedContainer = document.getElementById('feed-container');

    // Captured now so staggered inserts abort if the container is
    // re-rendered (tab switch, search) while this batch is in flight.
    const token = state.renderToken;
    const staleRender = () =>
      token !== state.renderToken || state.view !== 'latest' || isFilterActive();

    // Deduplicate: skip items already rendered in the DOM
    const deduped = videos.filter(video => {
      const id = video.video_id;
      return id && !feedContainer.querySelector(`[data-video-id="${id}"]`);
    });

    if (deduped.length === 0) {
      resolve();
      return;
    }

    const mains = deduped.filter(v => !isShort(v));
    const shorts = deduped.filter(isShort);

    if (mains.length === 0) {
      resolve();
      insertShortsDeferred(feedContainer, shorts, token);
      return;
    }

    mains.forEach((video, i) => {
      setTimeout(() => {
        const isLast = i === mains.length - 1;

        // Double-check dedup (guards against race from staggered timeouts)
        if (!staleRender() && !feedContainer.querySelector(`[data-video-id="${video.video_id}"]`)) {
          const card = buildCard(video);
          card.classList.add('media-card--entering');
          feedContainer.appendChild(card);
          observeLazyIframe(card);

          requestAnimationFrame(() => {
            card.classList.remove('media-card--entering');
          });
        }

        // Resolve when the last long-form card is in, then bring in the Shorts
        if (isLast) {
          setTimeout(() => {
            resolve();
            insertShortsDeferred(feedContainer, shorts, token);
          }, 50);
        }
      }, i * 60);
    });
  });
}

/**
 * Inserts a card at its reverse-chronological position among the
 * container's existing cards (the feed is newest-first).
 */
function insertCardChronologically(container, card) {
  const t = new Date(card.dataset.publishedAt || 0).getTime();
  const existing = container.querySelectorAll('.media-card');
  for (const other of existing) {
    const ot = new Date(other.dataset.publishedAt || 0).getTime();
    if (ot < t) {
      container.insertBefore(card, other);
      return;
    }
  }
  container.appendChild(card);
}

/**
 * Slides Shorts into the feed after the long-form cards have rendered.
 * Each short lands at its chronological spot with an entrance animation.
 * Inserts are abandoned if the container was re-rendered in the meantime
 * (view switch, search) — state.renderToken tracks container ownership.
 *
 * This deferred reveal is for NETWORK ARRIVALS on the Latest feed only
 * (appendCards). Re-renders of already-loaded data must use renderList —
 * replaying the animation on every tab switch reads as flicker.
 */
function insertShortsDeferred(container, shorts, token) {
  if (!shorts || shorts.length === 0) return;

  shorts.forEach((video, i) => {
    setTimeout(() => {
      if (token !== state.renderToken) return;
      if (!video.video_id || container.querySelector(`[data-video-id="${video.video_id}"]`)) return;

      const card = buildCard(video);
      card.classList.add('media-card--short-entering');
      insertCardChronologically(container, card);
      observeLazyIframe(card);

      // Double rAF so the browser paints the entering state before
      // the transition to the resting state starts.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          card.classList.remove('media-card--short-entering');
        });
      });
    }, 150 + i * 80);
  });
}

/**
 * Renders a full list synchronously, shorts included, in the given order
 * (chronological for Latest/Starred, vote-ranked for Top This Week).
 * Used by tab switches and filter re-renders: the data is already loaded,
 * so everything appears at once — no deferred reveal, no flicker. The
 * animated shorts reveal is reserved for the Latest feed's network loads
 * (appendCards → insertShortsDeferred).
 */
function renderList(container, videos) {
  for (const video of videos) {
    const card = buildCard(video);
    container.appendChild(card);
    observeLazyIframe(card);
  }
}

/**
 * Show cached feed instantly on page load (stale-while-revalidate).
 * Called before loadNextPage so the user sees content immediately.
 */
async function showCachedFeed() {
  // Validation and corruption handling live in cache.js — an invalid
  // payload comes back as null and has already been cleared.
  const cached = loadFeedCache();
  if (!cached) return false;

  state.videos = cached.videos;
  state.totalVideos = cached.total;
  // The cache can hold several pages (it's rewritten as the user scrolls
  // and votes) — derive the page cursor from its size so the read-ahead
  // buffer prefetches genuinely new pages, not duplicates of what's shown.
  state.currentPage = Math.max(1, Math.ceil(cached.videos.length / CONFIG.PAGE_SIZE));
  state.hasMore = state.videos.length < state.totalVideos;
  state.initialLoadComplete = true;

  // Make sentinel visible so the IntersectionObserver can fire for page 2
  if (state.hasMore) {
    const sentinel = document.getElementById('load-more-container');
    if (sentinel) sentinel.style.display = '';
  }

  await appendCards(cached.videos);
  return true;
}

/**
 * Full stale-while-revalidate with smooth DOM diffing.
 * 
 * 1. Fetch fresh page 1 from API
 * 2. Fade out cards no longer in the feed
 * 3. Slide in new cards at the correct position
 * 4. Update comment counts on existing cards (no re-render)
 * 5. Reorder if necessary
 */
async function revalidateFeed() {
  try {
    const data = await api.fetchFeed(1, CONFIG.PAGE_SIZE);
    const freshVideos = data.videos || [];
    if (freshVideos.length === 0) return;

    // Quick check: is anything different?
    const cachedIds = state.videos.map(v => v.video_id).join(',');
    const freshIds = freshVideos.map(v => v.video_id).join(',');
    const countsChanged = freshVideos.some(fv => {
      const cached = state.videos.find(v => v.video_id === fv.video_id);
      return cached && cached.comment_count !== fv.comment_count;
    });

    if (cachedIds === freshIds && !countsChanged) {
      // Content identical — the cached pagination is still valid, so the
      // read-ahead buffer can start filling from it as-is.
      prefetchComments(state.videos);
      refillPrefetchBuffer();
      return;
    }

    // A search/filter view owns the container — update state and cache
    // only, the normal feed re-renders when the filter clears.
    if (isFilterActive()) {
      state.videos = freshVideos;
      state.totalVideos = data.total || freshVideos.length;
      state.currentPage = 1;
      state.hasMore = state.videos.length < state.totalVideos;
      saveFeedCache(freshVideos, state.totalVideos);
      // Page 1 was replaced — pages buffered against the old pagination
      // no longer line up.
      invalidatePrefetchBuffer();
      refillPrefetchBuffer();
      return;
    }

    const container = document.getElementById('feed-container');
    if (!container) return;

    // The diff owns the container from here: pause pagination (a buffered
    // page consumed mid-diff would be clobbered by the state replacement
    // below) and invalidate the buffer eagerly — the old pagination died
    // the moment we decided fresh page 1 differs.
    state.revalidating = true;
    invalidatePrefetchBuffer();

    try {

    // Cancel any deferred inserts still pending from the cached render —
    // they'd re-add cards this diff is about to reconcile or drop.
    state.renderToken++;

    const freshIdSet = new Set(freshVideos.map(v => v.video_id));
    // From the DOM, not state: cards whose deferred insert was just
    // cancelled must count as missing so the diff below re-inserts them.
    const existingIdSet = new Set(
      [...container.querySelectorAll('.media-card')].map(c => c.dataset.videoId)
    );

    // --- 1. Animate out cards no longer in the fresh feed ---
    const removedCards = container.querySelectorAll('.media-card');
    const removePromises = [];

    removedCards.forEach(card => {
      const id = card.dataset.videoId;
      // Never remove the card the user is watching in fullscreen
      if (id === state.fullscreenVideoId) return;
      if (id && !freshIdSet.has(id)) {
        card.classList.add('media-card--leaving');
        removePromises.push(new Promise(resolve => {
          card.addEventListener('transitionend', () => {
            card.remove();
            resolve();
          }, { once: true });
          // Safety timeout in case transitionend doesn't fire
          setTimeout(() => { card.remove(); resolve(); }, 400);
        }));
      }
    });

    // Wait for fade-out animations to complete
    if (removePromises.length > 0) {
      await Promise.all(removePromises);
    }

    // --- 2. Update comment counts on surviving cards ---
    for (const video of freshVideos) {
      if (existingIdSet.has(video.video_id)) {
        const toggle = document.querySelector(`.media-card__comments-toggle[data-video-id="${video.video_id}"]`);
        if (toggle) {
          const freshCount = video.comment_count || 0;
          toggle.textContent = `💬 ${freshCount} comments`;
        }
      }
    }

    // --- 3. Insert new cards at the correct position ---
    const newVideos = freshVideos.filter(v => !existingIdSet.has(v.video_id));

    for (const video of newVideos) {
      // Find where this card should go based on the fresh order
      const freshIndex = freshVideos.indexOf(video);
      const existingCards = container.querySelectorAll('.media-card');

      const card = buildCard(video);
      card.classList.add('media-card--entering');

      // Insert at the correct position
      if (freshIndex >= existingCards.length) {
        container.appendChild(card);
      } else {
        container.insertBefore(card, existingCards[freshIndex]);
      }
      observeLazyIframe(card);

      // Trigger enter animation
      requestAnimationFrame(() => {
        card.classList.remove('media-card--entering');
      });
    }

    // --- 4. Sort ALL cards chronologically (newest first) ---
    const allCards = [...container.querySelectorAll('.media-card')];
    allCards.sort((a, b) => {
      const dateA = new Date(a.dataset.publishedAt || 0);
      const dateB = new Date(b.dataset.publishedAt || 0);
      return dateB - dateA; // newest first
    });
    // Re-append in sorted order (DOM moves, no re-render). Moving an
    // iframe reloads it, so the fullscreen card stays put — it's
    // position:fixed, its container order is invisible while expanded.
    for (const card of allCards) {
      if (card.dataset.videoId === state.fullscreenVideoId) continue;
      container.appendChild(card);
    }

    // --- 5. Update state and cache ---
    state.videos = freshVideos;
    state.totalVideos = data.total || freshVideos.length;
    state.currentPage = 1;
    state.hasMore = state.videos.length < state.totalVideos;
    state.commentsCache = {};
    // Invalidate again: a refill restarted during the diff would have
    // buffered pages against the pre-reset currentPage.
    invalidatePrefetchBuffer();

    const sentinel = document.getElementById('load-more-container');
    if (sentinel) sentinel.style.display = state.hasMore ? '' : 'none';

    saveFeedCache(freshVideos, state.totalVideos);

    // Prefetch comments for all cards
    prefetchComments(freshVideos);

    } finally {
      state.revalidating = false;
    }

    refillPrefetchBuffer();
  } catch (e) {
    // Silent fail — stale cache is still visible
    prefetchComments(state.videos);
    // The cached pagination is still what's on screen — buffer from it
    refillPrefetchBuffer();
  }
}

/**
 * Update comment_count in both state.videos and localStorage cache
 * after a successful comment post. Prevents stale-count flash on next load.
 */
function updateCachedCommentCount(videoId, newCount) {
  const video = state.videos.find(v => v.video_id === videoId);
  if (video) {
    video.comment_count = newCount;
    saveFeedCache(state.videos, state.totalVideos);
  }
}

// ============================================================
// INFINITE SCROLL
// ============================================================

function setupInfiniteScroll() {
  const sentinel = document.getElementById('load-more-container');

  const scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !state.loading && state.hasMore) {
        loadNextPage();
      }
    });
  }, { rootMargin: '600px' });

  scrollObserver.observe(sentinel);
}

// ============================================================
// SEARCH & CATEGORY FILTER
// ============================================================

function isFilterActive() {
  return !!(state.filter.query.trim() || state.filter.category);
}

/**
 * Loads the full catalog once (titles, channels, categories) so search
 * and filters work across everything, not just the pages scrolled so far.
 * If the catalog has outgrown SEARCH_INDEX_LIMIT, a second fetch sized
 * from the server's total grabs the whole thing — older videos must not
 * silently drop out of search.
 */
function ensureSearchIndex() {
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

function setupFeedControls() {
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

/** The current filter plus the channel→host map used for query matching. */
function activeFilter() {
  return { ...state.filter, hostsByChannel: state.hostsByChannel };
}

/**
 * Renders whichever view is active, honoring the current search/filter.
 * Single entry point for the search box, chips, and tab switches.
 */
function update() {
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

function setupTabs() {
  document.querySelectorAll('.feed-tab').forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
}

/**
 * Switches between the chronological "Latest" feed and the "Top This Week"
 * upvote ranking. The top list is fetched once, then cached for the session.
 */
async function switchView(view) {
  if (view === state.view) return;
  state.view = view;

  document.querySelectorAll('.feed-tab').forEach(t => {
    const active = t.dataset.view === view;
    t.classList.toggle('feed-tab--active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  window.scrollTo({ top: 0 });

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
      state.topVideos = data.videos || [];
      // Don't freeze an empty result for the whole session. An empty list can
      // come from a transient hiccup or a refresh still in flight; leaving
      // topLoaded false lets reopening the tab refetch instead of sticking.
      state.topLoaded = state.topVideos.length > 0;
    } catch (e) {
      console.error('Failed to load top videos:', e);
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
    skeleton.style.display = 'none';
  }

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

// ============================================================
// VOTES (upvotes)
// ============================================================

/**
 * Returns a valid (non-expired) Google ID token, refreshing if needed.
 * Throws if the session can't be renewed.
 */
async function ensureToken() {
  let token = getToken();
  if (isTokenExpired()) {
    const fresh = await refreshToken();
    if (fresh) return fresh;
    signOut();
    throw new Error('Session expired. Please sign in again.');
  }
  return token;
}

/** Updates every vote button for a video (both views may have one rendered). */
function setVoteButtons(videoId, voted, count) {
  document.querySelectorAll(`.media-card__vote[data-video-id="${videoId}"]`).forEach(btn => {
    btn.classList.toggle('media-card__vote--active', voted);
    btn.setAttribute('aria-pressed', voted ? 'true' : 'false');
    if (count != null) {
      const countEl = btn.querySelector('.media-card__vote-count');
      if (countEl) countEl.textContent = String(count);
    }
  });
}

/** Keeps vote counts in cached state + localStorage in sync after a vote. */
function updateCachedVoteCount(videoId, count) {
  const v = state.videos.find(x => x.video_id === videoId);
  if (v) {
    v.vote_count = count;
    saveFeedCache(state.videos, state.totalVideos);
  }
  if (state.topVideos) {
    const tv = state.topVideos.find(x => x.video_id === videoId);
    if (tv) tv.vote_count = count;
  }
}

/**
 * Toggles the current user's upvote on a video, optimistically.
 * The server is the source of truth for the final count.
 */
// Bumped on every local vote mutation so a slow fetchMyVotes snapshot
// can't clobber a vote the user just cast.
let voteEpoch = 0;

async function toggleVote(videoId) {
  if (!isSignedIn()) {
    showToast('Please sign in to vote', 'info');
    return;
  }

  const wasVoted = state.myVotes.has(videoId);
  const sample = document.querySelector(`.media-card__vote[data-video-id="${videoId}"] .media-card__vote-count`);
  const prevCount = sample ? (parseInt(sample.textContent, 10) || 0) : 0;
  const optimisticCount = Math.max(0, prevCount + (wasVoted ? -1 : 1));

  // Optimistic flip
  voteEpoch++;
  if (wasVoted) state.myVotes.delete(videoId); else state.myVotes.add(videoId);
  setVoteButtons(videoId, !wasVoted, optimisticCount);

  try {
    const token = await ensureToken();
    const res = await api.vote(videoId, token);

    // Reconcile with server truth
    voteEpoch++;
    if (res.voted) state.myVotes.add(videoId); else state.myVotes.delete(videoId);
    setVoteButtons(videoId, res.voted, res.vote_count);
    updateCachedVoteCount(videoId, res.vote_count);
  } catch (error) {
    console.error('Failed to vote:', error);
    // Rollback — unless the failure signed the user out, in which case
    // clearVoteMarkings already put the UI in the right state.
    if (isSignedIn()) {
      voteEpoch++;
      if (wasVoted) state.myVotes.add(videoId); else state.myVotes.delete(videoId);
      setVoteButtons(videoId, wasVoted, prevCount);
    }
    showToast(error.message || 'Failed to vote. Please try again.', 'error');
  }
}

/**
 * Loads the signed-in user's upvotes and marks their buttons.
 * Called on sign-in so the UI reflects past votes.
 */
async function loadMyVotes() {
  if (!isSignedIn()) return;
  try {
    let token = getToken();
    if (isTokenExpired()) token = await refreshToken();
    if (!token) return; // can't reconcile right now

    const epoch = voteEpoch;
    const data = await api.fetchMyVotes(token);
    // A vote cast while this was in flight beats the older snapshot
    if (epoch !== voteEpoch) return;

    state.myVotes = new Set(data.video_ids || []);
    document.querySelectorAll('.media-card__vote').forEach(btn => {
      const voted = state.myVotes.has(btn.dataset.videoId);
      btn.classList.toggle('media-card__vote--active', voted);
      btn.setAttribute('aria-pressed', voted ? 'true' : 'false');
    });
  } catch (e) {
    /* silent — voting still works, buttons just won't show prior state */
  }
}

/** Clears all vote markings (on sign-out). */
function clearVoteMarkings() {
  state.myVotes.clear();
  document.querySelectorAll('.media-card__vote--active').forEach(btn => {
    btn.classList.remove('media-card__vote--active');
    btn.setAttribute('aria-pressed', 'false');
  });
}

// ============================================================
// SHORTS TOGGLE
// Shorts cards are always in the DOM (marked media-card--short);
// the toggle hides them with a single container class — pure CSS,
// nothing re-renders.
// ============================================================

function setupShortsToggle() {
  const input = document.getElementById('shorts-toggle-input');
  if (!input) return;

  state.showShorts = loadShowShorts();
  input.checked = state.showShorts;
  applyShortsVisibility();

  input.addEventListener('change', () => {
    state.showShorts = input.checked;
    saveShowShorts(state.showShorts);
    applyShortsVisibility();
  });
}

function applyShortsVisibility() {
  const container = document.getElementById('feed-container');
  if (container) container.classList.toggle('feed--hide-shorts', !state.showShorts);
}

// ============================================================
// FULLSCREEN MODE
// The expand button turns a card into a fixed overlay covering the
// viewport — pure CSS, no navigation, no loading. On exit, the feed
// scrolls back to whichever card was at the top before expanding.
// ============================================================

/** Finds the video_id of the topmost card currently visible under the header. */
function topmostVisibleCardId() {
  const headerHeight = document.getElementById('header')?.offsetHeight || 0;
  for (const card of document.querySelectorAll('#feed-container .media-card')) {
    if (card.offsetParent === null) continue; // hidden (e.g. Shorts toggled off)
    // Require a meaningful part of the card below the header — a sub-pixel
    // sliver of the previous card must not steal the scroll anchor.
    if (card.getBoundingClientRect().bottom > headerHeight + 40) {
      return card.dataset.videoId || null;
    }
  }
  return null;
}

function toggleFullscreen(card) {
  if (state.fullscreenVideoId) {
    exitFullscreen();
  } else {
    enterFullscreen(card);
  }
}

function enterFullscreen(card) {
  const videoId = card.dataset.videoId;
  if (!videoId || state.fullscreenVideoId) return;

  state.fullscreenReturnId = topmostVisibleCardId();
  state.fullscreenReturnScrollY = window.scrollY;
  const anchor = state.fullscreenReturnId
    ? document.querySelector(`#feed-container .media-card[data-video-id="${state.fullscreenReturnId}"]`)
    : null;
  state.fullscreenReturnAnchorTop = anchor ? anchor.getBoundingClientRect().top : null;
  state.fullscreenVideoId = videoId;

  document.body.classList.add('fullscreen-mode');
  card.classList.add('media-card--fullscreen');

  // The overlay is on screen now — load its iframe immediately instead of
  // waiting for the IntersectionObserver (which no longer sees it move).
  const iframe = card.querySelector('iframe[data-src]');
  if (iframe) {
    iframe.src = iframe.dataset.src;
    delete iframe.dataset.src;
    iframeObserver.unobserve(iframe);
  }

  // Fullscreen is the watch-and-discuss view — open the comments.
  const body = card.querySelector(`.media-card__comments-body[data-video-id="${videoId}"]`);
  if (body && body.style.display === 'none') {
    toggleComments(videoId);
  }

  const expandBtn = card.querySelector('.media-card__expand');
  if (expandBtn) {
    expandBtn.title = 'Exit fullscreen';
    expandBtn.setAttribute('aria-label', 'Exit fullscreen');
    const icon = expandBtn.querySelector('.media-card__expand-icon');
    if (icon) icon.textContent = '✕';
  }
}

function exitFullscreen() {
  const card = document.querySelector('.media-card--fullscreen');
  const returnId = state.fullscreenReturnId;
  const returnScrollY = state.fullscreenReturnScrollY;
  const returnAnchorTop = state.fullscreenReturnAnchorTop;

  state.fullscreenVideoId = null;
  state.fullscreenReturnId = null;
  state.fullscreenReturnAnchorTop = null;

  document.body.classList.remove('fullscreen-mode');
  if (card) {
    card.classList.remove('media-card--fullscreen');
    const expandBtn = card.querySelector('.media-card__expand');
    if (expandBtn) {
      expandBtn.title = 'Expand';
      expandBtn.setAttribute('aria-label', 'Expand');
      const icon = expandBtn.querySelector('.media-card__expand-icon');
      if (icon) icon.textContent = '⛶';
    }
  }

  // Land back exactly where the user was. The exact offset is right when
  // nothing moved; if the feed shifted while fullscreen (revalidation,
  // inserted cards), nudge so the top card sits where it was before.
  window.scrollTo({ top: returnScrollY, behavior: 'auto' });
  if (returnId) {
    const anchor = document.querySelector(`#feed-container .media-card[data-video-id="${returnId}"]`);
    if (anchor && returnAnchorTop != null) {
      const delta = anchor.getBoundingClientRect().top - returnAnchorTop;
      if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: 'auto' });
    } else if (anchor) {
      anchor.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }
}

function setupFullscreenKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.fullscreenVideoId) {
      exitFullscreen();
    }
  });
}

// ============================================================
// STARS — starred creators, one per Google account per channel
// ============================================================

/** Applies the visual starred/unstarred state to one star button. */
function markStarButton(btn, starred) {
  btn.classList.toggle('media-card__star--active', starred);
  btn.setAttribute('aria-pressed', starred ? 'true' : 'false');
  btn.textContent = starred ? '★' : '☆';
}

/** Updates every star button for a channel (cards may repeat across views). */
function setStarButtons(channel, starred) {
  document.querySelectorAll('.media-card__star').forEach(btn => {
    if (btn.dataset.channel === channel) markStarButton(btn, starred);
  });
}

/** Persists starred channels so buttons paint instantly on reload. */
function saveStarsToStorage() {
  saveStarredChannels(state.myStars);
}

function loadStarsFromStorage() {
  state.myStars = loadStarredChannels();
}

// Bumped on every local star mutation so a slow fetchMyStars snapshot
// can't clobber a star the user just toggled.
let starEpoch = 0;

/**
 * Toggles the current user's star on a creator, optimistically.
 * The server is the source of truth for the final state.
 */
async function toggleStar(channel) {
  if (!channel) return;
  if (!isSignedIn()) {
    showToast('Please sign in to star creators', 'info');
    return;
  }

  const wasStarred = state.myStars.has(channel);

  // Optimistic flip
  starEpoch++;
  if (wasStarred) state.myStars.delete(channel); else state.myStars.add(channel);
  setStarButtons(channel, !wasStarred);

  try {
    const token = await ensureToken();
    const res = await api.star(channel, token);

    // Reconcile with server truth
    starEpoch++;
    if (res.starred) state.myStars.add(channel); else state.myStars.delete(channel);
    setStarButtons(channel, !!res.starred);
    saveStarsToStorage();
    if (state.view === 'starred') update();
  } catch (error) {
    console.error('Failed to star:', error);
    // Rollback — unless the failure signed the user out, in which case
    // clearStarMarkings already put the UI in the right state.
    if (isSignedIn()) {
      starEpoch++;
      if (wasStarred) state.myStars.add(channel); else state.myStars.delete(channel);
      setStarButtons(channel, wasStarred);
    }
    // A backend that predates stars answers "Unknown action" — say so plainly
    const msg = /^Unknown action/i.test(error.message || '')
      ? "Starring isn't available yet — please try again later."
      : (error.message || 'Failed to star. Please try again.');
    showToast(msg, 'error');
  }
}

/**
 * Loads the signed-in user's starred creators and marks their buttons.
 * Called on sign-in so the UI reflects past stars.
 */
async function loadMyStars() {
  if (!isSignedIn()) return;
  try {
    let token = getToken();
    if (isTokenExpired()) token = await refreshToken();
    if (!token) return; // can't reconcile right now; the cache stays best-effort

    const epoch = starEpoch;
    const data = await api.fetchMyStars(token);
    // A star toggled while this was in flight beats the older snapshot
    if (epoch !== starEpoch) return;

    state.myStars = new Set(data.channels || []);
    saveStarsToStorage();
    document.querySelectorAll('.media-card__star').forEach(btn => {
      markStarButton(btn, state.myStars.has(btn.dataset.channel));
    });
    if (state.view === 'starred') update();
  } catch (e) {
    /* silent — starring still works, buttons just won't show prior state */
  }
}

/** Clears all star markings (on sign-out). */
function clearStarMarkings() {
  state.myStars.clear();
  clearStarredChannels();
  document.querySelectorAll('.media-card__star--active').forEach(btn => {
    markStarButton(btn, false);
  });
}

// ============================================================
// INLINE COMMENTS
// ============================================================

function toggleComments(videoId) {
  const body = document.querySelector(`.media-card__comments-body[data-video-id="${videoId}"]`);
  if (!body) return;

  const isExpanded = body.style.display !== 'none';
  if (isExpanded) {
    body.style.display = 'none';
    state.expandedComments.delete(videoId);
  } else {
    body.style.display = '';
    state.expandedComments.add(videoId);
    loadInlineComments(videoId);
    updateInlineCommentFormUI(videoId);
    setupInlineCommentForm(videoId);
  }
}

async function loadInlineComments(videoId) {
  const listEl = document.querySelector(`.media-card__comments-list[data-video-id="${videoId}"]`);
  if (!listEl) return;

  // 1. Instantly render cached data if available (Stale-while-revalidate pattern)
  const cached = state.commentsCache[videoId];
  if (cached) {
    renderComments(videoId, listEl, cached.comments, cached.tree);
  } else {
    listEl.innerHTML = '<div class="comments-loading-inline"><div class="spinner"></div></div>';
  }

  // 2. Fetch fresh comments in the background
  try {
    const data = await api.fetchComments(videoId);
    const comments = data.comments || [];
    const tree = buildCommentTree(comments);
    
    // Check if the fresh data is actually different from our cache
    // A simple length check or full serialization works. For robustness, compare length or specific IDs.
    const hasChanged = !cached || cached.comments.length !== comments.length || JSON.stringify(cached.tree) !== JSON.stringify(tree);

    // Update cache
    state.commentsCache[videoId] = { comments, tree };

    if (hasChanged) {
      if (cached) {
        // If it was cached, do a smooth CSS fade transition
        listEl.classList.add('is-updating');
        setTimeout(() => {
          renderComments(videoId, listEl, comments, tree);
          requestAnimationFrame(() => listEl.classList.remove('is-updating'));
        }, 300); // matches CSS transition duration
      } else {
        // First load, just render instantly
        renderComments(videoId, listEl, comments, tree);
      }
    }
  } catch (error) {
    console.error('Failed to load comments:', error);
    if (!cached) {
      listEl.innerHTML = '<p class="comments-empty">Failed to load comments.</p>';
    }
  }
}

/**
 * Renders comments into the DOM for a given video.
 */
function renderComments(videoId, listEl, comments, tree) {
  const toggleBtn = document.querySelector(`.media-card__comments-toggle[data-video-id="${videoId}"]`);
  if (toggleBtn) toggleBtn.textContent = `💬 ${comments.length} comments`;

  if (tree.length === 0) {
    listEl.innerHTML = '<p class="comments-empty">No comments yet. Be the first!</p>';
  } else {
    listEl.innerHTML = tree.map(c => createCommentThread(c)).join('');
    attachReplyHandlers(videoId);
  }
}

/**
 * Prefetches comments in the background so expanding a card is instant.
 *
 * Only videos with at least one comment are fetched — the feed payload
 * already carries comment_count, and zero-count videos load on expand.
 * IDs are grouped into commentsBatch requests so a page of cards costs
 * one Apps Script execution instead of one per video (the web app caps
 * simultaneous executions, and per-video prefetch was the main load).
 */
function prefetchComments(videos) {
  // Instantly cache empty state for videos with no comments to avoid network requests
  videos.forEach(v => {
    if (v.video_id && (v.comment_count || 0) === 0 && !state.commentsCache[v.video_id]) {
      state.commentsCache[v.video_id] = { comments: [], tree: [] };
    }
  });

  const queue = videos
    .filter(v => v.video_id && !state.commentsCache[v.video_id] && (v.comment_count || 0) > 0)
    .map(v => v.video_id);

  if (queue.length === 0) return;

  const chunks = [];
  for (let i = 0; i < queue.length; i += CONFIG.COMMENT_BATCH_SIZE) {
    chunks.push(queue.slice(i, i + CONFIG.COMMENT_BATCH_SIZE));
  }

  let index = 0;

  function fetchNextChunk() {
    if (index >= chunks.length) return;

    // Skip ids cached in the meantime (e.g. user expanded manually)
    const ids = chunks[index++].filter(id => !state.commentsCache[id]);
    if (ids.length === 0) {
      fetchNextChunk();
      return;
    }

    api.fetchCommentsBatch(ids)
      .then(data => {
        // Backend without commentsBatch support — comments load on expand
        if (!data.byVideo) return;

        for (const id of ids) {
          const comments = data.byVideo[id] || [];
          const tree = buildCommentTree(comments);
          state.commentsCache[id] = { comments, tree };

          // If the user already expanded this card while we were fetching, render now
          if (state.expandedComments.has(id)) {
            const listEl = document.querySelector(`.media-card__comments-list[data-video-id="${id}"]`);
            if (listEl) renderComments(id, listEl, comments, tree);
          }

          // Update the comment count badge from real data
          const toggleBtn = document.querySelector(`.media-card__comments-toggle[data-video-id="${id}"]`);
          if (toggleBtn) toggleBtn.textContent = `💬 ${comments.length} comments`;
        }

        // Stagger next batch to stay under rate limits
        setTimeout(fetchNextChunk, 300);
      })
      .catch(() => { /* silent — stop prefetching, comments still load on expand */ });
  }

  fetchNextChunk();
}

function updateInlineCommentFormUI(videoId) {
  const authPrompt = document.querySelector(`.media-card__auth-prompt[data-video-id="${videoId}"]`);
  const form = document.querySelector(`.media-card__comment-form[data-video-id="${videoId}"]`);
  if (!authPrompt || !form) return;

  if (getCurrentUser()) {
    authPrompt.style.display = 'none';
    form.style.display = '';
  } else {
    authPrompt.style.display = '';
    form.style.display = 'none';
    // Render a real sign-in button into the prompt (once) so signed-out
    // users can sign in from anywhere — including the fullscreen overlay,
    // which covers the header's sign-in button.
    if (!authPrompt.dataset.signinRendered) {
      authPrompt.dataset.signinRendered = 'true';
      const host = document.createElement('div');
      host.className = 'media-card__auth-prompt-btn';
      authPrompt.appendChild(host);
      renderSignInButton(host);
    }
  }
}

function setupInlineCommentForm(videoId) {
  const form = document.querySelector(`.media-card__comment-form[data-video-id="${videoId}"]`);
  const textarea = document.querySelector(`.media-card__textarea[data-video-id="${videoId}"]`);
  if (!form || !textarea || form.dataset.bound) return;
  form.dataset.bound = 'true';

  const charcount = form.querySelector('.media-card__charcount');
  textarea.addEventListener('input', () => {
    if (charcount) charcount.textContent = `${textarea.value.length}/2000`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitInlineComment(videoId, '', textarea);
  });
}

async function submitInlineComment(videoId, parentId, textarea) {
  const body = textarea.value.trim();
  if (!body) return;

  if (!isSignedIn()) {
    showToast('Please sign in to comment', 'info');
    return;
  }

  const form = textarea.closest('form');
  const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
  if (submitBtn) submitBtn.disabled = true;

  const user = getCurrentUser();
  const optId = 'opt_' + Date.now();
  const optimisticComment = {
    comment_id: optId,
    parent_id: parentId,
    user_name: user.name,
    user_avatar: user.picture,
    body: body,
    created_at: new Date().toISOString(),
    isOptimistic: true,
    depth: parentId ? 1 : 0
  };

  // Generate HTML
  const html = parentId ? createCommentHtml(optimisticComment) : createCommentThread(optimisticComment);
  
  // Inject into DOM
  if (parentId) {
    const parentThread = document.querySelector(`.comment[data-comment-id="${parentId}"]`).closest('.comment-thread');
    if (parentThread) {
      let repliesContainer = parentThread.querySelector('.comment-thread__replies');
      if (!repliesContainer) {
        repliesContainer = document.createElement('div');
        repliesContainer.className = 'comment-thread__replies';
        parentThread.appendChild(repliesContainer);
      }
      repliesContainer.insertAdjacentHTML('beforeend', html);
    }
  } else {
    const listEl = document.querySelector(`.media-card__comments-list[data-video-id="${videoId}"]`);
    if (listEl) {
      const empty = listEl.querySelector('.comments-empty');
      if (empty) empty.remove();
      listEl.insertAdjacentHTML('beforeend', html);
    }
  }

  // Update comment count
  const toggleBtn = document.querySelector(`.media-card__comments-toggle[data-video-id="${videoId}"]`);
  let previousCount = 0;
  if (toggleBtn) {
    previousCount = parseInt(toggleBtn.textContent.replace(/[^0-9]/g, '')) || 0;
    toggleBtn.textContent = `💬 ${previousCount + 1} comments`;
  }

  // Hide reply form or clear textarea
  let replyForm = null;
  if (parentId) {
    replyForm = textarea.closest('.reply-form');
    if (replyForm) replyForm.style.display = 'none';
  } else {
    textarea.value = '';
    textarea.dispatchEvent(new Event('input'));
  }

  try {
    // Ensure we have a fresh token (Google ID tokens expire after 1 hour)
    let token = getToken();
    if (isTokenExpired()) {
      const freshToken = await refreshToken();
      if (freshToken) {
        token = freshToken;
      } else {
        // Token refresh failed — sign out and ask user to re-authenticate
        signOut();
        throw new Error('Session expired. Please sign in again.');
      }
    }

    const response = await api.postComment(videoId, parentId, body, token);
    
    // Invalidate prefetch cache so next expand fetches fresh data
    delete state.commentsCache[videoId];
    
    // Success: Update optimistic ID to real ID and remove optimistic class
    const el = document.querySelector(`.comment[data-comment-id="${optId}"]`);
    if (el) {
      el.dataset.commentId = response.comment_id;
      el.classList.remove('comment--optimistic');
      if (!parentId) {
        const actions = el.querySelector('.comment__actions');
        if (actions) {
          actions.innerHTML = `<button class="comment__reply-btn reply-btn" data-comment-id="${response.comment_id}">↩ Reply</button>`;
          attachReplyHandlers(videoId);
        }
      }
    }
    
    if (replyForm) replyForm.remove();
    
    // Update localStorage cache with the new comment count
    updateCachedCommentCount(videoId, previousCount + 1);
    
    // showToast('Comment posted!', 'success'); // Optional, since it's optimistic, UI already updated
  } catch (error) {
    console.error('Failed to post comment:', error);
    
    // Rollback
    const el = document.querySelector(`.comment[data-comment-id="${optId}"]`);
    if (el) {
      const thread = el.closest('.comment-thread');
      if (thread && thread.firstElementChild === el) {
        thread.remove();
      } else {
        el.remove();
      }
    }
    
    if (toggleBtn) {
      toggleBtn.textContent = `💬 ${previousCount} comments`;
    }
    
    if (replyForm) {
      replyForm.style.display = '';
      if (submitBtn) submitBtn.disabled = false;
    } else {
      textarea.value = body;
      textarea.dispatchEvent(new Event('input'));
    }
    
    showToast('Failed to post comment. Please try again.', 'error');
  } finally {
    if (submitBtn && !replyForm) submitBtn.disabled = false;
  }
}

function attachReplyHandlers(videoId) {
  const card = document.querySelector(`.media-card[data-video-id="${videoId}"]`);
  if (!card) return;

  card.querySelectorAll('.reply-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', (e) => {
      toggleReplyForm(videoId, e.currentTarget.dataset.commentId);
    });
  });
}

function toggleReplyForm(videoId, commentId) {
  const card = document.querySelector(`.media-card[data-video-id="${videoId}"]`);
  if (card) card.querySelectorAll('.reply-form').forEach(f => f.remove());

  if (!isSignedIn()) {
    showToast('Please sign in to reply', 'info');
    return;
  }

  const commentEl = card.querySelector(`.comment[data-comment-id="${commentId}"]`);
  if (!commentEl) return;

  const replyForm = document.createElement('div');
  replyForm.className = 'reply-form';
  replyForm.innerHTML = `
    <textarea class="reply-form__textarea" placeholder="Write a reply..." maxlength="2000" rows="2"></textarea>
    <div class="reply-form__actions">
      <button class="btn btn--ghost btn--sm reply-cancel-btn">Cancel</button>
      <button class="btn btn--primary btn--sm reply-submit-btn">Reply</button>
    </div>
  `;

  commentEl.parentNode.insertBefore(replyForm, commentEl.nextSibling);
  const textarea = replyForm.querySelector('textarea');
  textarea.focus();

  replyForm.querySelector('.reply-cancel-btn').addEventListener('click', () => replyForm.remove());
  replyForm.querySelector('.reply-submit-btn').addEventListener('click', () => {
    submitInlineComment(videoId, commentId, textarea);
  });
}

// ============================================================
// AUTH UI
// ============================================================

function setupAuthUI() {
  const container = document.getElementById('auth-container');

  onAuthChange((user) => {
    updateAuthUI(user);
    state.expandedComments.forEach(videoId => updateInlineCommentFormUI(videoId));
    if (user) {
      loadMyVotes();
      loadMyStars();
    } else {
      clearVoteMarkings();
      clearStarMarkings();
      if (state.view === 'starred') update();
    }
  });

  const user = getCurrentUser();
  if (user) {
    updateAuthUI(user);
    loadMyVotes();
    loadMyStars();
  } else {
    renderSignInButton(container);
  }
}

function updateAuthUI(user) {
  const container = document.getElementById('auth-container');

  if (user) {
    container.innerHTML = `
      <div class="header__user">
        <img src="${sanitizeHtml(user.picture)}" alt="${sanitizeHtml(user.name)}" class="header__user-avatar" referrerpolicy="no-referrer" />
        <span class="header__user-name">${sanitizeHtml(user.name)}</span>
        <button class="header__signout-btn" id="signout-btn">Sign out</button>
      </div>
    `;
    document.getElementById('signout-btn').addEventListener('click', () => signOut());
  } else {
    container.innerHTML = '';
    renderSignInButton(container);
  }
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
