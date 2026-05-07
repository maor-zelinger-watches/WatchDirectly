/**
 * api.js — API client for WatchDirectly
 * 
 * Communicates with the Google Apps Script web app backend.
 * All API calls go through this module for centralized error handling.
 * 
 * Anti-abuse: Comment requests are signed with HMAC-SHA256 using a secret
 * fetched at runtime from the backend (never in source code).
 */

import { cacheGet, cacheSet } from './utils.js';

const FEED_CACHE_KEY = 'wd_feed';
const FEED_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Creates an API client bound to a specific Apps Script URL.
 * 
 * @param {string} baseUrl - The deployed Google Apps Script web app URL
 * @returns {Object} API client with fetchFeed, fetchComments, postComment methods
 */
export function createApiClient(baseUrl) {
  // API secret fetched once from backend, kept in memory only
  let _apiSecret = null;

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
        'Content-Type': 'application/json',
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

  /**
   * Fetches the API secret from the backend (once per session).
   * The secret lives in the Meta sheet — never in frontend source code.
   * @returns {Promise<string>}
   */
  async function getApiSecret() {
    if (_apiSecret) return _apiSecret;
    const data = await get('action=init');
    _apiSecret = data.api_secret;
    return _apiSecret;
  }

  /**
   * Creates an HMAC-SHA256 signature using the Web Crypto API.
   * @param {string} payload - String to sign
   * @param {string} secret - API secret
   * @returns {Promise<string>} Hex-encoded signature
   */
  async function hmacSign(payload, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    return Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
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
     * @param {string} videoId - YouTube video ID
     * @returns {Promise<{comments: Object[]}>}
     */
    async fetchComments(videoId) {
      return get(`action=comments&videoId=${videoId}`);
    },

    /**
     * Posts a new comment. Requires a valid Google ID token.
     * Signs the request with HMAC to prevent API abuse.
     * 
     * @param {string} videoId - YouTube video ID
     * @param {string} parentId - Parent comment ID (empty string for top-level)
     * @param {string} body - Comment text
     * @param {string} token - Google Sign-In ID token
     * @returns {Promise<{comment_id: string}>}
     */
    async postComment(videoId, parentId, body, token) {
      const timestamp = Date.now().toString();
      const secret = await getApiSecret();
      const payload = `${videoId}|${body}|${timestamp}`;
      const signature = await hmacSign(payload, secret);

      return post({
        action: 'comment',
        videoId,
        parentId,
        body,
        token,
        timestamp,
        signature,
      });
    },

    /**
     * Force-refreshes the RSS feeds. Admin use.
     * @returns {Promise<Object>} Refresh stats
     */
    async forceRefresh() {
      return get('action=refresh');
    },
  };
}
