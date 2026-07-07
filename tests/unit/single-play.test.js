/**
 * Unit tests for js/single-play.js
 *
 * Single-play: starting one inline video pauses the others. Detection and
 * control both ride YouTube's postMessage IFrame API — the embed carries
 * enablejsapi=1, players are registered as listeners on load, and a
 * "playing" message pauses every other player (never the one that started,
 * never via stop). Fullscreen is deliberately not involved.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMediaCard } from '../../js/feed.js';
import {
  playerStateFrom,
  registerPlayer,
  pauseOthers,
  handleMessage,
} from '../../js/single-play.js';

const YT_ORIGIN = 'https://www.youtube-nocookie.com';

/**
 * Builds an inline video card with an iframe whose contentWindow is a spy,
 * inserts it into the DOM, and returns { iframe, post }. Mirrors the real
 * markup single-play.js queries (`.media-card__embed iframe`).
 */
function addPlayer(videoId) {
  const card = document.createElement('article');
  card.className = 'video-card media-card';
  card.innerHTML = `<div class="media-card__embed"><iframe data-video-id="${videoId}"></iframe></div>`;
  document.body.appendChild(card);
  const iframe = card.querySelector('iframe');
  const post = vi.fn();
  // contentWindow is a read-only prototype getter; shadow it with a stub.
  Object.defineProperty(iframe, 'contentWindow', { value: { postMessage: post }, configurable: true });
  return { iframe, post };
}

function parsePosted(post, callIndex = 0) {
  return JSON.parse(post.mock.calls[callIndex][0]);
}

describe('embed URL', () => {
  it('carries enablejsapi=1 so the player accepts postMessage', () => {
    const html = createMediaCard({
      video_id: 'abc12345678',
      channel_name: 'Teddy Baldassarre',
      title: 'A watch review',
      url: 'https://www.youtube.com/watch?v=abc12345678',
      media_type: 'video',
    });
    expect(html).toContain('youtube-nocookie.com/embed/abc12345678?enablejsapi=1');
  });
});

describe('playerStateFrom', () => {
  it('reads the state from an onStateChange message', () => {
    expect(playerStateFrom(JSON.stringify({ event: 'onStateChange', info: 1 }))).toBe(1);
    expect(playerStateFrom(JSON.stringify({ event: 'onStateChange', info: 2 }))).toBe(2);
  });

  it('reads the state from an infoDelivery envelope', () => {
    expect(playerStateFrom(JSON.stringify({ event: 'infoDelivery', info: { playerState: 1 } }))).toBe(1);
  });

  it('accepts an already-parsed object', () => {
    expect(playerStateFrom({ event: 'onStateChange', info: 1 })).toBe(1);
  });

  it('returns null for unrelated events, junk, and non-JSON', () => {
    expect(playerStateFrom(JSON.stringify({ event: 'onReady' }))).toBeNull();
    expect(playerStateFrom(JSON.stringify({ event: 'infoDelivery', info: {} }))).toBeNull();
    expect(playerStateFrom('not json')).toBeNull();
    expect(playerStateFrom(42)).toBeNull();
    expect(playerStateFrom(null)).toBeNull();
  });
});

describe('registerPlayer', () => {
  it('posts a listening handshake to the player', () => {
    const { iframe, post } = addPlayer('vid_1');
    registerPlayer(iframe);
    expect(post).toHaveBeenCalledTimes(1);
    const msg = parsePosted(post);
    expect(msg.event).toBe('listening');
    expect(msg.id).toBe('vid_1');
  });
});

describe('pauseOthers', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('pauses every other player and never the one passed in', () => {
    const a = addPlayer('a');
    const b = addPlayer('b');
    const c = addPlayer('c');

    pauseOthers(a.iframe);

    expect(a.post).not.toHaveBeenCalled();
    for (const other of [b, c]) {
      expect(other.post).toHaveBeenCalledTimes(1);
      const msg = parsePosted(other.post);
      expect(msg.event).toBe('command');
      expect(msg.func).toBe('pauseVideo');
    }
  });

  it('never sends stopVideo (pause, not stop)', () => {
    const a = addPlayer('a');
    const b = addPlayer('b');
    pauseOthers(a.iframe);
    expect(b.post.mock.calls.every(([raw]) => !raw.includes('stopVideo'))).toBe(true);
  });
});

describe('handleMessage', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('pauses the others when a player reports it started playing', () => {
    const a = addPlayer('a');
    const b = addPlayer('b');

    handleMessage({
      origin: YT_ORIGIN,
      data: JSON.stringify({ event: 'onStateChange', info: 1 }),
      source: a.iframe.contentWindow,
    });

    expect(a.post).not.toHaveBeenCalled();
    expect(b.post).toHaveBeenCalledTimes(1);
    expect(parsePosted(b.post).func).toBe('pauseVideo');
  });

  it('ignores messages from non-YouTube origins', () => {
    const a = addPlayer('a');
    const b = addPlayer('b');

    handleMessage({
      origin: 'https://evil.example.com',
      data: JSON.stringify({ event: 'onStateChange', info: 1 }),
      source: a.iframe.contentWindow,
    });

    expect(b.post).not.toHaveBeenCalled();
  });

  it('ignores non-playing states (pausing one does not cascade)', () => {
    const a = addPlayer('a');
    const b = addPlayer('b');

    handleMessage({
      origin: YT_ORIGIN,
      data: JSON.stringify({ event: 'onStateChange', info: 2 }), // paused
      source: a.iframe.contentWindow,
    });

    expect(b.post).not.toHaveBeenCalled();
  });

  it('does nothing when the source window cannot be identified', () => {
    const a = addPlayer('a');
    const b = addPlayer('b');

    handleMessage({
      origin: YT_ORIGIN,
      data: JSON.stringify({ event: 'onStateChange', info: 1 }),
      source: { postMessage: vi.fn() }, // not any card's contentWindow
    });

    expect(a.post).not.toHaveBeenCalled();
    expect(b.post).not.toHaveBeenCalled();
  });
});
