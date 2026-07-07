/**
 * lazy-iframe.js — Deferred iframe loading.
 *
 * Cards render their embed URL into data-src; the shared observer
 * promotes it to src only when the card scrolls near the viewport, so a
 * page of cards doesn't load a page of players at once.
 */

const iframeObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const iframe = entry.target;
      if (iframe.dataset.src) {
        iframe.src = iframe.dataset.src;
        delete iframe.dataset.src;
      }
      iframeObserver.unobserve(iframe);
    }
  });
}, { rootMargin: '150px' });

/**
 * Starts lazy-loading a card's iframe. Must be called after the card is
 * inserted into the DOM — observing must happen after insertion so the
 * first intersection snapshot already sees an attached, visible element.
 */
export function observeLazyIframe(card) {
  const iframe = card.querySelector('iframe[data-src]');
  if (iframe) {
    iframeObserver.observe(iframe);
  }
}

/**
 * Loads a card's iframe immediately, bypassing the observer. Used when a
 * card is promoted to the fullscreen overlay: it's on screen now, but the
 * IntersectionObserver no longer sees it move.
 */
export function forceLoadIframe(card) {
  const iframe = card.querySelector('iframe[data-src]');
  if (iframe) {
    iframe.src = iframe.dataset.src;
    delete iframe.dataset.src;
    iframeObserver.unobserve(iframe);
  }
}
