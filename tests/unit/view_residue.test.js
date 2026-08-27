/**
 * Regression tests — leaving the Channels tab must not leave channel cards
 * behind in the next view.
 *
 * The Channels tab fills the shared #feed-container with .channel-card
 * elements (renderChannels). The Starred view and the searched Latest view
 * both re-render through reconcileList, which diffs only .media-card
 * elements — so the channel grid survived the tab switch and buried the
 * incoming feed under a wall of leftover channel cards (the "Favorites
 * doesn't load" bug: Favorites → Channels → Favorites).
 *
 * These drive the real view entry point (views.js update()) over a
 * scaffolded feed DOM, exactly as a tab switch does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { state } from '../../js/state.js';

// views.js transitively imports cards.js -> lazy-iframe.js, which builds an
// IntersectionObserver at module load — stub it before the dynamic import.
class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }

// GIS stub: just enough for initAuth to restore the fake session from
// localStorage (it bails before the restore when `google` is missing).
const FAKE_GIS = {
  accounts: {
    id: {
      initialize() {}, prompt() {}, renderButton() {}, disableAutoSelect() {},
    },
  },
};

const CREATORS = [
  'Teddy Baldassarre', 'Nico Leonard', 'Bark and Jack',
].map((channel_name) => ({
  channel_name,
  host: channel_name,
  url: `https://www.youtube.com/@${channel_name.replace(/\W/g, '')}`,
  avatar: '',
}));

const VIDEOS = [
  { video_id: 'res_vid_t1', channel_name: 'Teddy Baldassarre', title: 'Teddy Video', url: 'https://www.youtube.com/watch?v=res_vid_t1', published_at: '2026-08-26T10:00:00.000Z', category: 'Reviews', vote_count: 0, comment_count: 0 },
  { video_id: 'res_vid_n1', channel_name: 'Nico Leonard', title: 'Nico Video', url: 'https://www.youtube.com/watch?v=res_vid_n1', published_at: '2026-08-26T09:00:00.000Z', category: 'Reviews', vote_count: 0, comment_count: 0 },
];

let update;

// Minimal storage stub (same pattern as auth.test.js — this jsdom setup has no
// working localStorage): enough for auth.js to restore the fake session.
function installStorage() {
  const store = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    writable: true,
    configurable: true,
  });
}

/** Flushes the microtask chain the async view renders resolve through. */
async function flushRenders() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** Renders the Channels tab into the container and waits for its cards. */
async function openChannels(container) {
  state.view = 'channels';
  update();
  await flushRenders();
  expect(container.querySelectorAll('.channel-card').length).toBe(CREATORS.length);
}

beforeEach(async () => {
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('google', FAKE_GIS);
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', videos: [], total: 0 }) })));

  if (!update) {
    installStorage();
    const views = await import('../../js/views.js');
    update = views.update;
    // Restore a fake signed-in session — renderStarred gates on isSignedIn().
    localStorage.setItem('wd_user', JSON.stringify({ name: 'Test User', email: 't@example.com', picture: '', token: 'wds1.x.y' }));
    (await import('../../js/auth.js')).initAuth('test-client-id');
  }

  // The feed DOM the views render into (mirrors index.html).
  document.body.innerHTML = `
    <div id="feed-controls"></div>
    <div id="feed-container" class="feed" role="tabpanel"></div>
    <div id="feed-skeleton" style="display: none;"></div>
    <div id="load-more-container" style="display: none;"></div>
    <div id="feed-searching" style="display: none;"></div>
    <div id="feed-empty" style="display: none;"><p></p></div>
  `;

  state.view = 'latest';
  state.videos = [];
  state.filter.query = '';
  state.filter.types = [];
  state.expandedComments = new Set();
  state.fullscreenVideoId = null;
  state.creators = CREATORS;
  state.myStars = new Set(['Teddy Baldassarre']);
  // A complete in-memory index, so Starred and search render without network.
  state.searchIndex = [...VIDEOS];
  state.searchIndexComplete = true;
  state.searchIndexPromise = null;
  state.searchIndexProgress = new Set();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.searchIndex = null;
  state.searchIndexComplete = false;
  state.creators = null;
  state.myStars = new Set();
  state.filter.query = '';
  state.view = 'latest';
  document.body.innerHTML = '';
});

describe('leaving the Channels tab leaves no channel cards behind', () => {
  it('Channels → Starred renders only the starred feed', async () => {
    const container = document.getElementById('feed-container');
    await openChannels(container);

    state.view = 'starred';
    update();
    await flushRenders();

    // The starred feed painted (Teddy is starred; Nico is not)…
    const cards = [...container.querySelectorAll('.media-card')];
    expect(cards.map((c) => c.dataset.videoId)).toEqual(['res_vid_t1']);
    // …and nothing of the channel grid survived the switch.
    expect(container.querySelectorAll('.channel-card').length).toBe(0);
  });

  it('Channels → Latest with an active search renders only the matches', async () => {
    const container = document.getElementById('feed-container');
    state.filter.query = 'Teddy';
    await openChannels(container);

    state.view = 'latest';
    update();
    await flushRenders();

    const cards = [...container.querySelectorAll('.media-card')];
    expect(cards.map((c) => c.dataset.videoId)).toEqual(['res_vid_t1']);
    expect(container.querySelectorAll('.channel-card').length).toBe(0);
  });
});
