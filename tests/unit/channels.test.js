/**
 * Unit tests for the Channels tab card builders in js/feed.js
 *
 * Tests cover:
 * - createChannelCard(): avatar (with monogram fallback), name, and a favorite
 *   star that reuses the media-card star machinery
 * - avatarUrl(): down-requesting the scraped avatar to a display size
 */

import { describe, it, expect } from 'vitest';
import { createChannelCard, avatarUrl } from '../../js/feed.js';

const mockCreator = {
  channel_name: 'Nico Leonard',
  host: 'Nico Leonard',
  url: 'https://www.youtube.com/@NicoLeonard',
  channel_id: 'UCXPXfAAo-yV6Y-0PZecwBLw',
  avatar: 'https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj',
};

describe('avatarUrl', () => {
  it('down-requests the scraped size to the display size', () => {
    expect(avatarUrl(mockCreator.avatar)).toContain('=s176-');
    expect(avatarUrl(mockCreator.avatar)).not.toContain('=s900-');
  });

  it('honors an explicit size', () => {
    expect(avatarUrl(mockCreator.avatar, 88)).toContain('=s88-');
  });

  it('leaves a URL without a size segment untouched', () => {
    const plain = 'https://example.com/avatar.jpg';
    expect(avatarUrl(plain)).toBe(plain);
  });

  it('is empty-safe', () => {
    expect(avatarUrl('')).toBe('');
    expect(avatarUrl(undefined)).toBe('');
  });
});

describe('createChannelCard', () => {
  it('renders the channel name', () => {
    const html = createChannelCard(mockCreator);
    expect(html).toContain('Nico Leonard');
  });

  it('renders an avatar image at the display size', () => {
    const html = createChannelCard(mockCreator);
    expect(html).toContain('channel-card__avatar');
    expect(html).toContain('=s176-'); // down-requested, not the scraped s900
  });

  it('renders a monogram from the uppercased first initial', () => {
    const html = createChannelCard({ ...mockCreator, channel_name: 'teddy baldassarre' });
    expect(html).toContain('channel-card__monogram');
    expect(html).toMatch(/channel-card__monogram[^>]*>T</);
  });

  it('falls back to monogram-only when no avatar (no <img>)', () => {
    const { avatar, ...noAvatar } = mockCreator;
    const html = createChannelCard(noAvatar);
    expect(html).toContain('channel-card__monogram');
    expect(html).not.toContain('<img');
  });

  it('reuses the media-card star machinery, carrying the channel name', () => {
    const html = createChannelCard(mockCreator);
    // Same class + data-channel the star engine (setStarButtons, reconcile) queries.
    expect(html).toContain('media-card__star');
    expect(html).toContain('channel-card__star');
    expect(html).toContain('data-channel="Nico Leonard"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('links the name and avatar to the creator on YouTube', () => {
    const html = createChannelCard(mockCreator);
    expect(html).toContain('href="https://www.youtube.com/@NicoLeonard"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders a non-linked card when the url is unsafe or missing', () => {
    const html = createChannelCard({ ...mockCreator, url: 'javascript:alert(1)' });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    // Name still shows, just not as a link
    expect(html).toContain('Nico Leonard');
  });

  it('escapes HTML in the channel name to prevent XSS', () => {
    const html = createChannelCard({ ...mockCreator, channel_name: '<script>alert("xss")</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
