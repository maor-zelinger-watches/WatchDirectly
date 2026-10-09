/**
 * FE10 — the search index paints incrementally as chunks merge in. A session
 * merges a dozen-plus chunks; without throttling each merge re-ran the whole
 * match-and-paint. throttleToFrame coalesces a burst of progress renders into
 * ~1 per animation frame (leading + a single trailing) so the render count is
 * bounded instead of scaling with the number of merges.
 *
 * Drives the internal throttle seam exposed via views.js __test__.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// views.js -> cards.js -> lazy-iframe.js builds an IntersectionObserver at
// module load — stub before the dynamic import.
class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('IntersectionObserver', FakeIO);

const { throttleToFrame } = (await import('../../js/views.js')).__test__;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('throttleToFrame (FE10 progress-render throttle)', () => {
  it('renders once on the leading edge and coalesces the burst into one trailing render', () => {
    const fn = vi.fn();
    const throttled = throttleToFrame(fn);

    throttled('a'); // leading edge — renders synchronously
    throttled('b'); // within the frame — coalesced
    throttled('c'); // within the frame — coalesced (latest args win)

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('a');

    vi.advanceTimersToNextFrame(); // fire the trailing render
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('c'); // trailing uses the newest args
  });

  it('bounds many merges to ~2 renders per frame regardless of merge count', () => {
    const fn = vi.fn();
    const throttled = throttleToFrame(fn);

    for (let i = 0; i < 15; i++) throttled(i); // 15 "chunk merged" notifications
    vi.advanceTimersToNextFrame();

    // 1 leading + 1 trailing, not 15 full renders.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel() drops the pending trailing render (before an authoritative final one)', () => {
    const fn = vi.fn();
    const throttled = throttleToFrame(fn);

    throttled('x'); // leading render
    throttled('y'); // pending trailing
    throttled.cancel();

    vi.advanceTimersToNextFrame();
    expect(fn).toHaveBeenCalledTimes(1); // trailing was cancelled
  });
});
