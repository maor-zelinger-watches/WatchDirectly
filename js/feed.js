/**
 * feed.js — Feed rendering for WatchDirectly
 * 
 * Handles video card creation, chronological sorting, and tier/category filtering.
 * All functions are pure and testable — DOM manipulation happens in app.js.
 */

import { timeAgo, sanitizeHtml } from './utils.js';

/**
 * Creates an HTML string for a video card in the feed.
 * Each card contains an embedded YouTube player, title, channel info, and comment count.
 * 
 * @param {Object} video - Video data from the API
 * @param {string} video.video_id - YouTube video ID
 * @param {string} video.title - Video title
 * @param {string} video.channel_name - Creator channel name
 * @param {string} video.published_at - ISO date string
 * @param {number} video.tier - Creator tier (0-3)
 * @param {string} video.category - Creator category
 * @param {number} video.comment_count - Number of comments
 * @returns {string} HTML string for the card
 */
export function createVideoCard(video) {
  const escaped = {
    title: sanitizeHtml(video.title),
    channel: sanitizeHtml(video.channel_name),
    category: sanitizeHtml(video.category),
  };

  return `
    <article class="video-card" data-video-id="${video.video_id}">
      <div class="video-card__embed">
        <iframe
          src="https://www.youtube-nocookie.com/embed/${video.video_id}"
          title="${escaped.title}"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
          loading="lazy"
        ></iframe>
      </div>
      <div class="video-card__content">
        <h3 class="video-card__title">${escaped.title}</h3>
        <div class="video-card__meta">
          <span class="video-card__channel">🎬 ${escaped.channel}</span>
          <span class="video-card__separator">·</span>
          <span class="video-card__time">${timeAgo(video.published_at)}</span>
        </div>
        <div class="video-card__tags">
          <span class="video-card__tier tier-${video.tier}">Tier ${video.tier}</span>
          <span class="video-card__separator">·</span>
          <span class="video-card__category">${escaped.category}</span>
        </div>
        <button class="video-card__comments-btn" data-video-id="${video.video_id}">
          💬 ${video.comment_count || 0} comments
        </button>
      </div>
    </article>
  `.trim();
}

/**
 * Sorts videos in reverse chronological order (newest first).
 * Returns a new array — does not mutate the input.
 * 
 * @param {Object[]} videos - Array of video objects
 * @returns {Object[]} Sorted copy of the array
 */
export function sortVideos(videos) {
  return [...videos].sort((a, b) => {
    return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
  });
}

/**
 * Filters videos by tier.
 * 
 * @param {Object[]} videos - Array of video objects
 * @param {number|string} tier - Tier number to filter by, or "all" for no filter
 * @returns {Object[]} Filtered array
 */
export function filterVideos(videos, tier) {
  if (tier === 'all') return [...videos];
  return videos.filter(v => v.tier === tier);
}
