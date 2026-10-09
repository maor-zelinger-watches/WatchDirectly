/**
 * Unit tests for the Channels tab card builders in js/feed.js
 *
 * Tests cover:
 * - createChannelCard(): avatar (with monogram fallback), name, and a favorite
 *   star that reuses the media-card star machinery
 * - avatarUrl(): down-requesting the scraped avatar to a display size
 */

import { describe, it, expect } from 'vitest';
import { createChannelCard, avatarUrl, channelPlatform } from '../../js/feed.js';

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

  it('marks a YouTube channel: data-platform + play-lozenge corner mark', () => {
    const html = createChannelCard(mockCreator);
    expect(html).toContain('data-platform="youtube"');
    expect(html).toContain('channel-card__platform--youtube');
    expect(html).toContain('title="YouTube channel"');
    expect(html).toContain('<svg'); // inline play lozenge, no external asset
    expect(html).toContain('aria-label="Nico Leonard on YouTube"');
  });

  it('marks an article site: data-platform + flat newspaper corner mark', () => {
    const html = createChannelCard({
      channel_name: 'Hodinkee', host: 'hodinkee.com', url: 'https://www.hodinkee.com',
      avatar: 'https://www.google.com/s2/favicons?domain=hodinkee.com&sz=128',
    });
    expect(html).toContain('data-platform="article"');
    expect(html).toContain('channel-card__platform--article');
    expect(html).toContain('title="Article site"');
    expect(html).toContain('icon--article'); // flat inline SVG, not the 📰 emoji
    expect(html).toContain('aria-label="Hodinkee website"');
  });

  it('defaults a channel with no links to the article mark — nothing ships unmarked', () => {
    const html = createChannelCard({ channel_name: 'Mystery' });
    expect(html).toContain('data-platform="article"');
    expect(html).toContain('channel-card__platform--article');
  });
});

describe('channelPlatform', () => {
  it('prefers the backend-computed platform field over the heuristic', () => {
    // The backend can also see feed_url, so its verdict wins even when the
    // public fields alone would say otherwise.
    expect(channelPlatform({ platform: 'article', url: 'https://www.youtube.com/@x' })).toBe('article');
    expect(channelPlatform({ platform: 'youtube' })).toBe('youtube');
    // Junk values fall through to the heuristic
    expect(channelPlatform({ platform: 'weird', url: 'https://www.hodinkee.com' })).toBe('article');
  });

  it('classifies YouTube URLs in every flavor', () => {
    expect(channelPlatform({ url: 'https://www.youtube.com/@NicoLeonard' })).toBe('youtube');
    expect(channelPlatform({ url: 'https://youtube.com/channel/UCabc' })).toBe('youtube');
    expect(channelPlatform({ url: 'https://m.youtube.com/@handle' })).toBe('youtube');
    expect(channelPlatform({ url: 'https://youtu.be/xyz' })).toBe('youtube');
  });

  it('classifies non-YouTube URLs as article sites', () => {
    expect(channelPlatform({ url: 'https://www.hodinkee.com' })).toBe('article');
    expect(channelPlatform({ url: 'https://fratellowatches.com/feed' })).toBe('article');
    // A hostile lookalike host must not pass as YouTube
    expect(channelPlatform({ url: 'https://notyoutube.com' })).toBe('article');
    expect(channelPlatform({ url: 'https://youtube.com.evil.example' })).toBe('article');
  });

  it('falls back to the avatar origin when the URL is missing', () => {
    expect(channelPlatform({ avatar: 'https://yt3.googleusercontent.com/abc=s900' })).toBe('youtube');
    expect(channelPlatform({ avatar: 'https://www.google.com/s2/favicons?domain=x.com' })).toBe('article');
  });

  it('defaults to article when there is nothing to classify (no YouTube link = article)', () => {
    expect(channelPlatform({})).toBe('article');
    expect(channelPlatform(undefined)).toBe('article');
  });
});
