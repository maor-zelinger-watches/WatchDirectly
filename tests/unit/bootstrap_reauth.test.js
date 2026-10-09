/**
 * bootstrap.js — a locally-valid session the server no longer accepts.
 *
 * The token's own exp can be fine while the backend refuses it: the session
 * was revoked (server sign-out elsewhere, a block), it passed the absolute
 * max age, or it predates session versioning (the cutover). Without recovery
 * the page would sit "signed in" with every action failing. The bootstrap
 * request gets ONE recovery: refreshToken() (silent renewal → One Tap), a
 * retry if that yields a token, otherwise sign out so the UI matches the
 * server. Non-auth failures are left alone — they're the reconcilers' problem.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = { fetchBootstrap: vi.fn() };
const auth = {
  isSignedIn: vi.fn(() => true),
  getToken: vi.fn(() => 'old-token'),
  isTokenExpired: vi.fn(() => false),
  refreshToken: vi.fn(),
  signOut: vi.fn(),
};
const seen = { votes: [], stars: [], bookmarks: [], consent: [] };

vi.mock('../../js/api-client.js', () => ({ api }));
vi.mock('../../js/auth.js', () => auth);
vi.mock('../../js/votes.js', () => ({ reconcileMyVotes: (p) => p.then((d) => seen.votes.push(d), () => {}) }));
vi.mock('../../js/stars.js', () => ({ reconcileMyStars: (p) => p.then((d) => seen.stars.push(d), () => {}) }));
vi.mock('../../js/bookmarks.js', () => ({ reconcileMyBookmarks: (p) => p.then((d) => seen.bookmarks.push(d), () => {}) }));
vi.mock('../../js/auth-overlay.js', () => ({ reconcileMyEmailConsent: (p) => p.then((d) => seen.consent.push(d), () => {}) }));

const { loadMyVotesAndStars, isSessionRejected } = await import('../../js/bootstrap.js');
const rejected = (msg) => Promise.reject(new Error(msg));
const PAYLOAD = { status: 'ok', video_ids: ['a'] };

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(seen)) seen[k].length = 0;
});

describe('isSessionRejected', () => {
  it('matches the three server answers that mean "session no longer accepted"', () => {
    expect(isSessionRejected(new Error('Invalid authentication token'))).toBe(true);
    expect(isSessionRejected(new Error('Session too old. Please sign in again.'))).toBe(true);
    expect(isSessionRejected(new Error('You have been blocked'))).toBe(true);
  });
  it('ignores transport and other errors', () => {
    expect(isSessionRejected(new Error('API error: 404'))).toBe(false);
    expect(isSessionRejected(new TypeError('Failed to fetch'))).toBe(false);
    expect(isSessionRejected(null)).toBe(false);
  });
});

describe('loadMyVotesAndStars with a server-rejected session', () => {
  it('refreshes once and retries, and every reconciler gets the retried payload', async () => {
    api.fetchBootstrap
      .mockImplementationOnce(() => rejected('Invalid authentication token'))
      .mockImplementationOnce(() => Promise.resolve(PAYLOAD));
    auth.refreshToken.mockResolvedValue('fresh-token');

    await loadMyVotesAndStars();

    expect(auth.refreshToken).toHaveBeenCalledTimes(1);
    expect(api.fetchBootstrap).toHaveBeenNthCalledWith(1, 'old-token');
    expect(api.fetchBootstrap).toHaveBeenNthCalledWith(2, 'fresh-token');
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(seen.votes).toEqual([PAYLOAD]);
    expect(seen.stars).toEqual([PAYLOAD]);
    expect(seen.bookmarks).toEqual([PAYLOAD]);
    expect(seen.consent).toEqual([PAYLOAD]);
  });

  it('signs out when no fresh token can be obtained', async () => {
    api.fetchBootstrap.mockImplementationOnce(() => rejected('Invalid authentication token'));
    auth.refreshToken.mockResolvedValue(null);

    await loadMyVotesAndStars();

    expect(api.fetchBootstrap).toHaveBeenCalledTimes(1);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(seen.votes).toEqual([]);
  });

  it('signs out when the retry is refused too — never loops', async () => {
    api.fetchBootstrap
      .mockImplementationOnce(() => rejected('Invalid authentication token'))
      .mockImplementationOnce(() => rejected('You have been blocked'));
    auth.refreshToken.mockResolvedValue('fresh-token');

    await loadMyVotesAndStars();

    expect(api.fetchBootstrap).toHaveBeenCalledTimes(2);
    expect(auth.refreshToken).toHaveBeenCalledTimes(1);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('a refreshToken failure counts as no token', async () => {
    api.fetchBootstrap.mockImplementationOnce(() => rejected('Session too old. Please sign in again.'));
    auth.refreshToken.mockRejectedValue(new Error('GIS unavailable'));

    await loadMyVotesAndStars();

    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('leaves non-auth failures alone: no refresh, no sign-out', async () => {
    api.fetchBootstrap.mockImplementationOnce(() => rejected('API error: 404'));

    await loadMyVotesAndStars();

    expect(auth.refreshToken).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('does nothing when signed out', async () => {
    auth.isSignedIn.mockReturnValueOnce(false);
    await loadMyVotesAndStars();
    expect(api.fetchBootstrap).not.toHaveBeenCalled();
  });
});
