/**
 * api.js — API client for WatchDirectly
 * 
 * Communicates with the Google Apps Script web app backend.
 * All API calls go through this module for centralized error handling.
 * 
 * Authentication: Comment requests are authenticated via Google ID token,
 * which is verified server-side.
 */

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

    return response.json();
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
     * @param {number} [page=1] - Page number for pagination
     * @param {number} [limit=20] - Videos per page
     * @returns {Promise<{videos: Object[], total: number, page: number}>}
     */
    async fetchFeed(page = 1, limit = 20) {
      return get(`action=feed&page=${page}&limit=${limit}`);
    },

    /**
     * Fetches comments for a specific video.
     * 
     * @param {string} videoId - YouTube video ID or article item ID
     * @returns {Promise<{comments: Object[]}>}
     */
    async fetchComments(videoId) {
      return get(`action=comments&videoId=${videoId}`);
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
  };
}

