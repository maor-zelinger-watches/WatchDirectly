/**
 * Unit tests for js/fullscreen.js and the switchView scroll fix in js/views.js.
 *
 * Covers:
 *  - T3: entering fullscreen makes the card a modal dialog (role/aria-modal),
 *    marks the background inert (but not the overlay or the toast layer), and
 *    moves focus to the exit control; exiting reverses all of it and returns
 *    focus to the originating expand control; Tab focus is trapped inside.
 *  - FE9: switching tabs from an open fullscreen overlay lands at the top —
 *    the overlay's scroll restore must not clobber the scroll-to-top.
 *
 * The full enter/exit + deep-link flow is also exercised end-to-end in
 * tests/e2e/share_link.spec.js; this locks the a11y wiring in jsdom.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// fullscreen.js -> lazy-iframe.js constructs an IntersectionObserver at module
// load — stub it before importing (same dance as share.test.js).
class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('IntersectionObserver', FakeIO);

// Node's experimental localStorage lacks the API surface cache.js expects;
// install a functional mock (same pattern as pagination_cache.test.js).
let store = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
  },
  writable: true,
});

const { enterFullscreen, exitFullscreen } = await import('../../js/fullscreen.js');
const { setupTabs } = await import('../../js/views.js');
const { state } = await import('../../js/state.js');
const { createMediaCard } = await import('../../js/feed.js');
const { saveTopCache } = await import('../../js/cache.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

const mockVideo = {
  video_id: 'abc12345678',
  channel_name: 'Teddy Baldassarre',
  title: 'Top 10 Watches Under $500',
  url: 'https://www.youtube.com/watch?v=abc12345678',
  published_at: '2026-05-07T08:00:00Z',
  comment_count: 3,
  vote_count: 1,
  media_type: 'video',
};

/** Builds the real page skeleton (header/main/feed/footer/toast) around the
 *  supplied feed-container inner HTML and returns the fullscreen-able card. */
function mountPage(feedInnerHtml) {
  document.body.innerHTML = `
    <header id="header"><a href="#signin">Sign in</a></header>
    <main id="main">
      <section id="feed-view">
        <div class="feed-tabs" id="feed-tabs">
          <button class="feed-tab feed-tab--active" data-view="latest" role="tab" aria-selected="true">Latest</button>
          <button class="feed-tab" data-view="top" role="tab" aria-selected="false">Top This Week</button>
        </div>
        <div class="feed-controls" id="feed-controls"></div>
        <div class="feed" id="feed-container">${feedInnerHtml}</div>
        <div class="feed-skeleton" id="feed-skeleton" style="display:none;"></div>
        <div class="feed__load-more" id="load-more-container" style="display:none;"></div>
        <div class="feed__searching" id="feed-searching" style="display:none;"></div>
        <div class="feed__empty" id="feed-empty" style="display:none;"><p></p></div>
      </section>
    </main>
    <div class="toast-container" id="toast-container"></div>
    <footer id="footer"><a href="./terms.html">Terms</a></footer>`;
  return document.getElementById('feed-container').querySelector('.media-card');
}

function resetFullscreenState() {
  state.view = 'latest';
  state.fullscreenVideoId = null;
  state.fullscreenReturnId = null;
  state.fullscreenReturnScrollY = 0;
  state.fullscreenReturnAnchorTop = null;
  state.topLoaded = false;
  state.topVideos = null;
}

beforeEach(() => {
  store = {};
  resetFullscreenState();
  // jsdom implements neither of these; the exit scroll-restore calls them.
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('scrollBy', vi.fn());
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 0 }) })));
});

afterEach(() => {
  // Make sure the module-level keydown trap listener never leaks between tests.
  if (state.fullscreenVideoId) exitFullscreen();
  document.body.innerHTML = '';
  history.replaceState(null, '', location.pathname);
  vi.unstubAllGlobals();
  vi.stubGlobal('IntersectionObserver', FakeIO);
});

describe('fullscreen dialog semantics + focus (T3)', () => {
  it('marks the card as a modal dialog on enter and clears it on exit', () => {
    const card = mountPage(createMediaCard(mockVideo));
    card.querySelector('.media-card__comments-body').style.display = ''; // skip toggleComments

    enterFullscreen(card);
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');

    exitFullscreen();
    expect(card.hasAttribute('role')).toBe(false);
    expect(card.hasAttribute('aria-modal')).toBe(false);
  });

  it('inerts the background feed/header/footer but not the overlay or toasts', () => {
    // Two feed cards: the second is the sibling that should go inert.
    const card = mountPage(createMediaCard(mockVideo) + createMediaCard({ ...mockVideo, video_id: 'zzz99999999' }));
    card.querySelector('.media-card__comments-body').style.display = '';
    const siblingCard = document.getElementById('feed-container')
      .querySelector('.media-card[data-video-id="zzz99999999"]');

    enterFullscreen(card);

    // Overlay itself stays interactive.
    expect(card.hasAttribute('inert')).toBe(false);
    // Background regions are sealed off.
    expect(siblingCard.hasAttribute('inert')).toBe(true);
    expect(document.getElementById('header').hasAttribute('inert')).toBe(true);
    expect(document.getElementById('footer').hasAttribute('inert')).toBe(true);
    expect(document.getElementById('feed-tabs').hasAttribute('inert')).toBe(true);
    // Toast layer stays live so status announcements still reach assistive tech.
    expect(document.getElementById('toast-container').hasAttribute('inert')).toBe(false);

    exitFullscreen();
    expect(siblingCard.hasAttribute('inert')).toBe(false);
    expect(document.getElementById('header').hasAttribute('inert')).toBe(false);
    expect(document.getElementById('footer').hasAttribute('inert')).toBe(false);
    expect(document.getElementById('feed-tabs').hasAttribute('inert')).toBe(false);
  });

  it('moves focus to the exit control on enter and back to expand on exit', () => {
    const card = mountPage(createMediaCard(mockVideo));
    card.querySelector('.media-card__comments-body').style.display = '';
    const expandBtn = card.querySelector('.media-card__expand');

    enterFullscreen(card);
    expect(document.activeElement).toBe(expandBtn);
    expect(expandBtn.getAttribute('aria-label')).toBe('Exit fullscreen');

    exitFullscreen();
    // The exit control reverts to the expand control and keeps focus.
    expect(document.activeElement).toBe(expandBtn);
    expect(expandBtn.getAttribute('aria-label')).toBe('Expand');
  });

  it('traps Tab focus inside the overlay (wraps at both ends and pulls stray focus in)', () => {
    mountPage(`
      <article class="media-card" data-video-id="vid1">
        <button class="media-card__expand" aria-label="Expand"><span class="media-card__expand-icon">⛶</span></button>
        <button class="btn-a">A</button>
        <a href="#b" class="link-b">B</a>
        <div class="media-card__comments-body" data-video-id="vid1" style="display:none;"></div>
      </article>`);
    const card = document.getElementById('feed-container').querySelector('.media-card');
    const expand = card.querySelector('.media-card__expand');
    const btnA = card.querySelector('.btn-a');
    const linkB = card.querySelector('.link-b');
    card.querySelector('.media-card__comments-body').style.display = ''; // no focusables inside

    enterFullscreen(card);
    expect(document.activeElement).toBe(expand); // focus moved in

    const tab = (shift = false) =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true }));

    // Tab from the last focusable wraps to the first.
    linkB.focus();
    tab();
    expect(document.activeElement).toBe(expand);

    // Shift+Tab from the first focusable wraps to the last.
    expand.focus();
    tab(true);
    expect(document.activeElement).toBe(linkB);

    // Focus that has escaped the overlay is pulled back to the first control.
    document.activeElement.blur();
    expect(card.contains(document.activeElement)).toBe(false);
    tab();
    expect(document.activeElement).toBe(expand);

    // btnA is a real focusable in between — sanity that our set isn't degenerate.
    expect([expand, btnA, linkB].every((el) => card.contains(el))).toBe(true);
  });
});

describe('switching tabs from fullscreen lands at the top (FE9)', () => {
  it('does not let the fullscreen scroll-restore clobber the scroll-to-top', async () => {
    // Seed the Top cache so switchView('top') takes the synchronous cache path.
    saveTopCache([{ ...mockVideo, video_id: 'top11111111' }], 1, '');

    const card = mountPage(createMediaCard(mockVideo));
    card.querySelector('.media-card__comments-body').style.display = '';

    // Simulate being deep in the Latest feed when fullscreen was entered.
    enterFullscreen(card);
    state.fullscreenReturnScrollY = 8000;
    state.fullscreenReturnId = null;
    state.fullscreenReturnAnchorTop = null;

    // A shared link's ?v= is in the URL while the overlay is open.
    history.replaceState(null, '', `${location.pathname}?v=abc12345678`);

    window.scrollTo.mockClear();
    setupTabs();
    document.querySelector('.feed-tab[data-view="top"]').click();
    await flush();

    const calls = window.scrollTo.mock.calls.map((c) => c[0]);
    // The overlay's restore (to 8000) ran, proving teardown happened...
    expect(calls.some((arg) => arg && arg.top === 8000)).toBe(true);
    // ...but the LAST scroll wins, and it's the scroll-to-top.
    expect(calls[calls.length - 1]).toEqual({ top: 0 });

    // Overlay fully torn down and the ?v= cleanup preserved.
    expect(state.fullscreenVideoId).toBe(null);
    expect(location.search).toBe('');
    expect(state.view).toBe('top');
  });
});
