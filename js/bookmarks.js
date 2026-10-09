/**
 * bookmarks.js — Bookmarked items: optimistic toggling, persistence, and
 * sign-in reconciliation.
 *
 * The stars pattern applied to individual items instead of channels:
 * bookmarked video ids persist to localStorage so buttons paint instantly
 * on reload, then reconcile against the server via the sign-in bootstrap.
 * The 'bookmarks' epoch orders local mutations against that snapshot so a
 * slow fetch can't clobber a bookmark the user just toggled, and the
 * in-flight guard (FE19, as in votes.js) keeps a double-tap to one POST.
 *
 * The Bookmarks view re-renders when bookmarks change; that render lives
 * in views.js, which registers itself via setOnBookmarksChanged —
 * bookmarks.js stays free of view knowledge (and of an import cycle).
 */

import { state, epoch } from './state.js';
import { api } from './api-client.js';
import { isSignedIn, getToken, isTokenExpired, refreshToken, ensureToken } from './auth.js';
import { loadBookmarkedIds, saveBookmarkedIds, clearBookmarkedIds } from './cache.js';
import { showToast } from './toast.js';
import { cssEscape } from './utils.js';

// Called after any confirmed bookmark change (server reconcile) so the
// active view can repaint. Registered by app wiring; no-op until then.
let onBookmarksChanged = () => {};

export function setOnBookmarksChanged(fn) {
  onBookmarksChanged = fn;
}

// Video ids with a bookmark request in flight — a double-tap must not fire
// two toggle POSTs that land the user back where they started (FE19).
const bookmarksInFlight = new Set();

/** Applies the visual saved/unsaved state to one bookmark button. */
export function markBookmarkButton(btn, bookmarked) {
  btn.classList.toggle('media-card__bookmark--active', bookmarked);
  btn.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
  btn.title = bookmarked ? 'Remove bookmark' : 'Save for later';
}

/** Updates every bookmark button for a video (cards may repeat across views). */
function setBookmarkButtons(videoId, bookmarked) {
  document.querySelectorAll(`.media-card__bookmark[data-video-id="${cssEscape(videoId)}"]`).forEach(btn => {
    markBookmarkButton(btn, bookmarked);
  });
}

/** Persists bookmarked ids so buttons paint instantly on reload. */
function saveBookmarksToStorage() {
  saveBookmarkedIds(state.myBookmarks);
}

export function loadBookmarksFromStorage() {
  state.myBookmarks = loadBookmarkedIds();
}

/**
 * Toggles the current user's bookmark on an item, optimistically.
 * The server is the source of truth for the final state.
 */
export async function toggleBookmark(videoId) {
  if (!videoId) return;
  if (!isSignedIn()) {
    showToast('Please sign in to bookmark', 'info');
    return;
  }

  // In-flight guard (FE19): one gesture, one toggle. Ignore a repeat click for
  // the same video until its request settles (released in `finally` below).
  if (bookmarksInFlight.has(videoId)) return;
  bookmarksInFlight.add(videoId);

  const wasBookmarked = state.myBookmarks.has(videoId);

  // Optimistic flip
  epoch.bump('bookmarks');
  if (wasBookmarked) state.myBookmarks.delete(videoId); else state.myBookmarks.add(videoId);
  setBookmarkButtons(videoId, !wasBookmarked);

  try {
    const token = await ensureToken();
    const res = await api.bookmark(videoId, token);

    // Reconcile with server truth
    epoch.bump('bookmarks');
    if (res.bookmarked) state.myBookmarks.add(videoId); else state.myBookmarks.delete(videoId);
    setBookmarkButtons(videoId, !!res.bookmarked);
    saveBookmarksToStorage();
    onBookmarksChanged();
  } catch (error) {
    if (error.resultLost && isSignedIn()) {
      // The toggle ran server-side; only Google's result hop failed (api.js
      // `resultLost`). Keep the optimistic flip and confirm it from the
      // server's own list rather than re-sending (double toggle) or rolling
      // back (the opposite of what the server now holds).
      console.warn('Bookmark result lost in transit — reconciling from bootstrap');
      saveBookmarksToStorage();
      onBookmarksChanged();
      loadMyBookmarks().catch(() => { /* best-effort; the next sign-in bootstrap reconciles */ });
      return;
    }
    console.error('Failed to bookmark:', error);
    // Rollback — unless the failure signed the user out, in which case
    // clearBookmarkMarkings already put the UI in the right state.
    if (isSignedIn()) {
      epoch.bump('bookmarks');
      if (wasBookmarked) state.myBookmarks.add(videoId); else state.myBookmarks.delete(videoId);
      setBookmarkButtons(videoId, wasBookmarked);
    }
    // A backend that predates bookmarks answers "Unknown action" — say so plainly
    const msg = /^Unknown action/i.test(error.message || '')
      ? "Bookmarking isn't available yet — please try again later."
      : (error.message || 'Failed to bookmark. Please try again.');
    showToast(msg, 'error');
  } finally {
    // Release the guard on every path so the next genuine click is honored.
    bookmarksInFlight.delete(videoId);
  }
}

/**
 * Re-fetches the signed-in user's bookmarks and marks their buttons. There is
 * no standalone myBookmarks action — the batched bootstrap request is the
 * only server source — so this rides that (its votes/stars payload is ignored).
 * Used to confirm a toggle whose result was lost in transit.
 */
export async function loadMyBookmarks() {
  if (!isSignedIn()) return;
  let token = getToken();
  if (isTokenExpired()) token = await refreshToken();
  if (!token) return; // can't reconcile right now; the cache stays best-effort
  await reconcileMyBookmarks(api.fetchBootstrap(token));
}

/**
 * Applies a bookmark snapshot from the batched bootstrap request to the UI
 * and localStorage. Captures the bookmarks epoch BEFORE awaiting so a
 * bookmark toggled while the request is in flight beats the older snapshot.
 * Takes the request promise so the sign-in bootstrap feeds this, the vote
 * reconciler, and the star reconciler the SAME request — one round trip.
 *
 * @param {Promise<{bookmark_ids?: string[]}>} fetchPromise
 */
export async function reconcileMyBookmarks(fetchPromise) {
  const e = epoch.observe('bookmarks');
  try {
    const data = await fetchPromise;
    // A bookmark toggled while this was in flight beats the older snapshot
    if (!e.current()) return;

    // A live backend that predates bookmarks omits bookmark_ids from the
    // bootstrap payload — keep the local cache rather than wiping it.
    if (!data || !Array.isArray(data.bookmark_ids)) return;

    state.myBookmarks = new Set(data.bookmark_ids.map(String));
    saveBookmarksToStorage();
    document.querySelectorAll('.media-card__bookmark').forEach(btn => {
      markBookmarkButton(btn, state.myBookmarks.has(btn.dataset.videoId));
    });
    onBookmarksChanged();
  } catch (err) {
    /* silent — bookmarking still works, buttons just won't show prior state */
  }
}

/** Clears all bookmark markings (on sign-out). */
export function clearBookmarkMarkings() {
  state.myBookmarks.clear();
  clearBookmarkedIds();
  document.querySelectorAll('.media-card__bookmark--active').forEach(btn => {
    markBookmarkButton(btn, false);
  });
}
