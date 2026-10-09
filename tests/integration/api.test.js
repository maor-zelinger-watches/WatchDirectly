/**
 * Integration tests for js/api.js
 * 
 * Tests the API client with mocked fetch responses.
 * Covers: fetchFeed, fetchComments, postComment (token-only auth), error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { createApiClient } from '../../js/api.js';
import { CONFIG } from '../../js/config.js';

/** The signature the backend expects for (action, ts) — mirrors Code.gs. */
function expectedSig(action, ts) {
  return crypto.createHmac('sha256', CONFIG.REQUEST_SIGNING_SECRET)
    .update(`${action}\n${ts}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
}

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn(key => store[key] || null),
    setItem: vi.fn((key, value) => { store[key] = value; }),
    removeItem: vi.fn(key => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();

Object.defineProperty(global, 'localStorage', { value: localStorageMock });

const MOCK_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/test/exec';

const mockFeedResponse = {
  status: 'ok',
  videos: [
    {
      video_id: 'v1',
      channel_name: 'Teddy Baldassarre',
      title: 'Test Video 1',
      published_at: '2026-05-07T10:00:00Z',
      tier: 0,
      category: 'Heavyweights',
      comment_count: 5,
    },
    {
      video_id: 'v2',
      channel_name: 'Nico Leonard',
      title: 'Test Video 2',
      published_at: '2026-05-07T08:00:00Z',
      tier: 0,
      category: 'Heavyweights',
      comment_count: 2,
    },
  ],
  total: 2,
  page: 1,
};

const mockCommentsResponse = {
  status: 'ok',
  comments: [
    {
      comment_id: 'c_001',
      video_id: 'v1',
      parent_id: '',
      user_name: 'John',
      user_avatar: 'https://example.com/avatar.jpg',
      body: 'Great video!',
      depth: 0,
      created_at: '2026-05-07T11:00:00Z',
    },
  ],
};

describe('API Client', () => {
  let api;
  let fetchMock;

  beforeEach(() => {
    localStorageMock.clear();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    // Zero backoff: the retry tests below exercise the schedule, not the clock.
    api = createApiClient(MOCK_APPS_SCRIPT_URL, { retryDelaysMs: [0, 0] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchFeed', () => {
    it('calls the correct URL with action=feed', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockFeedResponse),
      });

      await api.fetchFeed(1);

      expect(fetchMock).toHaveBeenCalledWith(
        `${MOCK_APPS_SCRIPT_URL}?action=feed&page=1&limit=20`,
        expect.any(Object)
      );
    });

    it('returns videos array on success', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockFeedResponse),
      });

      const result = await api.fetchFeed(1);
      expect(result.videos).toHaveLength(2);
      expect(result.videos[0].video_id).toBe('v1');
    });

    it('supports custom page and limit', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockFeedResponse),
      });

      await api.fetchFeed(2, 10);

      expect(fetchMock).toHaveBeenCalledWith(
        `${MOCK_APPS_SCRIPT_URL}?action=feed&page=2&limit=10`,
        expect.any(Object)
      );
    });

    it('throws on network error (after exhausting the retries)', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      await expect(api.fetchFeed(1)).rejects.toThrow('Network error');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(api.fetchFeed(1)).rejects.toThrow();
    });
  });

  describe('fetchComments', () => {
    it('calls the correct URL with videoId', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCommentsResponse),
      });

      await api.fetchComments('v1');

      expect(fetchMock).toHaveBeenCalledWith(
        `${MOCK_APPS_SCRIPT_URL}?action=comments&videoId=v1`,
        expect.any(Object)
      );
    });

    it('returns comments array', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCommentsResponse),
      });

      const result = await api.fetchComments('v1');
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].body).toBe('Great video!');
    });
  });

  describe('fetchCommentsBatch', () => {
    it('calls the correct URL with comma-separated videoIds', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', byVideo: { v1: [], v2: [] } }),
      });

      await api.fetchCommentsBatch(['v1', 'v2']);

      expect(fetchMock).toHaveBeenCalledWith(
        `${MOCK_APPS_SCRIPT_URL}?action=commentsBatch&videoIds=v1,v2`,
        expect.any(Object)
      );
    });

    it('URL-encodes video ids', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', byVideo: {} }),
      });

      await api.fetchCommentsBatch(['a&b', 'c d']);

      const calledUrl = fetchMock.mock.calls[0][0];
      expect(calledUrl).toContain('videoIds=a%26b,c%20d');
    });

    it('returns the byVideo map', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          status: 'ok',
          byVideo: { v1: mockCommentsResponse.comments, v2: [] },
        }),
      });

      const result = await api.fetchCommentsBatch(['v1', 'v2']);
      expect(result.byVideo.v1).toHaveLength(1);
      expect(result.byVideo.v2).toEqual([]);
    });
  });

  describe('fetchTopWeek', () => {
    it('calls the correct URL with action=topWeek and limit', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', videos: [], total: 0 }),
      });

      await api.fetchTopWeek(25);

      expect(fetchMock).toHaveBeenCalledWith(
        `${MOCK_APPS_SCRIPT_URL}?action=topWeek&limit=25`,
        expect.any(Object)
      );
    });

    it('returns the ranked videos array', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          status: 'ok',
          videos: [{ video_id: 'v1', vote_count: 9 }, { video_id: 'v2', vote_count: 4 }],
          total: 2,
        }),
      });

      const result = await api.fetchTopWeek();
      expect(result.videos).toHaveLength(2);
      expect(result.videos[0].vote_count).toBe(9);
    });

    it('appends the cursor param when resuming a later page', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', videos: [], total: 0, next_cursor: '' }),
      });

      const cursor = '8|2026-07-01T00:00:00.000Z|vid9';
      await api.fetchTopWeek(10, cursor);

      expect(fetchMock).toHaveBeenCalledWith(
        `${MOCK_APPS_SCRIPT_URL}?action=topWeek&limit=10&cursor=${encodeURIComponent(cursor)}`,
        expect.any(Object)
      );
    });
  });

  describe('vote', () => {
    it('POSTs a vote with the token and returns voted state + count', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', voted: true, vote_count: 3 }),
      });

      const result = await api.vote('v1', 'mock-token');
      expect(result.voted).toBe(true);
      expect(result.vote_count).toBe(3);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.action).toBe('vote');
      expect(body.videoId).toBe('v1');
      expect(body.token).toBe('mock-token');
    });

    it('propagates a server error (e.g. invalid token)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'error', message: 'Invalid authentication token' }),
      });

      await expect(api.vote('v1', 'bad')).rejects.toThrow('Invalid authentication token');
    });
  });

  describe('request signing (SEC-Sybil)', () => {
    it('adds a fresh ts + a sig the backend would accept', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', voted: true, vote_count: 1 }),
      });

      const before = Math.floor(Date.now() / 1000);
      await api.vote('v1', 'mock-token');
      const after = Math.floor(Date.now() / 1000);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // A timestamp within the request window...
      expect(body.ts).toBeGreaterThanOrEqual(before);
      expect(body.ts).toBeLessThanOrEqual(after);
      // ...and a signature that matches the backend's canonicalization exactly
      // (action\nts). This is the cross-runtime contract: Web Crypto here,
      // Utilities.computeHmacSha256Signature there.
      expect(body.sig).toBe(expectedSig('vote', body.ts));
    });

    it('signs each action for its own action name (no cross-action reuse)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', channels: [] }),
      });
      await api.fetchMyStars('mock-token');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.action).toBe('myStars');
      expect(body.sig).toBe(expectedSig('myStars', body.ts));
      // The same ts signed for 'vote' must NOT validate this myStars request.
      expect(body.sig).not.toBe(expectedSig('vote', body.ts));
    });
  });

  describe('fetchMyVotes', () => {
    it('POSTs the token and returns the voted video IDs', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', video_ids: ['v1', 'v3'] }),
      });

      const result = await api.fetchMyVotes('mock-token');
      expect(result.video_ids).toEqual(['v1', 'v3']);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.action).toBe('myVotes');
      expect(body.token).toBe('mock-token');
    });
  });

  describe('star', () => {
    it('POSTs a star toggle with the token and returns starred state', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', starred: true }),
      });

      const result = await api.star('Bark and Jack', 'mock-token');
      expect(result.starred).toBe(true);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.action).toBe('star');
      expect(body.channel).toBe('Bark and Jack');
      expect(body.token).toBe('mock-token');
    });

    it('propagates a server error (e.g. invalid token)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'error', message: 'Invalid authentication token' }),
      });

      await expect(api.star('Bark and Jack', 'bad')).rejects.toThrow('Invalid authentication token');
    });
  });

  describe('fetchMyStars', () => {
    it('POSTs the token and returns the starred channels', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', channels: ['Bark and Jack', 'Hodinkee'] }),
      });

      const result = await api.fetchMyStars('mock-token');
      expect(result.channels).toEqual(['Bark and Jack', 'Hodinkee']);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.action).toBe('myStars');
      expect(body.token).toBe('mock-token');
    });
  });

  describe('fetchBootstrap', () => {
    it('POSTs the token and returns votes and stars together', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', video_ids: ['v1'], channels: ['Hodinkee'] }),
      });

      const result = await api.fetchBootstrap('mock-token');
      expect(result.video_ids).toEqual(['v1']);
      expect(result.channels).toEqual(['Hodinkee']);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.action).toBe('bootstrap');
      expect(body.token).toBe('mock-token');
    });
  });

  describe('postComment', () => {
    it('sends a POST request with token-only auth', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', comment_id: 'c_new' }),
      });

      const result = await api.postComment('v1', '', 'Nice!', 'mock-google-token');
      expect(result.comment_id).toBe('c_new');

      // Should have called fetch once: just the POST
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const call = global.fetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.action).toBe('comment');
      expect(body.videoId).toBe('v1');
      expect(body.body).toBe('Nice!');
      expect(body.token).toBe('mock-google-token');
      // No HMAC fields
      expect(body.signature).toBeUndefined();
      expect(body.timestamp).toBeUndefined();
    });

    it('makes one fetch per comment (no init call)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', comment_id: 'c_1' }),
      });

      await api.postComment('v1', '', 'First!', 'token');
      await api.postComment('v2', '', 'Second!', 'token');

      // 2 posts, no init call
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('throws on blocked user response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'error', message: 'User is blocked' }),
      });

      await expect(
        api.postComment('v1', '', 'spam', 'token')
      ).rejects.toThrow('User is blocked');
    });
  });

  /**
   * Transient failures on Google's side (reproduced against production
   * 2026-09-23): /exec runs the script, then 302s to a one-shot
   * googleusercontent "echo" URL that serves the result — and that hop
   * intermittently answers a 404 HTML page instead of our JSON, in bursts,
   * with the script healthy. Users saw "API error: 404" on Top This Week
   * pagination and on votes. Reads retry; a write only retries when it never
   * reached the script; a write whose RESULT was lost is flagged, not resent.
   */
  describe('transient backend failures (echo-hop 404)', () => {
    const EXEC_URL = MOCK_APPS_SCRIPT_URL;
    const ECHO_URL = 'https://script.googleusercontent.com/macros/echo?user_content_key=abc&lib=x';
    const HTML_404 = '<!DOCTYPE html><html lang="he" dir="rtl"><head><title>הדף לא נמצא</title></head></html>';

    /** A real-Response-shaped stub: text() is what api.js reads. */
    const res = ({ status = 200, url = ECHO_URL, body }) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : status === 302 ? 'Found' : status === 200 ? 'OK' : 'Error',
      url,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const okFeed = () => res({ body: mockFeedResponse });

    it('a GET whose echo hop 404s is retried and succeeds on the next attempt', async () => {
      fetchMock
        .mockResolvedValueOnce(res({ status: 404, body: HTML_404 }))
        .mockResolvedValueOnce(okFeed());

      const data = await api.fetchTopWeek(10, '5|2026-09-20T11:00:05.000Z|NKtJ7kKBFG0');
      expect(data.videos).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a GET gives up after the retry schedule is exhausted (3 attempts) and reports the status', async () => {
      fetchMock.mockResolvedValue(res({ status: 404, body: HTML_404 }));

      await expect(api.fetchFeed(2)).rejects.toThrow('API error: 404');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('a 200 that carries an HTML page instead of JSON is treated as transient, not parsed', async () => {
      fetchMock
        .mockResolvedValueOnce(res({ status: 200, body: HTML_404 }))
        .mockResolvedValueOnce(okFeed());

      await expect(api.fetchFeed(1)).resolves.toMatchObject({ status: 'ok' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a Location-less 302 that carries the JSON result IS the result (no retry)', async () => {
      fetchMock.mockResolvedValueOnce(res({ status: 302, url: EXEC_URL, body: { status: 'ok', voted: true, vote_count: 4 } }));

      const data = await api.vote('v1', 'tok');
      expect(data).toMatchObject({ voted: true, vote_count: 4 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a network error on a GET is retried', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(okFeed());

      await expect(api.fetchFeed(1)).resolves.toMatchObject({ status: 'ok' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a POST that failed at /exec itself (never ran) is retried', async () => {
      fetchMock
        .mockResolvedValueOnce(res({ status: 404, url: EXEC_URL, body: HTML_404 }))
        .mockResolvedValueOnce(res({ body: { status: 'ok', voted: true, vote_count: 4 } }));

      const data = await api.vote('v1', 'tok');
      expect(data.voted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a POST whose echo hop 404s ran on the server: NOT resent, flagged resultLost', async () => {
      fetchMock.mockResolvedValueOnce(res({ status: 404, url: ECHO_URL, body: HTML_404 }));

      let caught;
      try { await api.vote('v1', 'tok'); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.resultLost).toBe(true);
      expect(caught.transient).toBeUndefined();
      expect(caught.status).toBe(404);
      expect(fetchMock).toHaveBeenCalledTimes(1); // a second POST would toggle it back
    });

    it('a network error on a POST is not retried (unknown whether it ran)', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(api.vote('v1', 'tok')).rejects.toThrow('Failed to fetch');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('an app-level error reply is final — never retried', async () => {
      fetchMock.mockResolvedValueOnce(res({ body: { status: 'error', message: 'Invalid authentication token' } }));

      await expect(api.vote('v1', 'bad')).rejects.toThrow('Invalid authentication token');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

