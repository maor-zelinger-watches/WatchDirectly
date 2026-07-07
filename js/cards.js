/**
 * cards.js — Card construction and list rendering.
 *
 * createMediaCard (feed.js) produces the HTML string; buildCard turns it
 * into a live element wired to comments, votes, stars, and fullscreen.
 * The feed engine (app.js) and the views (views.js) both render through
 * here so every card behaves the same regardless of which list it's in.
 */

import { createMediaCard } from './feed.js';
import { state } from './state.js';
import { toggleComments } from './comments-ui.js';
import { toggleVote } from './votes.js';
import { toggleStar, markStarButton } from './stars.js';
import { toggleFullscreen } from './fullscreen.js';
import { observeLazyIframe } from './lazy-iframe.js';

/**
 * Builds a card element from a media item and wires up its comment
 * toggle. Caller inserts it into the DOM, then calls observeLazyIframe —
 * observing must happen after insertion so the first intersection
 * snapshot already sees an attached, visible element.
 */
export function buildCard(video) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = createMediaCard(video);
  const card = wrapper.firstElementChild;

  const toggle = card.querySelector('.media-card__comments-toggle');
  if (toggle) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleComments(toggle.dataset.videoId);
    });
  }

  const voteBtn = card.querySelector('.media-card__vote');
  if (voteBtn) {
    if (state.myVotes.has(voteBtn.dataset.videoId)) {
      voteBtn.classList.add('media-card__vote--active');
      voteBtn.setAttribute('aria-pressed', 'true');
    }
    voteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleVote(voteBtn.dataset.videoId);
    });
  }

  const starBtn = card.querySelector('.media-card__star');
  if (starBtn) {
    if (state.myStars.has(video.channel_name)) {
      markStarButton(starBtn, true);
    }
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStar(video.channel_name);
    });
  }

  const expandBtn = card.querySelector('.media-card__expand');
  if (expandBtn) {
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen(card);
    });
  }

  return card;
}

/**
 * Inserts a card at its reverse-chronological position among the
 * container's existing cards (the feed is newest-first).
 */
export function insertCardChronologically(container, card) {
  const t = new Date(card.dataset.publishedAt || 0).getTime();
  const existing = container.querySelectorAll('.media-card');
  for (const other of existing) {
    const ot = new Date(other.dataset.publishedAt || 0).getTime();
    if (ot < t) {
      container.insertBefore(card, other);
      return;
    }
  }
  container.appendChild(card);
}

/**
 * Renders a full list synchronously, shorts included, in the given order
 * (chronological for Latest/Starred, vote-ranked for Top This Week).
 * Used by tab switches and filter re-renders: the data is already loaded,
 * so everything appears at once — no deferred reveal, no flicker. The
 * animated shorts reveal is reserved for the Latest feed's network loads
 * (appendCards → insertShortsDeferred in app.js).
 */
export function renderList(container, videos) {
  for (const video of videos) {
    const card = buildCard(video);
    container.appendChild(card);
    observeLazyIframe(card);
  }
}
