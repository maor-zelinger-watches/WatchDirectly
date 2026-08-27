/**
 * FE12 — the cached-comments refresh renders inside a 300ms fade timer. If
 * the user collapses the thread or a revalidation rebuilds the card during
 * that window, the old code rendered the fresh comments into the detached
 * node and they were silently lost until the next full refetch. The timer now
 * re-checks listEl.isConnected and skips the orphan render; the cache already
 * holds the fresh comments, so the next expand paints them.
 *
 * Fake timers drive both the fetch settle and the 300ms window — timing is
 * asserted via vitest's own timer control, never a wall-clock stopwatch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchComments: vi.fn(),
  fetchCommentsBatch: vi.fn(),
  postComment: vi.fn(),
  isSignedIn: vi.fn(() => false),
  getCurrentUser: vi.fn(() => null),
  renderSignInButton: vi.fn(),
  ensureToken: vi.fn(),
  saveFeedCacheSoon: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../js/api-client.js', () => ({
  api: {
    fetchComments: mocks.fetchComments,
    fetchCommentsBatch: mocks.fetchCommentsBatch,
    postComment: mocks.postComment,
  },
}));
vi.mock('../../js/auth.js', () => ({
  isSignedIn: mocks.isSignedIn,
  getCurrentUser: mocks.getCurrentUser,
  renderSignInButton: mocks.renderSignInButton,
  ensureToken: mocks.ensureToken,
}));
vi.mock('../../js/cache.js', () => ({ saveFeedCacheSoon: mocks.saveFeedCacheSoon }));
vi.mock('../../js/toast.js', () => ({ showToast: mocks.showToast }));

import { toggleComments } from '../../js/comments-ui.js';
import { state } from '../../js/state.js';
import { buildCommentTree } from '../../js/comments.js';

const comment = (id, at, body) => ({
  comment_id: id, parent_id: '', user_name: 'U', user_avatar: '',
  body, created_at: at, depth: 0,
});

const CACHED = [comment('c1', '2026-01-01T00:00:00Z', 'old body')];
const FRESH = [
  comment('c1', '2026-01-01T00:00:00Z', 'old body'),
  comment('c2', '2026-01-02T00:00:00Z', 'brand new'),
];

function mountCard() {
  document.body.innerHTML = `
    <button class="media-card__comments-toggle" data-video-id="vid1"
            aria-expanded="false">💬 1 comments</button>
    <div class="media-card__comments-body" data-video-id="vid1" style="display: none;">
      <div class="media-card__comments-list" data-video-id="vid1"></div>
    </div>`;
  return document.querySelector('.media-card__comments-list');
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.fetchComments.mockReset();
  state.expandedComments = new Set();
  state.commentsCache = {
    vid1: { comments: [...CACHED], tree: buildCommentTree([...CACHED]) },
  };
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('FE12 — comment refresh after the fade timer', () => {
  it('renders the fresh comments when the list is still attached', async () => {
    const listEl = mountCard();
    mocks.fetchComments.mockResolvedValue({ comments: FRESH });

    toggleComments('vid1');                 // cached paint now, fetch in flight
    await vi.advanceTimersByTimeAsync(0);   // settle the fetch → fade timer queued
    await vi.advanceTimersByTimeAsync(300); // fade window elapses

    expect(listEl.textContent).toContain('brand new');
  });

  it('skips the render when the list detached during the fade window', async () => {
    const listEl = mountCard();
    mocks.fetchComments.mockResolvedValue({ comments: FRESH });

    toggleComments('vid1');
    await vi.advanceTimersByTimeAsync(0); // fetch settled, fade timer pending
    listEl.remove();                      // card collapsed / container rebuilt
    await vi.advanceTimersByTimeAsync(300);

    // The orphan node was left alone...
    expect(listEl.textContent).not.toContain('brand new');
    // ...but the cache holds the fresh comments for the next expand.
    expect(state.commentsCache.vid1.comments).toHaveLength(2);
  });

  it('does not schedule a refresh when the cheap signature matches', async () => {
    const listEl = mountCard();
    mocks.fetchComments.mockResolvedValue({ comments: [...CACHED] });

    toggleComments('vid1');
    await vi.advanceTimersByTimeAsync(0);

    expect(listEl.classList.contains('is-updating')).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(listEl.textContent).toContain('old body');
  });
});
