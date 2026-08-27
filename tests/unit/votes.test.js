/**
 * Unit tests for js/votes.js — the in-flight guard (FE19).
 *
 * toggleVote flips optimistically then POSTs. Without a guard a double-click
 * (or a mobile double-tap) fired two toggle POSTs, landing the user back where
 * they started and racing two optimistic flips. The guard ignores a repeat
 * click for the same video until its request settles, then releases.
 *
 * Dependencies are mocked at the module boundary so the POST can be held
 * in flight while the second click is issued.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  vote: vi.fn(),
  fetchMyVotes: vi.fn(),
  isSignedIn: vi.fn(),
  ensureToken: vi.fn(),
  getToken: vi.fn(),
  isTokenExpired: vi.fn(),
  refreshToken: vi.fn(),
  saveFeedCacheSoon: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../js/api-client.js', () => ({
  api: { vote: mocks.vote, fetchMyVotes: mocks.fetchMyVotes },
}));
vi.mock('../../js/auth.js', () => ({
  isSignedIn: mocks.isSignedIn,
  ensureToken: mocks.ensureToken,
  getToken: mocks.getToken,
  isTokenExpired: mocks.isTokenExpired,
  refreshToken: mocks.refreshToken,
}));
vi.mock('../../js/cache.js', () => ({ saveFeedCacheSoon: mocks.saveFeedCacheSoon }));
vi.mock('../../js/toast.js', () => ({ showToast: mocks.showToast }));

import { toggleVote } from '../../js/votes.js';
import { state } from '../../js/state.js';

/** Flush pending microtasks + one macrotask so the airborne POST is reached. */
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.isSignedIn.mockReturnValue(true);
  mocks.ensureToken.mockResolvedValue('tok');
  state.videos = [];
  state.topVideos = null;
  state.searchIndex = null;
  state.myVotes = new Set();
  document.body.innerHTML = `
    <div id="toast-container"></div>
    <button class="media-card__vote" data-video-id="vid1" aria-pressed="false">
      <span class="media-card__vote-count">3</span>
    </button>`;
});

describe('toggleVote in-flight guard (FE19)', () => {
  it('a double-click issues exactly one toggle POST', async () => {
    let resolveVote;
    mocks.vote.mockImplementation(() => new Promise(r => { resolveVote = r; }));

    const p1 = toggleVote('vid1');
    const p2 = toggleVote('vid1'); // second click while the first is in flight

    await flush(); // let the first call reach api.vote
    expect(mocks.vote).toHaveBeenCalledTimes(1);

    resolveVote({ voted: true, vote_count: 4 });
    await Promise.all([p1, p2]);
    expect(mocks.vote).toHaveBeenCalledTimes(1); // still just one
  });

  it('does not double-flip the optimistic count on a double-click', async () => {
    let resolveVote;
    mocks.vote.mockImplementation(() => new Promise(r => { resolveVote = r; }));

    const p1 = toggleVote('vid1');
    const p2 = toggleVote('vid1');
    await flush();

    // One optimistic +1 from 3, not +2.
    const count = document.querySelector('.media-card__vote-count').textContent;
    expect(count).toBe('4');

    resolveVote({ voted: true, vote_count: 4 });
    await Promise.all([p1, p2]);
  });

  it('releases the guard so a later genuine click is honored', async () => {
    mocks.vote.mockResolvedValueOnce({ voted: true, vote_count: 4 });
    await toggleVote('vid1');

    mocks.vote.mockResolvedValueOnce({ voted: false, vote_count: 3 });
    await toggleVote('vid1');

    expect(mocks.vote).toHaveBeenCalledTimes(2);
  });

  it('does not POST at all when signed out', async () => {
    mocks.isSignedIn.mockReturnValue(false);
    await toggleVote('vid1');
    expect(mocks.vote).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith('Please sign in to vote', 'info');
  });
});
