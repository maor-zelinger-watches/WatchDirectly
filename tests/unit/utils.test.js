/**
 * Unit tests for js/utils.js
 * 
 * Tests cover:
 * - timeAgo(): relative time formatting with edge cases
 * - sanitizeHtml(): XSS prevention for user-generated content
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { timeAgo, sanitizeHtml } from '../../js/utils.js';

describe('timeAgo', () => {
  let now;

  beforeEach(() => {
    now = new Date('2026-05-07T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for times less than 60 seconds ago', () => {
    const date = new Date('2026-05-07T11:59:30Z').toISOString();
    expect(timeAgo(date)).toBe('just now');
  });

  it('returns "1m" for exactly 1 minute ago', () => {
    const date = new Date('2026-05-07T11:59:00Z').toISOString();
    expect(timeAgo(date)).toBe('1m');
  });

  it('returns "45m" for 45 minutes ago', () => {
    const date = new Date('2026-05-07T11:15:00Z').toISOString();
    expect(timeAgo(date)).toBe('45m');
  });

  it('returns "1h" for exactly 1 hour ago', () => {
    const date = new Date('2026-05-07T11:00:00Z').toISOString();
    expect(timeAgo(date)).toBe('1h');
  });

  it('returns "5h" for 5 hours ago', () => {
    const date = new Date('2026-05-07T07:00:00Z').toISOString();
    expect(timeAgo(date)).toBe('5h');
  });

  it('returns "1d" for exactly 1 day ago', () => {
    const date = new Date('2026-05-06T12:00:00Z').toISOString();
    expect(timeAgo(date)).toBe('1d');
  });

  it('returns "3d" for 3 days ago', () => {
    const date = new Date('2026-05-04T12:00:00Z').toISOString();
    expect(timeAgo(date)).toBe('3d');
  });

  it('returns "1w" for 7 days ago', () => {
    const date = new Date('2026-04-30T12:00:00Z').toISOString();
    expect(timeAgo(date)).toBe('1w');
  });

  it('returns "2w" for 14 days ago', () => {
    const date = new Date('2026-04-23T12:00:00Z').toISOString();
    expect(timeAgo(date)).toBe('2w');
  });

  it('returns "1mo" for 30+ days ago', () => {
    const date = new Date('2026-04-07T12:00:00Z').toISOString();
    expect(timeAgo(date)).toBe('1mo');
  });

  it('returns "3mo" for 90+ days ago', () => {
    const date = new Date('2026-02-06T12:00:00Z').toISOString();
    expect(timeAgo(date)).toBe('3mo');
  });

  it('returns "1y" for 365+ days ago', () => {
    const date = new Date('2025-05-07T12:00:00Z').toISOString();
    expect(timeAgo(date)).toBe('1y');
  });

  it('handles Date objects in addition to strings', () => {
    const date = new Date('2026-05-07T11:00:00Z');
    expect(timeAgo(date)).toBe('1h');
  });

  it('handles timestamps in milliseconds', () => {
    const timestamp = new Date('2026-05-07T11:00:00Z').getTime();
    expect(timeAgo(timestamp)).toBe('1h');
  });
});

describe('sanitizeHtml', () => {
  it('returns plain text unchanged', () => {
    expect(sanitizeHtml('Hello world')).toBe('Hello world');
  });

  it('escapes HTML angle brackets', () => {
    expect(sanitizeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersands', () => {
    expect(sanitizeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('escapes single quotes', () => {
    expect(sanitizeHtml("it's")).toBe('it&#039;s');
  });

  it('escapes double quotes', () => {
    expect(sanitizeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('handles nested HTML injection', () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const result = sanitizeHtml(malicious);
    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;img');
    // The word "onerror" still exists as escaped text, which is safe
    // because the browser won't interpret it as an HTML attribute
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
  });

  it('preserves newlines', () => {
    expect(sanitizeHtml('line1\nline2')).toBe('line1\nline2');
  });

  it('handles empty string', () => {
    expect(sanitizeHtml('')).toBe('');
  });

  it('handles null/undefined gracefully', () => {
    expect(sanitizeHtml(null)).toBe('');
    expect(sanitizeHtml(undefined)).toBe('');
  });
});
