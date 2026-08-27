/**
 * Unit tests for js/cards.js.
 *
 * FE17 — the parsed publish time is cached on the element at build time so
 * chronological insert (and the revalidate reorder pass) compare numbers
 * instead of constructing a fresh Date per comparison.
 *
 * FE10 — reconcileList diffs the rendered list by video_id instead of wiping
 * the container, so a card that survives a re-render keeps its live state
 * (expanded comments, a promoted/playing iframe).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// cards.js -> lazy-iframe.js builds an IntersectionObserver at module load —
// stub it before the dynamic import (same dance as share/single-play tests).
class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('IntersectionObserver', FakeIO);

const { buildCard, insertCardChronologically, reconcileList, cardTimeMs } =
  await import('../../js/cards.js');
const { state } = await import('../../js/state.js');

/** A minimal video (short id + non-shorts url => classified as 'video'). */
function vid(id, publishedAt = '2026-01-01T00:00:00Z') {
  return {
    video_id: id,
    channel_name: 'Chan',
    title: `Title ${id}`,
    url: `https://www.youtube.com/watch?v=${id}`,
    published_at: publishedAt,
    media_type: 'video',
  };
}

const ids = (container) =>
  [...container.querySelectorAll('.media-card')].map(c => c.dataset.videoId);

beforeEach(() => {
  document.body.innerHTML = '<div id="feed-container"></div>';
  state.myVotes = new Set();
  state.myStars = new Set();
  state.fullscreenVideoId = null;
});

describe('buildCard / cardTimeMs (FE17)', () => {
  it('caches the parsed publish time as a numeric expando at build time', () => {
    const card = buildCard(vid('x', '2026-03-04T05:06:07Z'));
    expect(card._publishedAtMs).toBe(new Date('2026-03-04T05:06:07Z').getTime());
    expect(cardTimeMs(card)).toBe(card._publishedAtMs);
  });

  it('cardTimeMs falls back to a parse for an element with no expando', () => {
    const el = document.createElement('article');
    el.className = 'media-card';
    el.dataset.publishedAt = '2026-02-02T00:00:00Z';
    expect(cardTimeMs(el)).toBe(new Date('2026-02-02T00:00:00Z').getTime());
  });
});

describe('insertCardChronologically (FE17 — no Date re-parse per compare)', () => {
  it('orders by the cached timestamp, ignoring a mutated data-published-at', () => {
    const container = document.getElementById('feed-container');
    const older = buildCard(vid('old', '2026-01-01T00:00:00Z'));
    const newer = buildCard(vid('new', '2026-06-01T00:00:00Z'));
    container.appendChild(older);

    // Corrupt the dataset so a fresh re-parse would INVERT the order — the
    // cached numeric field must win, proving the compare doesn't re-parse.
    older.dataset.publishedAt = '2030-01-01T00:00:00Z'; // now "looks" newest
    newer.dataset.publishedAt = '2000-01-01T00:00:00Z'; // now "looks" oldest

    insertCardChronologically(container, newer);

    // Cached: newer (2026-06) > older (2026-01) => newer first.
    expect(ids(container)).toEqual(['new', 'old']);
  });

  it('appends the oldest card at the end', () => {
    const container = document.getElementById('feed-container');
    container.appendChild(buildCard(vid('a', '2026-05-01T00:00:00Z')));
    container.appendChild(buildCard(vid('b', '2026-03-01T00:00:00Z')));
    insertCardChronologically(container, buildCard(vid('c', '2026-01-01T00:00:00Z')));
    expect(ids(container)).toEqual(['a', 'b', 'c']);
  });
});

describe('reconcileList (FE10 — diff by video_id)', () => {
  it('reuses surviving cards and only builds/removes the delta', () => {
    const container = document.getElementById('feed-container');
    reconcileList(container, [vid('a'), vid('b'), vid('c')]);
    expect(ids(container)).toEqual(['a', 'b', 'c']);

    // Tag b so a rebuild would be detectable.
    const before = container.querySelector('.media-card[data-video-id="b"]');
    before.dataset.marker = 'kept';

    reconcileList(container, [vid('b'), vid('c')]); // 'a' dropped
    expect(ids(container)).toEqual(['b', 'c']);
    // Same element reused, not rebuilt.
    expect(container.querySelector('.media-card[data-video-id="b"]').dataset.marker).toBe('kept');
    expect(container.querySelector('.media-card[data-video-id="b"]')).toBe(before);
  });

  it('preserves a surviving card\'s live state across a re-render (no innerHTML wipe)', () => {
    const container = document.getElementById('feed-container');
    reconcileList(container, [vid('a'), vid('b')]);

    const cardA = container.querySelector('.media-card[data-video-id="a"]');
    // Simulate an expanded thread + a marker standing in for a promoted iframe.
    const body = cardA.querySelector('.media-card__comments-body');
    body.style.display = ''; // "expanded"
    const sentinel = document.createElement('span');
    sentinel.className = 'live-state-sentinel';
    cardA.appendChild(sentinel);

    // A later index chunk re-renders a superset — a wipe would destroy the state.
    reconcileList(container, [vid('a'), vid('b'), vid('c')]);

    const still = container.querySelector('.media-card[data-video-id="a"]');
    expect(still).toBe(cardA);                              // same element
    expect(still.querySelector('.live-state-sentinel')).not.toBeNull();
    expect(still.querySelector('.media-card__comments-body').style.display).toBe('');
    expect(ids(container)).toEqual(['a', 'b', 'c']);
  });

  it('reorders to the desired order, moving only misplaced cards', () => {
    const container = document.getElementById('feed-container');
    reconcileList(container, [vid('a'), vid('b'), vid('c')]);
    reconcileList(container, [vid('c'), vid('a'), vid('b')]);
    expect(ids(container)).toEqual(['c', 'a', 'b']);
  });

  it('never removes the fullscreen card, even when filtered out of the list', () => {
    const container = document.getElementById('feed-container');
    reconcileList(container, [vid('a'), vid('b')]);
    state.fullscreenVideoId = 'a';
    reconcileList(container, [vid('b')]); // 'a' not in the new list
    expect(ids(container)).toContain('a'); // kept — it's the fullscreen overlay
    expect(ids(container)).toContain('b');
  });
});
