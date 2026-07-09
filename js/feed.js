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

/** The three content types the feed distinguishes, for chip filtering. */
export const CONTENT_TYPES = ['video', 'article', 'short'];

/**
 * Classifies a media item into exactly one content type: 'article', 'short',
 * or 'video'. Mirrors createMediaCard's card-class logic — the article check
 * (explicit media_type, or the >11-char id fallback for backend rows that
 * predate media_type) wins over the shorts URL check, and everything else is
 * a long-form video.
 *
 * @param {Object} item - Media item from the API
 * @returns {'video'|'article'|'short'}
 */
export function mediaType(item) {
  if (!item) return 'video';
  const isArticle = item.media_type === 'article' || (item.video_id && String(item.video_id).length > 11);
  if (isArticle) return 'article';
  if (isShort(item)) return 'short';
  return 'video';
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
        data-src="https://www.youtube-nocookie.com/embed/${escaped.videoId}?enablejsapi=1"
        title="${escaped.title}"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
      ></iframe>
    </div>
  `;

  return `
    <article class="${cardClass}" data-video-id="${escaped.videoId}" data-media-type="${mediaType(item)}" data-published-at="${sanitizeHtml(item.published_at || '')}">
      <div class="media-card__grid">
        ${embedHtml}
        <div class="media-card__content">
          <h3 class="media-card__title"><a href="${sanitizeHtml(escaped.url)}" target="_blank" rel="noopener noreferrer">${escaped.title}</a></h3>
          <div class="media-card__meta">
            <span class="media-card__channel">${isArticle ? '📰' : '🎬'} ${escaped.channel}</span>
            <button class="media-card__star" data-channel="${escaped.channel}" aria-pressed="false" title="Favorite this creator" aria-label="Favorite ${escaped.channel}">☆</button>
            <span class="media-card__separator">·</span>
            <span class="media-card__time">${timeAgo(item.published_at)}</span>
            ${viewsHtml}
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
          <button class="media-card__share" data-video-id="${escaped.videoId}" title="Share" aria-label="Share ${escaped.title}">
            <span class="media-card__share-icon" aria-hidden="true">🔗</span>
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
 * Rewrites a YouTube avatar URL to request a specific pixel size. Avatar URLs
 * carry the rendered size in a `=sNNN-...` segment (e.g. `=s900-c-k-...`); the
 * scrape stores the large default, so we down-request to what the grid shows
 * (2× the CSS size for retina) instead of shipping 900px images. Any URL that
 * doesn't match the pattern is returned untouched.
 *
 * @param {string} url
 * @param {number} size - target pixel size
 * @returns {string}
 */
export function avatarUrl(url, size = 176) {
  if (!url) return '';
  return url.replace(/=s\d+-/, `=s${size}-`);
}

/**
 * Creates an HTML string for a channel card on the Channels tab: the creator's
 * avatar (with a monogram fallback beneath, revealed if the image is missing or
 * fails to load), their name, and a favorite ☆ button. The star button reuses
 * the `media-card__star` class + `data-channel` attribute so the existing star
 * engine (toggle, sign-in reconcile, cross-view sync) drives it unchanged.
 *
 * @param {Object} creator - A channel entry from the getChannels backend action
 * @returns {string} HTML string for the card
 */
export function createChannelCard(creator) {
  const name = sanitizeHtml(creator.channel_name || '');
  const url = safeUrl(creator.url);
  const avatar = safeUrl(avatarUrl(creator.avatar));
  const initial = sanitizeHtml((creator.channel_name || '?').trim().charAt(0).toUpperCase());

  const linkOpen = url
    ? `<a href="${sanitizeHtml(url)}" target="_blank" rel="noopener noreferrer"`
    : '<span';
  const linkClose = url ? '</a>' : '</span>';

  const imgHtml = avatar
    ? `<img src="${sanitizeHtml(avatar)}" alt="" class="channel-card__avatar" loading="lazy" referrerpolicy="no-referrer">`
    : '';

  return `
    <article class="channel-card" data-channel="${name}">
      <button class="media-card__star channel-card__star" data-channel="${name}" aria-pressed="false" title="Favorite this creator" aria-label="Favorite ${name}">☆</button>
      ${linkOpen} class="channel-card__figure" aria-label="${name} on YouTube">
        <span class="channel-card__monogram" aria-hidden="true">${initial}</span>
        ${imgHtml}
      ${linkClose}
      ${linkOpen} class="channel-card__name">${name}${linkClose}
    </article>
  `.trim();
}

// --- fuzzy search --------------------------------------------------------
//
// Matching is deliberately client-side and tolerant: after the (cheap) exact
// paths — full-token equality, prefix, and substring, which cover the common
// case — a bounded edit-distance pass catches single-character typos
// ("veritasum" → "Veritasium", "budgt" → "budget"). Everything is scored so
// results can be ranked by relevance instead of returned in catalog order.

/** Lowercase and strip diacritics so "clé" matches "cle". */
function normalizeText(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // strip combining diacritical marks
}

/** Split normalized text into alphanumeric word tokens. */
function tokenize(s) {
  return normalizeText(s).split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * True when `a` and `b` are at most one edit (insert/delete/substitute)
 * apart. O(n) with early exit — no full DP matrix. Used only for tokens
 * long enough (>= 4 chars) that a single typo shouldn't collapse distinct
 * words together.
 */
function withinEdit1(a, b) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (a === b) return true;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;            // deletion from a
    else if (lb > la) j++;       // insertion into a
    else { i++; j++; }           // substitution
  }
  if (i < la || j < lb) edits++; // trailing char
  return edits <= 1;
}

// Relevance tiers for one query token against one field, best first.
const TIER_EXACT = 100;   // token equals a whole field token
const TIER_PREFIX = 60;   // a field token starts with the query token
const TIER_SUBSTR = 30;   // query token appears inside the field
const TIER_FUZZY = 12;    // within one typo of a field token
const FUZZY_MIN_LEN = 4;  // don't fuzzy-match very short tokens

/** Best tier score for one query token against one field's tokens + raw text. */
function scoreToken(qt, fieldTokens, fieldNorm) {
  let best = 0;
  for (const t of fieldTokens) {
    if (t === qt) return TIER_EXACT;            // can't beat exact
    if (t.startsWith(qt)) best = Math.max(best, TIER_PREFIX);
    else if (best < TIER_SUBSTR && t.includes(qt)) best = Math.max(best, TIER_SUBSTR);
  }
  if (best < TIER_SUBSTR && fieldNorm.includes(qt)) best = TIER_SUBSTR;
  if (best < TIER_FUZZY && qt.length >= FUZZY_MIN_LEN) {
    for (const t of fieldTokens) {
      if (withinEdit1(t, qt)) { best = TIER_FUZZY; break; }
    }
  }
  return best;
}

// Field weights: a title hit outranks a channel/host hit of the same tier.
const FIELD_WEIGHT_TITLE = 3;
const FIELD_WEIGHT_CHANNEL = 2;
const FIELD_WEIGHT_HOST = 2;

/**
 * Scores one video against the tokenized query. Returns a positive relevance
 * score only if EVERY query token matches at least one field (AND semantics —
 * more words narrows the result). 0 means "no match".
 */
function scoreVideo(v, queryTokens, hostsByChannel) {
  const titleTokens = tokenize(v.title);
  const channelTokens = tokenize(v.channel_name);
  const titleNorm = normalizeText(v.title);
  const channelNorm = normalizeText(v.channel_name);
  const hostName = hostsByChannel ? hostsByChannel[v.channel_name] || '' : '';
  const hostTokens = hostName ? tokenize(hostName) : [];
  const hostNorm = hostName ? normalizeText(hostName) : '';

  let total = 0;
  for (const qt of queryTokens) {
    const best = Math.max(
      scoreToken(qt, titleTokens, titleNorm) * FIELD_WEIGHT_TITLE,
      scoreToken(qt, channelTokens, channelNorm) * FIELD_WEIGHT_CHANNEL,
      hostTokens.length ? scoreToken(qt, hostTokens, hostNorm) * FIELD_WEIGHT_HOST : 0,
    );
    if (best === 0) return 0; // this token matched nothing → video excluded
    total += best;
  }
  return total;
}

/**
 * Filters videos by a free-text query.
 *
 * The query is tokenized and fuzzily matched against each video's title,
 * channel name, and the channel's host name (typo-tolerant, diacritic-
 * insensitive). Host matching lets "Adrian" find Bark and Jack videos —
 * feed items only carry channel_name, so hosts come in via a channel→host
 * map built from the getChannels backend action.
 *
 * Content-type filtering (the Videos/Articles/Shorts chips) is deliberately
 * NOT handled here: it's a pure CSS visibility filter over already-rendered
 * cards (views.applyTypeVisibility), so it composes with these results in
 * the DOM without triggering a re-render.
 *
 * With a query present, results are ranked by relevance (best first), ties
 * broken by original order. With no query, order is preserved exactly.
 * Returns a new array — does not mutate the input.
 *
 * @param {Object[]} videos - Media items from the API
 * @param {{query?: string, hostsByChannel?: Object<string, string>}} filter
 * @returns {Object[]} Matching videos, ranked by relevance when a query is set
 */
export function filterVideos(videos, { query = '', hostsByChannel = null } = {}) {
  const queryTokens = tokenize(query);

  if (queryTokens.length === 0) {
    return videos.slice(); // no filter: keep the caller's order untouched
  }

  const scored = [];
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const score = scoreVideo(v, queryTokens, hostsByChannel);
    if (score > 0) scored.push({ v, score, i });
  }

  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.map(s => s.v);
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
 * Reconciles a fresh Top This Week page 1 into the currently-loaded ranking
 * (stale-while-revalidate). `fresh` is authoritative for the rank window it
 * covers: its order wins, new items enter, and items that fell out of that
 * window are dropped ("remove to keep it fresh"). Any deeper pages the user
 * scrolled to — positions beyond `fresh.length` — are preserved, because a
 * page-1 fetch knows nothing about them, so absence there is not deletion.
 *
 * When the whole loaded list fits in page 1 (current.length <= fresh.length),
 * the tail is empty and this is a clean full replace: exactly the add / remove /
 * reorder the user asked for. Returns a new array — does not mutate inputs.
 *
 * @param {Object[]} current - the loaded top list (may include scrolled pages)
 * @param {Object[]} fresh - freshly fetched page 1 of the ranking
 * @returns {Object[]}
 */
export function mergeTopRanking(current, fresh) {
  const freshList = Array.isArray(fresh) ? fresh : [];
  const window = freshList.length;
  const freshIds = new Set(freshList.map(v => v && v.video_id));
  const tail = (Array.isArray(current) ? current : [])
    .slice(window)
    .filter(v => v && !freshIds.has(v.video_id));
  return [...freshList, ...tail];
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
