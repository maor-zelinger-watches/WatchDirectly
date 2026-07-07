/**
 * app.js — Feed engine and application wiring for WatchDirectly.
 *
 * Owns the paginated Latest feed: initial load, infinite scroll,
 * stale-while-revalidate against the localStorage cache, and the
 * staggered card entrance. Everything else is delegated:
 *
 *   views.js       — tabs, search, category filters, Top/Starred views
 *   prefetch.js    — read-ahead page buffer + pagination cursor math
 *   cards.js       — card construction (shared by all views)
 *   comments-ui.js — inline comment threads and prefetching
 *   votes.js / stars.js — optimistic upvotes and starred creators
 *   fullscreen.js  — the fullscreen watch-and-discuss overlay
 *   state.js       — the shared mutable state all of the above read
 */

import { CONFIG } from './config.js';
import { state, isFilterActive } from './state.js';
import { api } from './api-client.js';
import { isShort } from './feed.js';
import { loadFeedCache, saveFeedCache, loadShowShorts, saveShowShorts } from './cache.js';
import { initAuth, renderSignInButton, getCurrentUser, onAuthChange, signOut } from './auth.js';
import { sanitizeHtml } from './utils.js';
import { showToast } from './toast.js';
import { buildCard, insertCardChronologically } from './cards.js';
import { observeLazyIframe } from './lazy-iframe.js';
import {
  serverHasMore, cursorAfter,
  invalidatePrefetchBuffer, takeBufferedPage, refillPrefetchBuffer,
} from './prefetch.js';
import { prefetchComments, updateInlineCommentFormUI } from './comments-ui.js';
import { loadMyVotes, clearVoteMarkings } from './votes.js';
import { loadStarsFromStorage, loadMyStars, clearStarMarkings, setOnStarsChanged } from './stars.js';
import { setupFullscreenKeys } from './fullscreen.js';
import { update, setupTabs, setupFeedControls } from './views.js';

// The Starred view repaints when a star lands or the server reconciles —
// registered here (not in stars.js) so stars.js stays view-agnostic.
setOnStarsChanged(() => {
  if (state.view === 'starred') update();
});

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
      state.nextCursor = data.next_cursor;
      state.videos = state.videos.concat(newVideos);

      skeleton.style.display = 'none';
      await appendCards(newVideos);
      state.initialLoadComplete = true;

      // 2. Fetch the remainder of the first page (up to PAGE_SIZE)
      if (initialLimit < CONFIG.PAGE_SIZE && state.videos.length < state.totalVideos) {
        const fullPageData = await api.fetchFeed(1, CONFIG.PAGE_SIZE);
        const fullVideos = fullPageData.videos || [];
        const remainingVideos = fullVideos.slice(initialLimit);
        state.nextCursor = fullPageData.next_cursor;

        // Filter out videos already in state
        const uniqueRemaining = remainingVideos.filter(nv => !state.videos.some(sv => sv.video_id === nv.video_id));

        state.videos = state.videos.concat(uniqueRemaining);
        await appendCards(uniqueRemaining);
      }

      state.currentPage = 1;
      state.hasMore = serverHasMore();
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
      let batch = takeBufferedPage(nextPage);

      if (!batch) {
        // Outscrolled the prefetch — fall back to fetching on demand.
        // pendingFetchPage stops a concurrent refill response for this same
        // page from poisoning the buffer head (currentPage only advances
        // after this await); the token check discards OUR response if the
        // pagination was reset (feed revalidation) while we waited.
        const epoch = state.prefetchToken;
        state.pendingFetchPage = nextPage;
        try {
          const data = await api.fetchFeed(nextPage, CONFIG.PAGE_SIZE, state.nextCursor || '');
          if (epoch !== state.prefetchToken) return;
          batch = { videos: data.videos || [], nextCursor: data.next_cursor };
          state.totalVideos = data.total || 0;
        } finally {
          state.pendingFetchPage = 0;
        }
      }

      state.currentPage = nextPage;
      state.nextCursor = batch.nextCursor;
      const newVideos = batch.videos;

      // Filter out items already in state to handle pagination overlap (e.g., when new items were added since last fetch)
      const uniqueNewVideos = newVideos.filter(nv => !state.videos.some(sv => sv.video_id === nv.video_id));

      state.videos = state.videos.concat(uniqueNewVideos);
      // An empty page means we've walked past the real end of the catalog.
      // Without cursors the server total can overcount what forward
      // pagination can reach (items prepended mid-session shift pages;
      // the dedupe above drops the duplicates), so an unreachable total
      // must not keep hasMore true — that would spin the retrigger loop
      // on empty fetches forever.
      state.hasMore = newVideos.length > 0 && serverHasMore();

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
  state.nextCursor = cursorAfter(cached.videos);
  state.hasMore = state.videos.length < state.totalVideos;
  state.initialLoadComplete = true;

  await appendCards(cached.videos);

  // Reveal the sentinel only AFTER the cached cards are in. While the
  // container is still empty the sentinel sits at the top of the viewport,
  // and the observer's first snapshot would fire loadNextPage with zero
  // user intent — auto-fetching pages past a cache nobody scrolled yet.
  if (state.hasMore) {
    const sentinel = document.getElementById('load-more-container');
    if (sentinel) sentinel.style.display = '';
  }
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
  // Stale-while-revalidate must never make the cached feed feel frozen.
  // While THIS background page-1 fetch is in flight the user can keep
  // scrolling and paginating — loadNextPage runs freely, no coarse block.
  // The revalidation guard is claimed only when we commit to the DOM diff
  // (further down), so pagination pauses for the reconciliation, not for the
  // network wait. Two races are handled without blocking:
  //   - A loadNextPage fetch in flight captures the prefetch token; when the
  //     diff resets pagination it bumps that token, so the stale response is
  //     discarded instead of clobbering the fresh feed.
  //   - If pagination advanced during this fetch, the identical-content fast
  //     path keeps the cursor loadNextPage set (startCurrentPage guard below).
  const startCurrentPage = state.currentPage;
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
      // read-ahead buffer can start filling from it as-is. Adopt the
      // server's cursor (exact where a derived one is best-effort), but only
      // if a concurrent loadNextPage hasn't advanced past page 1 and set a
      // later cursor in the meantime — overwriting it would re-fetch a page.
      if (state.currentPage === startCurrentPage) state.nextCursor = data.next_cursor;
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
      state.nextCursor = data.next_cursor;
      state.hasMore = serverHasMore();
      saveFeedCache(freshVideos, state.totalVideos);
      // Page 1 was replaced — pages buffered against the old pagination
      // no longer line up.
      invalidatePrefetchBuffer();
      refillPrefetchBuffer();
      return;
    }

    const container = document.getElementById('feed-container');
    if (!container) return;

    // The diff owns the container from here — pause pagination for the
    // reconciliation. Claimed before the first diff await (the removal
    // animations); everything up to that await is synchronous, so no
    // loadNextPage can slip in and advance underneath the reset.
    state.revalidating = true;

    // Invalidate the buffer eagerly — the old pagination died the moment we
    // decided fresh page 1 differs.
    invalidatePrefetchBuffer();

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
    state.nextCursor = data.next_cursor;
    state.hasMore = serverHasMore();
    // Drop prefetched comments only where the server reports a different
    // count — wiping the whole cache defeated the prefetch entirely.
    for (const fv of freshVideos) {
      const cachedComments = state.commentsCache[fv.video_id];
      if (cachedComments && cachedComments.comments.length !== (fv.comment_count || 0)) {
        delete state.commentsCache[fv.video_id];
      }
    }
    // Invalidate again: a refill restarted during the diff would have
    // buffered pages against the pre-reset currentPage.
    invalidatePrefetchBuffer();

    const sentinel = document.getElementById('load-more-container');
    if (sentinel) sentinel.style.display = state.hasMore ? '' : 'none';

    saveFeedCache(freshVideos, state.totalVideos);

    // Prefetch comments for all cards
    prefetchComments(freshVideos);

    refillPrefetchBuffer();
  } catch (e) {
    // Silent fail — stale cache is still visible
    prefetchComments(state.videos);
    // The cached pagination is still what's on screen — buffer from it
    refillPrefetchBuffer();
  } finally {
    // Release pagination on every path — including the early returns above,
    // which claimed the flag at entry but return before reaching here.
    state.revalidating = false;
    // The observer only fires on intersection CHANGES. If the sentinel sat
    // inside its margin the whole time pagination was paused (scrolled to
    // the bottom during the diff, or the diff shrank the feed under the
    // viewport), nothing would ever re-trigger it — nudge it here.
    requestAnimationFrame(() => {
      if (!state.hasMore || state.view !== 'latest' || isFilterActive()) return;
      const sentinel = document.getElementById('load-more-container');
      if (!sentinel || sentinel.style.display === 'none') return;
      const rect = sentinel.getBoundingClientRect();
      if (rect.top > 0 && rect.top <= window.innerHeight + 600) {
        loadNextPage();
      }
    });
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
// TEST-ONLY EXPORTS
// Consumed by tests/unit/revalidate_race.test.js to drive the internal feed
// state machine directly. In the browser, app.js is loaded as a plain
// <script type="module"> and nothing imports this binding, so it is inert.
// ============================================================
export const __test__ = { state, revalidateFeed, loadNextPage };
