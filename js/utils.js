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
