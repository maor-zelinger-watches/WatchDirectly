/**
 * Accessibility regression tests for the fe-a11y-core fixes (T8, T13, T15).
 *
 * - T13: #toast-container is a polite, atomic live region so toast errors
 *   are announced.
 * - T8:  the feed tabs form a complete ARIA tab pattern — each tab is
 *   associated with the shared #feed-container tabpanel, carries a roving
 *   tabindex, and arrow / Home / End keys move focus (selection follows
 *   focus) with the roving tabindex kept in lockstep.
 * - T15: the comments toggle exposes aria-expanded / aria-controls / an
 *   aria-label, and toggleComments() flips aria-expanded; card markup no
 *   longer skips from h1 straight to h3.
 *
 * The tab-keyboard suite mocks api-client so no navigation can hit the
 * network, and drives the "Top This Week" view with topLoaded=true so the
 * switch runs synchronously — the roving-tabindex + focus outcomes we assert
 * are all set in switchView's synchronous prologue, before any await.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMediaCard } from '../../js/feed.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = fs.readFileSync(path.resolve(HERE, '../../index.html'), 'utf-8');

// views.js -> cards.js -> fullscreen.js -> lazy-iframe.js builds an
// IntersectionObserver at module load; jsdom has none. Stub before any import.
class FakeIO { observe() {} unobserve() {} disconnect() {} }
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = FakeIO;

// Guarantee no view switch can reach the real network: every api.* call
// resolves to a benign empty payload. Belt-and-suspenders alongside the
// pre-seeded state in the keyboard suite below.
vi.mock('../../js/api-client.js', () => {
  const empty = { videos: [], total: 0, next_cursor: '', channels: [], comments: [] };
  return { api: new Proxy({}, { get: () => () => Promise.resolve(empty) }) };
});

// Keep the views.js graph light: stub the render + fullscreen leaves so a tab
// switch does no card rendering (and never pulls in lazy-iframe's
// IntersectionObserver). The keyboard suite only asserts ARIA/focus state, not
// rendered cards. Neither module is needed by the other suites in this file.
vi.mock('../../js/cards.js', () => ({
  renderList: () => {},
  buildCard: () => '',
  buildChannelCard: () => '',
  insertCardChronologically: () => {},
}));
vi.mock('../../js/fullscreen.js', () => ({
  toggleFullscreen: () => {},
  enterFullscreen: () => {},
  exitFullscreen: () => {},
  setupFullscreenKeys: () => {},
}));

const mockVideo = {
  video_id: 'abc12345678',
  channel_name: 'Teddy Baldassarre',
  title: 'Top 10 Watches Under $500',
  url: 'https://www.youtube.com/watch?v=abc12345678',
  published_at: '2026-05-07T08:00:00Z',
  comment_count: 12,
  media_type: 'video',
};

// --- T13: toast live region -------------------------------------------------

describe('T13 — #toast-container is a live region (index.html)', () => {
  it('is a polite, atomic status region', () => {
    const tag = INDEX_HTML.match(/<div[^>]*id="toast-container"[^>]*>/)?.[0];
    expect(tag).toBeTruthy();
    expect(tag).toContain('role="status"');
    expect(tag).toContain('aria-live="polite"');
    expect(tag).toContain('aria-atomic="true"');
  });
});

// --- T8: tab ARIA wiring (static markup) ------------------------------------

describe('T8 — tab / tabpanel ARIA wiring (index.html)', () => {
  it('#feed-container is a tabpanel labelled by the active tab', () => {
    const tag = INDEX_HTML.match(/<div[^>]*id="feed-container"[^>]*>/)?.[0];
    expect(tag).toContain('role="tabpanel"');
    expect(tag).toMatch(/aria-labelledby="tab-\w+"/);
  });

  it('the active tab is in the tab order (tabindex 0) and controls the panel', () => {
    const tag = INDEX_HTML.match(/<button[^>]*id="tab-latest"[^>]*>/)?.[0];
    expect(tag).toContain('aria-controls="feed-container"');
    expect(tag).toContain('aria-selected="true"');
    expect(tag).toContain('tabindex="0"');
  });

  it('inactive tabs are removed from the tab order (roving tabindex -1)', () => {
    for (const id of ['tab-top', 'tab-starred', 'tab-channels']) {
      const tag = INDEX_HTML.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0];
      expect(tag, id).toBeTruthy();
      expect(tag).toContain('aria-controls="feed-container"');
      expect(tag).toContain('aria-selected="false"');
      expect(tag).toContain('tabindex="-1"');
    }
  });

  it('adds a visually-hidden section heading so the outline is not h1 -> h3', () => {
    expect(INDEX_HTML).toMatch(/<h2 class="sr-only">/);
  });
});

// --- T15: comments toggle markup --------------------------------------------

describe('T15 — comments toggle ARIA (createMediaCard)', () => {
  function parse(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.content;
  }

  it('exposes aria-expanded, aria-controls, and a clean aria-label', () => {
    const frag = parse(createMediaCard(mockVideo));
    const btn = frag.querySelector('.media-card__comments-toggle');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Comments');

    const body = frag.querySelector('.media-card__comments-body');
    expect(body.id).toBe(`comments-body-${mockVideo.video_id}`);
    expect(btn.getAttribute('aria-controls')).toBe(body.id);
  });

  it('card title stays an h3 under the new h2 (no double heading in the card)', () => {
    const frag = parse(createMediaCard(mockVideo));
    expect(frag.querySelector('.media-card__title').tagName).toBe('H3');
    expect(frag.querySelector('h1, h2')).toBeNull();
  });
});

// --- T15: toggleComments flips aria-expanded --------------------------------

describe('T15 — toggleComments() flips aria-expanded', () => {
  let toggleComments;

  beforeEach(async () => {
    ({ toggleComments } = await import('../../js/comments-ui.js'));
    // Minimal card: only the toggle + body. The body has no comments-list /
    // form, so the expand path's loaders all return early — no network.
    document.body.innerHTML = `
      <button class="media-card__comments-toggle" data-video-id="vid1"
              aria-label="Comments" aria-expanded="false"
              aria-controls="comments-body-vid1">💬 0 comments</button>
      <div class="media-card__comments-body" id="comments-body-vid1"
           data-video-id="vid1" style="display: none;"></div>`;
  });

  afterEach(() => { document.body.innerHTML = ''; });

  it('goes false -> true -> false in step with the body visibility', () => {
    const btn = document.querySelector('.media-card__comments-toggle');
    const body = document.querySelector('.media-card__comments-body');

    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(body.style.display).toBe('none');

    toggleComments('vid1');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(body.style.display).toBe('');

    toggleComments('vid1');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(body.style.display).toBe('none');
  });
});

// --- T8: tab keyboard navigation + roving tabindex --------------------------

describe('T8 — tab keyboard navigation + roving tabindex', () => {
  let setupTabs, state;
  const origScrollTo = window.scrollTo;
  let store;

  beforeEach(async () => {
    ({ setupTabs } = await import('../../js/views.js'));
    ({ state } = await import('../../js/state.js'));

    window.scrollTo = () => {};
    store = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
      },
      writable: true,
      configurable: true,
    });

    document.body.innerHTML = `
      <div id="feed-tabs" role="tablist" aria-label="Feed view">
        <button class="feed-tab feed-tab--active" id="tab-latest" data-view="latest" role="tab" aria-selected="true" aria-controls="feed-container" tabindex="0">Latest</button>
        <button class="feed-tab" id="tab-top" data-view="top" role="tab" aria-selected="false" aria-controls="feed-container" tabindex="-1">Top This Week</button>
        <button class="feed-tab" id="tab-starred" data-view="starred" role="tab" aria-selected="false" aria-controls="feed-container" tabindex="-1">Favorites</button>
        <button class="feed-tab" id="tab-channels" data-view="channels" role="tab" aria-selected="false" aria-controls="feed-container" tabindex="-1">Channels</button>
      </div>
      <div id="feed-controls"></div>
      <div class="feed" id="feed-container" role="tabpanel" aria-labelledby="tab-latest"></div>
      <div id="feed-skeleton" style="display:none"></div>
      <div id="load-more-container" style="display:none"></div>
      <div id="feed-searching" style="display:none"></div>
      <div id="feed-empty" style="display:none"><p>x</p></div>`;

    // Land every arrow target on a synchronous, network-free render.
    state.view = 'latest';
    state.videos = [];
    state.searchIndex = [];
    state.topLoaded = true;   // 'top' renders synchronously from memory
    state.topVideos = [];
    state.topHasMore = false;
    state.creators = [];      // 'channels' resolves from cache, no fetch

    setupTabs();
  });

  afterEach(() => {
    window.scrollTo = origScrollTo;
    document.body.innerHTML = '';
  });

  function arrow(el, key) {
    const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  }

  it('ArrowRight moves focus to the next tab and roves the tabindex', () => {
    const latest = document.getElementById('tab-latest');
    const top = document.getElementById('tab-top');
    latest.focus();

    const ev = arrow(latest, 'ArrowRight');

    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(top);
    expect(top.getAttribute('aria-selected')).toBe('true');
    expect(latest.getAttribute('aria-selected')).toBe('false');
    expect(top.tabIndex).toBe(0);
    expect(latest.tabIndex).toBe(-1);
    expect(document.getElementById('feed-container').getAttribute('aria-labelledby')).toBe('tab-top');
  });

  it('ArrowLeft wraps from the first tab to the last', () => {
    const latest = document.getElementById('tab-latest');
    const channels = document.getElementById('tab-channels');
    latest.focus();

    arrow(latest, 'ArrowLeft');

    expect(document.activeElement).toBe(channels);
    expect(channels.getAttribute('aria-selected')).toBe('true');
    expect(channels.tabIndex).toBe(0);
    expect(latest.tabIndex).toBe(-1);
  });

  it('Home and End jump to the first and last tab', () => {
    const latest = document.getElementById('tab-latest');
    const channels = document.getElementById('tab-channels');
    latest.focus();

    arrow(document.activeElement, 'End');
    expect(document.activeElement).toBe(channels);

    arrow(document.activeElement, 'Home');
    expect(document.activeElement).toBe(latest);
    expect(latest.tabIndex).toBe(0);
    expect(channels.tabIndex).toBe(-1);
  });

  it('leaves other keys alone (no preventDefault, no focus change)', () => {
    const latest = document.getElementById('tab-latest');
    latest.focus();

    const ev = arrow(latest, 'a');

    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(latest);
  });
});
