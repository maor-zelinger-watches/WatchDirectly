/**
 * prefetch.js — Read-ahead buffer and pagination-cursor math.
 *
 * Keeps PREFETCH_PAGES_AHEAD pages fetched beyond the rendered feed so
 * infinite scroll renders from memory. Entries are contiguous, starting
 * at currentPage+1; a pagination reset (feed revalidation) invalidates
 * both the buffer and any refill fetch still in flight via
 * state.prefetchToken.
 *
 * The cursor helpers also serve the feed engine directly: serverHasMore
 * and cursorAfter are how loadNextPage / showCachedFeed decide whether
 * and where pagination continues.
 */

import { state, isFilterActive } from './state.js';
import { api } from './api-client.js';
import { CONFIG } from './config.js';

/** Total videos sitting in the buffer, for end-of-catalog math. */
export function bufferedVideoCount() {
  return state.prefetchBuffer.reduce((n, entry) => n + entry.videos.length, 0);
}

/** Whether the server still has pages we haven't fetched (rendered or buffered). */
function hasUnfetchedPages() {
  return state.videos.length + bufferedVideoCount() < state.totalVideos;
}

/**
 * Whether more pages exist beyond what's rendered. Prefers the server's
 * cursor (exact — prepended items can't skew it); backends without
 * cursor support fall back to the count math.
 */
export function serverHasMore() {
  if (typeof state.nextCursor === 'string') return state.nextCursor !== '';
  return state.videos.length < state.totalVideos;
}

/**
 * Derives the pagination cursor that resumes after the last item of
 * `videos` (same format the backend emits: "<ISO time>|<video_id>").
 * Used when restoring a cached feed, where no server cursor was kept.
 * Returns undefined when it can't be derived — page-offset fallback.
 */
export function cursorAfter(videos) {
  if (!videos || videos.length === 0) return undefined;
  const last = videos[videos.length - 1];
  if (!last || !last.video_id) return undefined;
  const t = new Date(last.published_at).getTime();
  return `${new Date(Number.isFinite(t) ? t : 0).toISOString()}|${last.video_id}`;
}

/** The cursor the refill loop should continue from (after the last
 *  buffered page, or after the rendered feed when the buffer is empty).
 *  undefined = backend without cursor support — use page numbers. */
function nextCursorToFetch() {
  const last = state.prefetchBuffer[state.prefetchBuffer.length - 1];
  return last ? last.nextCursor : state.nextCursor;
}

/** Whether the refill loop has anything left to prefetch. */
function hasMoreToPrefetch() {
  const cursor = nextCursorToFetch();
  if (typeof cursor === 'string') return cursor !== '';
  return hasUnfetchedPages();
}

/** The next page the refill loop should fetch: after the last buffered page.
 *  Counts a page being direct-fetched by loadNextPage as taken, so a refill
 *  response for it is discarded instead of poisoning the buffer head. */
function nextPageToFetch() {
  const last = state.prefetchBuffer[state.prefetchBuffer.length - 1];
  return (last ? last.page : Math.max(state.currentPage, state.pendingFetchPage)) + 1;
}

/** Drops the buffer and cancels any in-flight refill (pagination reset). */
export function invalidatePrefetchBuffer() {
  state.prefetchBuffer = [];
  state.prefetchToken++;
}

/**
 * Takes the buffered entry ({videos, nextCursor}) for `page` if it's at
 * the head of the buffer. Anything else means the buffer no longer lines
 * up with the feed's pagination — discard it rather than render
 * out-of-order pages.
 */
export function takeBufferedPage(page) {
  if (state.prefetchBuffer.length === 0) return null;
  if (state.prefetchBuffer[0].page === page) {
    return state.prefetchBuffer.shift();
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
export async function refillPrefetchBuffer() {
  if (state.prefetching || !state.initialLoadComplete) return;
  state.prefetching = true;
  const token = state.prefetchToken;

  try {
    while (
      token === state.prefetchToken &&
      state.prefetchBuffer.length < CONFIG.PREFETCH_PAGES_AHEAD &&
      hasMoreToPrefetch()
    ) {
      const page = nextPageToFetch();
      const cursor = nextCursorToFetch();

      // Cursor mode can't leapfrog a page loadNextPage is direct-fetching:
      // the cursor to continue from is inside that response. Stop here —
      // loadNextPage refills again once its fetch lands.
      if (typeof cursor === 'string' && state.prefetchBuffer.length === 0 && state.pendingFetchPage) return;

      const data = await api.fetchFeed(page, CONFIG.PAGE_SIZE, cursor || '');
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
        // Nothing buffered and the server confirmed the end — mark the
        // rendered feed's cursor exhausted too.
        if (data.next_cursor === '' && state.prefetchBuffer.length === 0) state.nextCursor = '';
        if (!state.hasMore && state.view === 'latest' && !isFilterActive()) {
          const sentinel = document.getElementById('load-more-container');
          if (sentinel) sentinel.style.display = 'none';
        }
        break;
      }

      // A scroll may have consumed pages while this fetch was in flight;
      // only append if the response still extends the buffer contiguously.
      if (page === nextPageToFetch()) {
        state.prefetchBuffer.push({ page, videos, nextCursor: data.next_cursor });
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
