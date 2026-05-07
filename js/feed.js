/**
 * feed.js — Feed rendering for WatchDirectly
 * 
 * Handles video card creation with inline comments,
 * chronological sorting, and filtering.
 * All functions are pure and testable — DOM manipulation happens in app.js.
 */

import { timeAgo, sanitizeHtml } from './utils.js';

/**
 * Creates an HTML string for a video card in the feed.
 * Uses CSS Grid: thumbnail left, info right, comments below.
 * 
 * @param {Object} video - Video data from the API
 * @returns {string} HTML string for the card
 */
export function createMediaCard(item) {
  const escaped = {
    title: sanitizeHtml(item.title),
    channel: sanitizeHtml(item.channel_name),
    category: sanitizeHtml(item.category),
  };

  // Fallback: If media_type is missing but ID is > 11 chars (base64 or URL), it must be an article
  const isArticle = item.media_type === 'article' || (item.video_id && item.video_id.length > 11);
  const cardClass = isArticle ? 'article-card media-card' : 'video-card media-card';
  
  const embedHtml = isArticle ? `
    <div class="article-card__embed">
      ${item.preview_image ? `<img src="${sanitizeHtml(item.preview_image)}" alt="${escaped.title}" class="article-card__img" loading="lazy">` : `<div class="article-card__placeholder">📰</div>`}
      <div class="article-card__overlay">
        <a href="${sanitizeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="btn btn--primary btn--sm article-card__link-btn">Read Article</a>
      </div>
    </div>
  ` : `
    <div class="media-card__embed">
      <iframe
        data-src="https://www.youtube-nocookie.com/embed/${item.video_id}"
        title="${escaped.title}"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
      ></iframe>
    </div>
  `;

  return `
    <article class="${cardClass}" data-video-id="${item.video_id}">
      <div class="media-card__grid">
        ${embedHtml}
        <div class="media-card__content">
          <h3 class="media-card__title">${escaped.title}</h3>
          <div class="media-card__meta">
            <span class="media-card__channel">${isArticle ? '📰' : '🎬'} ${escaped.channel}</span>
            <span class="media-card__separator">·</span>
            <span class="media-card__time">${timeAgo(item.published_at)}</span>
          </div>
          <div class="media-card__tags">
            <span class="media-card__category">${escaped.category}</span>
          </div>
        </div>
      </div>
      <div class="media-card__comments-section" data-video-id="${item.video_id}">
        <button class="media-card__comments-toggle" data-video-id="${item.video_id}">
          💬 ${item.comment_count || 0} comments
        </button>
        <div class="media-card__comments-body" data-video-id="${item.video_id}" style="display: none;">
          <div class="media-card__comments-list" data-video-id="${item.video_id}">
            <!-- Comments rendered here -->
          </div>
          <div class="media-card__comment-input" data-video-id="${item.video_id}">
            <div class="media-card__auth-prompt" data-video-id="${item.video_id}">
              <p>Sign in with Google to join the discussion</p>
            </div>
            <form class="media-card__comment-form" data-video-id="${item.video_id}" style="display: none;">
              <textarea
                class="media-card__textarea"
                data-video-id="${item.video_id}"
                placeholder="What do you think?"
                maxlength="2000"
                rows="2"
              ></textarea>
              <div class="media-card__comment-actions">
                <span class="media-card__charcount">0/2000</span>
                <button type="submit" class="btn btn--primary btn--sm">Comment</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </article>
  `.trim();
}

/**
 * Sorts videos in reverse chronological order (newest first).
 * Returns a new array — does not mutate the input.
 */
export function sortVideos(videos) {
  return [...videos].sort((a, b) => {
    return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
  });
}

/**
 * Filters videos by tier.
 */
export function filterVideos(videos, tier) {
  if (tier === 'all') return [...videos];
  return videos.filter(v => v.tier === tier);
}
