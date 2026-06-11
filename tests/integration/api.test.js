/**
 * Integration tests for js/api.js
 * 
 * Tests the API client with mocked fetch responses.
 * Covers: fetchFeed, fetchComments, postComment (token-only auth), error handling.
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
});

