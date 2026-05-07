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
export function createVideoCard(video) {
  const escaped = {
    title: sanitizeHtml(video.title),
    channel: sanitizeHtml(video.channel_name),
    category: sanitizeHtml(video.category),
  };

  return `
    <article class="video-card" data-video-id="${video.video_id}">
      <div class="video-card__grid">
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
            <span class="video-card__category">${escaped.category}</span>
          </div>
        </div>
      </div>
      <div class="video-card__comments-section" data-video-id="${video.video_id}">
        <button class="video-card__comments-toggle" data-video-id="${video.video_id}">
          💬 ${video.comment_count || 0} comments
        </button>
        <div class="video-card__comments-body" data-video-id="${video.video_id}" style="display: none;">
          <div class="video-card__comments-list" data-video-id="${video.video_id}">
            <!-- Comments rendered here -->
          </div>
          <div class="video-card__comment-input" data-video-id="${video.video_id}">
            <div class="video-card__auth-prompt" data-video-id="${video.video_id}">
              <p>Sign in with Google to join the discussion</p>
            </div>
            <form class="video-card__comment-form" data-video-id="${video.video_id}" style="display: none;">
              <textarea
                class="video-card__textarea"
                data-video-id="${video.video_id}"
                placeholder="What do you think?"
                maxlength="2000"
                rows="2"
              ></textarea>
              <div class="video-card__comment-actions">
                <span class="video-card__charcount">0/2000</span>
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
