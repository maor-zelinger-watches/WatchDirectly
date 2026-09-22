/**
 * Unit tests for js/bookmarks.js — optimistic toggling, the in-flight guard
 * (FE19), sign-in gating, reconcile semantics, and storage.
 *
 * Mirrors votes.test.js: dependencies are mocked at the module boundary so a
 * POST can be held in flight while further clicks are issued, and so the
 * bootstrap reconcile can race a local toggle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  bookmark: vi.fn(),
  isSignedIn: vi.fn(),
  ensureToken: vi.fn(),
  saveBookmarkedIds: vi.fn(),
  loadBookmarkedIds: vi.fn(),
  clearBookmarkedIds: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../js/api-client.js', () => ({
  api: { bookmark: mocks.bookmark },
}));
vi.mock('../../js/auth.js', () => ({
  isSignedIn: mocks.isSignedIn,
  ensureToken: mocks.ensureToken,
}));
vi.mock('../../js/cache.js', () => ({
  loadBookmarkedIds: mocks.loadBookmarkedIds,
  saveBookmarkedIds: mocks.saveBookmarkedIds,
  clearBookmarkedIds: mocks.clearBookmarkedIds,
}));
vi.mock('../../js/toast.js', () => ({ showToast: mocks.showToast }));

import {
  toggleBookmark, markBookmarkButton, reconcileMyBookmarks,
  clearBookmarkMarkings, loadBookmarksFromStorage,
} from '../../js/bookmarks.js';
import { state } from '../../js/state.js';

/** Flush pending microtasks + one macrotask so the airborne POST is reached. */
const flush = () => new Promise(r => setTimeout(r, 0));

const button = () => document.querySelector('.media-card__bookmark[data-video-id="vid1"]');

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.isSignedIn.mockReturnValue(true);
  mocks.ensureToken.mockResolvedValue('tok');
  mocks.loadBookmarkedIds.mockReturnValue(new Set());
  state.myBookmarks = new Set();
  document.body.innerHTML = `
    <div id="toast-container"></div>
    <button class="media-card__bookmark" data-video-id="vid1" aria-pressed="false"></button>`;
});

describe('toggleBookmark', () => {
  it('signed out: shows the sign-in toast and issues no POST', async () => {
    mocks.isSignedIn.mockReturnValue(false);
    await toggleBookmark('vid1');
    expect(mocks.showToast).toHaveBeenCalledWith('Please sign in to bookmark', 'info');
    expect(mocks.bookmark).not.toHaveBeenCalled();
    expect(state.myBookmarks.has('vid1')).toBe(false);
  });

  it('flips optimistically, then persists on server confirm', async () => {
    mocks.bookmark.mockResolvedValue({ bookmarked: true });
    const p = toggleBookmark('vid1');
    // Optimistic: state + button flip before the POST resolves
    expect(state.myBookmarks.has('vid1')).toBe(true);
    expect(button().classList.contains('media-card__bookmark--active')).toBe(true);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    await p;
    expect(state.myBookmarks.has('vid1')).toBe(true);
    expect(mocks.saveBookmarkedIds).toHaveBeenCalled();
  });

  it('a double-click issues exactly one toggle POST (FE19)', async () => {
    let resolveBookmark;
    mocks.bookmark.mockImplementation(() => new Promise(r => { resolveBookmark = r; }));

    const p1 = toggleBookmark('vid1');
    const p2 = toggleBookmark('vid1'); // second click while the first is in flight

    await flush();
    expect(mocks.bookmark).toHaveBeenCalledTimes(1);

    resolveBookmark({ bookmarked: true });
    await Promise.all([p1, p2]);
    expect(mocks.bookmark).toHaveBeenCalledTimes(1); // still just one
    expect(state.myBookmarks.has('vid1')).toBe(true);
  });

  it('releases the guard after settling so the next click toggles again', async () => {
    mocks.bookmark.mockResolvedValueOnce({ bookmarked: true });
    await toggleBookmark('vid1');
    mocks.bookmark.mockResolvedValueOnce({ bookmarked: false });
    await toggleBookmark('vid1');
    expect(mocks.bookmark).toHaveBeenCalledTimes(2);
    expect(state.myBookmarks.has('vid1')).toBe(false);
    expect(button().classList.contains('media-card__bookmark--active')).toBe(false);
  });

  it('rolls back the optimistic flip when the POST fails', async () => {
    mocks.bookmark.mockRejectedValue(new Error('boom'));
    await toggleBookmark('vid1');
    expect(state.myBookmarks.has('vid1')).toBe(false);
    expect(button().classList.contains('media-card__bookmark--active')).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith('boom', 'error');
  });

  it('translates "Unknown action" (backend predates bookmarks) into plain copy', async () => {
    mocks.bookmark.mockRejectedValue(new Error('Unknown action: bookmark'));
    await toggleBookmark('vid1');
    expect(mocks.showToast).toHaveBeenCalledWith(
      "Bookmarking isn't available yet — please try again later.", 'error');
  });
});

describe('reconcileMyBookmarks', () => {
  it('applies the snapshot to state, storage, and buttons', async () => {
    await reconcileMyBookmarks(Promise.resolve({ bookmark_ids: ['vid1', 'vid9'] }));
    expect(state.myBookmarks).toEqual(new Set(['vid1', 'vid9']));
    expect(mocks.saveBookmarkedIds).toHaveBeenCalled();
    expect(button().classList.contains('media-card__bookmark--active')).toBe(true);
  });

  it('leaves the local cache alone when the backend omits bookmark_ids', async () => {
    // A live backend that predates bookmarks answers bootstrap without the
    // field — that's "no data", not "you have no bookmarks".
    state.myBookmarks = new Set(['vid1']);
    await reconcileMyBookmarks(Promise.resolve({ video_ids: ['voteA'], channels: [] }));
    expect(state.myBookmarks).toEqual(new Set(['vid1']));
    expect(mocks.saveBookmarkedIds).not.toHaveBeenCalled();
  });

  it('a bookmark toggled while the snapshot is in flight beats it', async () => {
    mocks.bookmark.mockResolvedValue({ bookmarked: true });
    let resolveFetch;
    const fetchPromise = new Promise(r => { resolveFetch = r; });
    const reconciling = reconcileMyBookmarks(fetchPromise);

    await toggleBookmark('vid1'); // bumps the epoch past the observed one
    resolveFetch({ bookmark_ids: [] }); // stale server snapshot: no bookmarks
    await reconciling;

    expect(state.myBookmarks.has('vid1')).toBe(true); // the toggle won
  });
});

describe('storage + sign-out', () => {
  it('loadBookmarksFromStorage seeds state from the cache', () => {
    mocks.loadBookmarkedIds.mockReturnValue(new Set(['vidA']));
    loadBookmarksFromStorage();
    expect(state.myBookmarks).toEqual(new Set(['vidA']));
  });

  it('clearBookmarkMarkings empties state, storage, and buttons', () => {
    state.myBookmarks = new Set(['vid1']);
    markBookmarkButton(button(), true);
    clearBookmarkMarkings();
    expect(state.myBookmarks.size).toBe(0);
    expect(mocks.clearBookmarkedIds).toHaveBeenCalled();
    expect(button().classList.contains('media-card__bookmark--active')).toBe(false);
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });
});
