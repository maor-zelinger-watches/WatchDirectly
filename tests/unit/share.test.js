/**
 * Unit tests for js/share.js — the share URL, the share action's
 * clipboard/native paths, and the share button in the card markup.
 * The deep-link open flow (?v= → fullscreen) is exercised end-to-end in
 * tests/e2e/share_link.spec.js, where a real feed and API mock exist.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// share.js pulls in cards.js → lazy-iframe.js, which constructs an
// IntersectionObserver at module load — stub it before importing (the
// same dance as revalidate_race.test.js).
class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', FakeIO);

const { shareUrlFor, shareVideo, clearShareParam } = await import('../../js/share.js');
const { createMediaCard } = await import('../../js/feed.js');

const mockVideo = {
  video_id: 'abc12345678',
  channel_name: 'Teddy Baldassarre',
  title: 'Top 10 Watches Under $500',
  url: 'https://www.youtube.com/watch?v=abc12345678',
  published_at: '2026-05-07T08:00:00Z',
  comment_count: 12,
  media_type: 'video',
};

function stubNavigator(prop, value) {
  Object.defineProperty(navigator, prop, { value, configurable: true, writable: true });
}

describe('shareUrlFor', () => {
  it('builds an origin+path URL with the id in ?v=', () => {
    expect(shareUrlFor('abc12345678'))
      .toBe(`${location.origin}${location.pathname}?v=abc12345678`);
  });

  it('percent-encodes article ids (base64 +/= survive the round trip)', () => {
    const articleId = 'aW50ZXJlc3+Rpbmc=';
    const url = shareUrlFor(articleId);
    expect(url).toContain('?v=aW50ZXJlc3%2BRpbmc%3D');
    expect(new URL(url).searchParams.get('v')).toBe(articleId);
  });
});

describe('card markup', () => {
  it('renders a share button carrying the video id', () => {
    const html = createMediaCard(mockVideo);
    expect(html).toContain('media-card__share');
    expect(html).toContain(`aria-label="Share ${mockVideo.title}"`);
  });

  it('renders the share button on article cards too', () => {
    const html = createMediaCard({ ...mockVideo, media_type: 'article', video_id: 'aW50ZXJlc3Rpbmc' });
    expect(html).toContain('media-card__share');
  });
});

describe('shareVideo', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast-container"></div>';
  });
  afterEach(() => {
    stubNavigator('share', undefined);
    stubNavigator('clipboard', undefined);
  });

  it('copies the link and toasts when there is no native share', async () => {
    stubNavigator('share', undefined);
    const writeText = vi.fn().mockResolvedValue();
    stubNavigator('clipboard', { writeText });

    await shareVideo('abc12345678', 'A title');

    expect(writeText).toHaveBeenCalledWith(shareUrlFor('abc12345678'));
    const toast = document.querySelector('#toast-container .toast');
    expect(toast.textContent).toBe('Link copied');
    expect(toast.className).toContain('toast--success');
  });

  it('prefers the native share sheet when available', async () => {
    const share = vi.fn().mockResolvedValue();
    stubNavigator('share', share);
    const writeText = vi.fn();
    stubNavigator('clipboard', { writeText });

    await shareVideo('abc12345678', 'A title');

    expect(share).toHaveBeenCalledWith({ title: 'A title', url: shareUrlFor('abc12345678') });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('stays silent when the user dismisses the native share sheet', async () => {
    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    stubNavigator('share', vi.fn().mockRejectedValue(abort));

    await shareVideo('abc12345678', 'A title');

    expect(document.querySelector('#toast-container .toast')).toBeNull();
  });

  it('toasts an error when the clipboard write is refused', async () => {
    stubNavigator('share', undefined);
    stubNavigator('clipboard', { writeText: vi.fn().mockRejectedValue(new Error('denied')) });

    await shareVideo('abc12345678', 'A title');

    const toast = document.querySelector('#toast-container .toast');
    expect(toast.textContent).toBe('Could not copy link');
    expect(toast.className).toContain('toast--error');
  });
});

describe('clearShareParam', () => {
  it('strips the query string without changing the path', () => {
    history.replaceState(null, '', `${location.pathname}?v=abc12345678`);
    expect(location.search).toBe('?v=abc12345678');

    clearShareParam();

    expect(location.search).toBe('');
  });
});
