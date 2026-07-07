/**
 * api.js — API client for WatchDirectly
 * 
 * Communicates with the Google Apps Script web app backend.
 * All API calls go through this module for centralized error handling.
 * 
 * Authentication: Comment requests are authenticated via Google ID token,
 * which is verified server-side.
 */

import { dedupeVideos } from './feed.js';

/**
 * Creates an API client bound to a specific Apps Script URL.
 * 
 * @param {string} baseUrl - The deployed Google Apps Script web app URL
 * @returns {Object} API client with fetchFeed, fetchComments, postComment methods
 */
export function createApiClient(baseUrl) {

  /**
   * Makes a GET request to the Apps Script backend.
   * @param {string} params - Query string (without leading ?)
   * @returns {Promise<Object>} Parsed JSON response
   */
  async function get(params) {
    const url = `${baseUrl}?${params}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Apps Script returns 200 even for app-level errors
    if (data.status === 'error') {
      throw new Error(data.message || 'Unknown error');
    }

    return data;
  }

  /**
   * Makes a POST request to the Apps Script backend.
   * @param {Object} body - Request body (will be JSON-stringified)
   * @returns {Promise<Object>} Parsed JSON response
   */
  async function post(body) {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Apps Script returns 200 even for app-level errors
    if (data.status === 'error') {
      throw new Error(data.message || 'Unknown error');
    }

    return data;
  }

  return {
    /**
     * Fetches the video feed. Triggers server-side RSS refresh if stale.
     *
     * When `cursor` is given, the server resumes strictly after that
     * (published_at, video_id) position — new items ingested mid-session
     * can't shift the window the way page offsets do. `page` is still
     * sent so older backends (which ignore cursors) keep working.
     *
     * @param {number} [page=1] - Page number for pagination
     * @param {number} [limit=20] - Videos per page
     * @param {string} [cursor=''] - "published_at|video_id" of the last item seen
     * @returns {Promise<{videos: Object[], total: number, page: number, next_cursor?: string}>}
     */
    async fetchFeed(page = 1, limit = 20, cursor = '') {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const data = await get(`action=feed&page=${page}&limit=${limit}${cursorParam}`);
      // Defense in depth: a backend that hasn't yet deduped its store can
      // return the same article twice under two ids (same url). Collapse them
      // here so the feed never renders doubled, even against an old deployment.
      if (Array.isArray(data.videos)) data.videos = dedupeVideos(data.videos);
      return data;
    },

    /**
     * Fetches comments for a specific video.
     * 
     * @param {string} videoId - YouTube video ID or article item ID
     * @returns {Promise<{comments: Object[]}>}
     */
    async fetchComments(videoId) {
      return get(`action=comments&videoId=${encodeURIComponent(videoId)}`);
    },

    /**
     * Fetches comments for multiple videos in one request.
     * Costs a single Apps Script execution for the whole batch.
     *
     * @param {string[]} videoIds - YouTube video IDs / article item IDs (max 20)
     * @returns {Promise<{byVideo: Object<string, Object[]>}>}
     */
    async fetchCommentsBatch(videoIds) {
      const ids = videoIds.map(encodeURIComponent).join(',');
      return get(`action=commentsBatch&videoIds=${ids}`);
    },

    /**
     * Posts a new comment. Requires a valid Google ID token.
     * Token is verified server-side via Google's tokeninfo endpoint.
     * 
     * @param {string} videoId - YouTube video ID or article item ID
     * @param {string} parentId - Parent comment ID (empty string for top-level)
     * @param {string} body - Comment text
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{comment_id: string}>}
     */
    async postComment(videoId, parentId, body, token) {
      return post({
        action: 'comment',
        videoId,
        parentId,
        body,
        token,
      });
    },

    /**
     * Fetches the top videos of the past week, ranked by upvotes.
     *
     * @param {number} [limit=50] - Max videos to return
     * @returns {Promise<{videos: Object[], total: number}>}
     */
    async fetchTopWeek(limit = 50) {
      const data = await get(`action=topWeek&limit=${limit}`);
      if (Array.isArray(data.videos)) data.videos = dedupeVideos(data.videos);
      return data;
    },

    /**
     * Toggles the signed-in user's upvote on a video.
     * Requires a valid Google ID token.
     *
     * @param {string} videoId - YouTube video ID / article item ID
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{voted: boolean, vote_count: number}>}
     */
    async vote(videoId, token) {
      return post({ action: 'vote', videoId, token });
    },

    /**
     * Fetches the set of video IDs the signed-in user has upvoted,
     * so the UI can mark its buttons. Requires a valid Google ID token.
     *
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{video_ids: string[]}>}
     */
    async fetchMyVotes(token) {
      return post({ action: 'myVotes', token });
    },

    /**
     * Toggles the signed-in user's star on a creator (channel).
     * Requires a valid Google ID token.
     *
     * @param {string} channel - Channel name as it appears on feed items
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{starred: boolean}>}
     */
    async star(channel, token) {
      return post({ action: 'star', channel, token });
    },

    /**
     * Fetches the channel names the signed-in user has starred,
     * so the UI can mark star buttons and build the Starred feed.
     *
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{channels: string[]}>}
     */
    async fetchMyStars(token) {
      return post({ action: 'myStars', token });
    },
  };
}

