/**
 * fullscreen.js — Fullscreen watch-and-discuss mode.
 *
 * The expand button turns a card into a fixed overlay covering the
 * viewport — pure CSS, no navigation, no loading. On exit, the feed
 * scrolls back to whichever card was at the top before expanding.
 */

import { state } from './state.js';
import { toggleComments } from './comments-ui.js';
import { forceLoadIframe } from './lazy-iframe.js';

/** Finds the video_id of the topmost card currently visible under the header. */
function topmostVisibleCardId() {
  const headerHeight = document.getElementById('header')?.offsetHeight || 0;
  for (const card of document.querySelectorAll('#feed-container .media-card')) {
    if (card.offsetParent === null) continue; // not laid out (hidden/detached)
    // Require a meaningful part of the card below the header — a sub-pixel
    // sliver of the previous card must not steal the scroll anchor.
    if (card.getBoundingClientRect().bottom > headerHeight + 40) {
      return card.dataset.videoId || null;
    }
  }
  return null;
}

export function toggleFullscreen(card) {
  if (state.fullscreenVideoId) {
    exitFullscreen();
  } else {
    enterFullscreen(card);
  }
}

function enterFullscreen(card) {
  const videoId = card.dataset.videoId;
  if (!videoId || state.fullscreenVideoId) return;

  state.fullscreenReturnId = topmostVisibleCardId();
  state.fullscreenReturnScrollY = window.scrollY;
  const anchor = state.fullscreenReturnId
    ? document.querySelector(`#feed-container .media-card[data-video-id="${state.fullscreenReturnId}"]`)
    : null;
  state.fullscreenReturnAnchorTop = anchor ? anchor.getBoundingClientRect().top : null;
  state.fullscreenVideoId = videoId;

  document.body.classList.add('fullscreen-mode');
  card.classList.add('media-card--fullscreen');

  // The overlay is on screen now — load its iframe immediately instead of
  // waiting for the IntersectionObserver (which no longer sees it move).
  forceLoadIframe(card);

  // Fullscreen is the watch-and-discuss view — open the comments.
  const body = card.querySelector(`.media-card__comments-body[data-video-id="${videoId}"]`);
  if (body && body.style.display === 'none') {
    toggleComments(videoId);
  }

  const expandBtn = card.querySelector('.media-card__expand');
  if (expandBtn) {
    expandBtn.title = 'Exit fullscreen';
    expandBtn.setAttribute('aria-label', 'Exit fullscreen');
    const icon = expandBtn.querySelector('.media-card__expand-icon');
    if (icon) icon.textContent = '✕';
  }
}

export function exitFullscreen() {
  const card = document.querySelector('.media-card--fullscreen');
  const returnId = state.fullscreenReturnId;
  const returnScrollY = state.fullscreenReturnScrollY;
  const returnAnchorTop = state.fullscreenReturnAnchorTop;

  state.fullscreenVideoId = null;
  state.fullscreenReturnId = null;
  state.fullscreenReturnAnchorTop = null;

  document.body.classList.remove('fullscreen-mode');
  if (card) {
    card.classList.remove('media-card--fullscreen');
    const expandBtn = card.querySelector('.media-card__expand');
    if (expandBtn) {
      expandBtn.title = 'Expand';
      expandBtn.setAttribute('aria-label', 'Expand');
      const icon = expandBtn.querySelector('.media-card__expand-icon');
      if (icon) icon.textContent = '⛶';
    }
  }

  // Land back exactly where the user was. The exact offset is right when
  // nothing moved; if the feed shifted while fullscreen (revalidation,
  // inserted cards), nudge so the top card sits where it was before.
  window.scrollTo({ top: returnScrollY, behavior: 'auto' });
  if (returnId) {
    const anchor = document.querySelector(`#feed-container .media-card[data-video-id="${returnId}"]`);
    if (anchor && returnAnchorTop != null) {
      const delta = anchor.getBoundingClientRect().top - returnAnchorTop;
      if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: 'auto' });
    } else if (anchor) {
      anchor.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }
}

export function setupFullscreenKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.fullscreenVideoId) {
      exitFullscreen();
    }
  });
}
