/**
 * Integration tests for js/api.js
 * 
 * Tests the API client with mocked fetch responses.
 * Covers: fetchFeed, fetchComments, postComment (with HMAC), error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApiClient } from '../../js/api.js';

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
const MOCK_API_SECRET = 'test-secret-key-for-hmac';

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

const mockInitResponse = {
  status: 'ok',
  api_secret: MOCK_API_SECRET,
};

/**
 * Helper: creates a fetch mock that handles both ?action=init (GET) and
 * the subsequent POST for comment submission.
 */
function createCommentFetchMock(postResponse) {
  return vi.fn(async (url, options) => {
    // GET request for init (fetching API secret)
    if (typeof url === 'string' && url.includes('action=init')) {
      return { ok: true, json: () => Promise.resolve(mockInitResponse) };
    }
    // POST request for comment
    if (options && options.method === 'POST') {
      return { ok: true, json: () => Promise.resolve(postResponse) };
    }
    // Fallback
    return { ok: true, json: () => Promise.resolve({ status: 'ok' }) };
  });
}

describe('API Client', () => {
  let api;
  let fetchMock;

  beforeEach(() => {
    localStorageMock.clear();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    api = createApiClient(MOCK_APPS_SCRIPT_URL);
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

    it('throws on network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      await expect(api.fetchFeed(1)).rejects.toThrow('Network error');
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

  describe('postComment', () => {
    it('fetches API secret then sends signed POST request', async () => {
      global.fetch = createCommentFetchMock({ status: 'ok', comment_id: 'c_new' });

      const result = await api.postComment('v1', '', 'Nice!', 'mock-google-token');
      expect(result.comment_id).toBe('c_new');

      // Should have called fetch twice: once for init, once for POST
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // First call: GET ?action=init
      const firstCall = global.fetch.mock.calls[0];
      expect(firstCall[0]).toContain('action=init');

      // Second call: POST with signature and timestamp
      const secondCall = global.fetch.mock.calls[1];
      const body = JSON.parse(secondCall[1].body);
      expect(body.action).toBe('comment');
      expect(body.videoId).toBe('v1');
      expect(body.body).toBe('Nice!');
      expect(body.token).toBe('mock-google-token');
      expect(body.signature).toBeTruthy();
      expect(body.timestamp).toBeTruthy();
    });

    it('caches the API secret across multiple calls', async () => {
      global.fetch = createCommentFetchMock({ status: 'ok', comment_id: 'c_1' });

      await api.postComment('v1', '', 'First!', 'token');
      await api.postComment('v2', '', 'Second!', 'token');

      // init should only be called once, so 3 total: 1 init + 2 posts
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('throws on blocked user response', async () => {
      global.fetch = createCommentFetchMock({ status: 'error', message: 'User is blocked' });

      await expect(
        api.postComment('v1', '', 'spam', 'token')
      ).rejects.toThrow('User is blocked');
    });
  });
});
