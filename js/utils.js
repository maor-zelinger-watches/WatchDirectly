/**
 * utils.js — Utility functions for WatchDirectly
 * 
 * Pure functions with no side effects. Used across feed, comments, and API modules.
 */

/**
 * Formats a date as a relative time string (e.g., "3h", "2d", "1w").
 * 
 * @param {string|Date|number} date - ISO date string, Date object, or timestamp in ms
 * @returns {string} Relative time string
 */
export function timeAgo(date) {
  const now = Date.now();
  const then = date instanceof Date ? date.getTime() : new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;

  const years = Math.floor(days / 365);
  return `${years}y`;
}

/**
 * Formats a date as an absolute string (e.g., "May 7, 2026").
 * 
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string} Formatted date string
 */
export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * Generates a unique comment ID with a "c_" prefix.
 * Uses crypto.randomUUID if available, falls back to timestamp + random.
 * 
 * @returns {string} Unique ID string (e.g., "c_a1b2c3d4e5f6")
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }
  // Fallback for environments without crypto.randomUUID
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `c_${timestamp}${random}`;
}

/**
 * Escapes HTML special characters to prevent XSS in user-generated content.
 * Preserves newlines and spaces but escapes everything that could be interpreted as HTML.
 * 
 * @param {string} text - Raw user input
 * @returns {string} Sanitized string safe for innerHTML
 */
export function sanitizeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Simple debounce function.
 * 
 * @param {Function} fn - Function to debounce
 * @param {number} ms - Delay in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Gets a value from localStorage with TTL support.
 * 
 * @param {string} key - Storage key
 * @returns {any|null} Parsed value or null if expired/missing
 */
export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { value, expires } = JSON.parse(raw);
    if (expires && Date.now() > expires) {
      localStorage.removeItem(key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Sets a value in localStorage with TTL support.
 * 
 * @param {string} key - Storage key
 * @param {any} value - Value to store (must be JSON-serializable)
 * @param {number} ttlMs - Time to live in milliseconds
 */
export function cacheSet(key, value, ttlMs) {
  try {
    const expires = ttlMs ? Date.now() + ttlMs : null;
    localStorage.setItem(key, JSON.stringify({ value, expires }));
  } catch {
    // localStorage might be full or unavailable — fail silently
  }
}
