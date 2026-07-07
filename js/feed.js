/**
 * feed.js — Feed rendering for WatchDirectly
 * 
 * Handles video card creation with inline comments,
 * chronological sorting, and filtering.
 * All functions are pure and testable — DOM manipulation happens in app.js.
 */

import { timeAgo, sanitizeHtml, formatCount, safeUrl } from './utils.js';

/**
 * Detects YouTube Shorts from the stored URL — shorts entries in the
 * channel RSS feed link to youtube.com/shorts/<id>. Articles and
 * long-form videos never match.
 *
 * @param {Object} item - Media item from the API
 * @returns {boolean}
 */
export function isShort(item) {
  if (!item || item.media_type === 'article') return false;
  return typeof item.url === 'string' && item.url.includes('/shorts/');
}

/**
 * Creates an HTML string for a media card (video or article) in the feed.
 * Uses CSS Grid: thumbnail left, info right, comments below.
 * 
 * @param {Object} item - Media item data from the API
 * @returns {string} HTML string for the card
 */
export function createMediaCard(item) {
  const escaped = {
    title: sanitizeHtml(item.title),
    channel: sanitizeHtml(item.channel_name),
    category: sanitizeHtml(item.category),
    videoId: sanitizeHtml(item.video_id),
    url: safeUrl(item.url || (item.video_id && item.video_id.length === 11 ? `https://www.youtube.com/watch?v=${item.video_id}` : '')),
  };

  // Fallback: If media_type is missing but ID is > 11 chars (base64 or URL), it must be an article
  const isArticle = item.media_type === 'article' || (item.video_id && item.video_id.length > 11);
  let cardClass = isArticle ? 'article-card media-card' : 'video-card media-card';
  if (isShort(item)) cardClass += ' media-card--short';

  const viewCount = Number(item.view_count) || 0;
  const viewsHtml = viewCount > 0
    ? `<span class="media-card__separator">·</span>
            <span class="media-card__views">${formatCount(viewCount)} views</span>`
    : '';
  
  // The whole image is one link — hover overlays don't exist on touch.
  // The "Read Article" pill is a span inside it (anchors can't nest).
  const articleMedia = safeUrl(item.preview_image)
    ? `<img src="${sanitizeHtml(safeUrl(item.preview_image))}" alt="${escaped.title}" class="article-card__img" loading="lazy">`
    : `<div class="article-card__placeholder">📰</div>`;

  const embedHtml = isArticle ? `
    <div class="article-card__embed">
      ${escaped.url ? `
      <a href="${sanitizeHtml(escaped.url)}" target="_blank" rel="noopener noreferrer" class="article-card__embed-link" aria-label="Read article: ${escaped.title}">
        ${articleMedia}
        <div class="article-card__overlay">
          <span class="btn btn--primary btn--sm article-card__link-btn">Read Article</span>
        </div>
      </a>
      ` : articleMedia}
    </div>
  ` : `
    <div class="media-card__embed">
      <iframe
        data-src="https://www.youtube-nocookie.com/embed/${escaped.videoId}"
        title="${escaped.title}"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
      ></iframe>
    </div>
  `;

  return `
    <article class="${cardClass}" data-video-id="${escaped.videoId}" data-published-at="${sanitizeHtml(item.published_at || '')}">
      <div class="media-card__grid">
        ${embedHtml}
        <div class="media-card__content">
          <h3 class="media-card__title"><a href="${sanitizeHtml(escaped.url)}" target="_blank" rel="noopener noreferrer">${escaped.title}</a></h3>
          <div class="media-card__meta">
            <span class="media-card__channel">${isArticle ? '📰' : '🎬'} ${escaped.channel}</span>
            <button class="media-card__star" data-channel="${escaped.channel}" aria-pressed="false" title="Star this creator" aria-label="Star ${escaped.channel}">☆</button>
            <span class="media-card__separator">·</span>
            <span class="media-card__time">${timeAgo(item.published_at)}</span>
            ${viewsHtml}
          </div>
          <div class="media-card__tags">
            <span class="media-card__category">${escaped.category}</span>
          </div>
        </div>
      </div>
      <div class="media-card__comments-section" data-video-id="${escaped.videoId}">
        <div class="media-card__actionbar">
          <button class="media-card__vote" data-video-id="${escaped.videoId}" aria-pressed="false" title="Upvote">
            <span class="media-card__vote-icon" aria-hidden="true">▲</span>
            <span class="media-card__vote-count">${item.vote_count || 0}</span>
          </button>
          <button class="media-card__comments-toggle" data-video-id="${escaped.videoId}">
            💬 ${item.comment_count || 0} comments
          </button>
          <button class="media-card__expand" data-video-id="${escaped.videoId}" title="Expand" aria-label="Expand ${escaped.title}">
            <span class="media-card__expand-icon" aria-hidden="true">⛶</span>
          </button>
        </div>
        <div class="media-card__comments-body" data-video-id="${escaped.videoId}" style="display: none;">
          <div class="media-card__comments-list" data-video-id="${escaped.videoId}">
            <!-- Comments rendered here -->
          </div>
          <div class="media-card__comment-input" data-video-id="${escaped.videoId}">
            <div class="media-card__auth-prompt" data-video-id="${escaped.videoId}">
              <p>Sign in with Google to join the discussion</p>
            </div>
            <form class="media-card__comment-form" data-video-id="${escaped.videoId}" style="display: none;">
              <textarea
                class="media-card__textarea"
                data-video-id="${escaped.videoId}"
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
 * Filters videos by a free-text query (matched against title, channel
 * name, and the channel's host name, case-insensitive) and/or an exact
 * category. Host matching lets "Adrian" find Bark and Jack videos —
 * feed items only carry channel_name, so hosts come in via a
 * channel→host map built from creators.json.
 * Returns a new array — does not mutate the input.
 *
 * @param {Object[]} videos - Media items from the API
 * @param {{query?: string, category?: string, hostsByChannel?: Object<string, string>}} filter
 * @returns {Object[]} Matching videos, in their original order
 */
export function filterVideos(videos, { query = '', category = '', hostsByChannel = null } = {}) {
  const q = query.trim().toLowerCase();
  return videos.filter(v => {
    if (category && v.category !== category) return false;
    if (!q) return true;
    const title = (v.title || '').toLowerCase();
    const channel = (v.channel_name || '').toLowerCase();
    const host = hostsByChannel ? (hostsByChannel[v.channel_name] || '').toLowerCase() : '';
    return title.includes(q) || channel.includes(q) || host.includes(q);
  });
}

/** Engagement weight for dedupe tiebreaks: votes dominate, comments break ties. */
function engagementScore(v) {
  return (Number(v.vote_count) || 0) * 1000 + (Number(v.comment_count) || 0);
}

/**
 * Collapses items that resolve to the same URL down to a single entry.
 *
 * The backend derived article IDs two different ways over time (base64 of the
 * URL, then base64 of an MD5 hash of it), so the same article can arrive twice
 * under two different video_ids — same url, different id. The id-based dedupe
 * used everywhere else can't catch that, which is why every article rendered
 * doubled. Keyed on the url, we keep the most-engaged copy (votes first, then
 * comments) — the row users have actually interacted with. Items without a url
 * key on their video_id, so distinct id-less items are never merged.
 *
 * First occurrence keeps its slot in the output; only its value is upgraded to
 * the most-engaged duplicate. Returns a new array — does not mutate the input.
 *
 * @param {Object[]} videos - Media items from the API
 * @returns {Object[]} Deduplicated items, in first-seen order
 */
export function dedupeVideos(videos) {
  const byKey = new Map();
  for (const v of videos) {
    const key = v && v.url ? String(v.url).trim().toLowerCase() : `id:${v && v.video_id}`;
    const existing = byKey.get(key);
    if (!existing || engagementScore(v) > engagementScore(existing)) {
      byKey.set(key, v);
    }
  }
  return [...byKey.values()];
}

/**
 * Sorts videos in reverse chronological order (newest first).
 * Invalid dates sort oldest, and video_id breaks timestamp ties, so the
 * order is deterministic (and matches the server's pagination order).
 * Returns a new array — does not mutate the input.
 */
export function sortVideos(videos) {
  const time = (v) => {
    const t = new Date(v.published_at).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  return [...videos].sort((a, b) => {
    const diff = time(b) - time(a);
    if (diff !== 0) return diff;
    return String(b.video_id || '').localeCompare(String(a.video_id || ''));
  });
}
