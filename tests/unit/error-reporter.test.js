/**
 * Unit tests for js/error-reporter.js (frontend error telemetry).
 *
 * The reporter is a side-effect module: importing it installs the window
 * handlers and wraps console.error, so the module is imported ONCE with
 * fetch/sendBeacon/timers mocked first, and the tests run sequentially
 * against that shared instance — exactly how it lives in the page. Each
 * test uses distinct error messages so the per-key dedupe never couples
 * one test to another.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { CONFIG } from '../../js/config.js';

const fetchMock = vi.fn().mockResolvedValue({ ok: true });
const beaconMock = vi.fn().mockReturnValue(true);
const consoleErrorSpy = vi.fn();

/** Parses the JSON body of the nth fetch call. */
const fetchBody = (n = 0) => JSON.parse(fetchMock.mock.calls[n][1].body);

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  navigator.sendBeacon = beaconMock;
  // Replaced BEFORE import so the reporter wraps THIS as "the original" —
  // lets us assert the wrap still forwards to it.
  console.error = consoleErrorSpy;
  await import('../../js/error-reporter.js');
});

beforeEach(() => {
  fetchMock.mockClear();
  beaconMock.mockClear();
  consoleErrorSpy.mockClear();
});

function dispatchError(message, { filename = 'app.js', lineno = 1, colno = 2, error } = {}) {
  window.dispatchEvent(new ErrorEvent('error', {
    message,
    filename,
    lineno,
    colno,
    error: error ?? new Error(message),
  }));
}

describe('error reporter', () => {
  it('ships an uncaught error as a clientError batch after the flush delay', () => {
    dispatchError('t1 uncaught boom');
    expect(fetchMock).not.toHaveBeenCalled(); // batched, not immediate

    vi.advanceTimersByTime(3000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(CONFIG.APPS_SCRIPT_URL);
    expect(opts.method).toBe('POST');
    expect(opts.keepalive).toBe(true);

    const body = fetchBody();
    expect(body.action).toBe('clientError');
    expect(body.appVersion).toBe(CONFIG.APP_VERSION);
    expect(body.sessionId).toMatch(/^s_/);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].message).toBe('t1 uncaught boom');
    expect(body.errors[0].source).toBe('app.js:1:2');
    expect(body.errors[0].stack).toContain('t1 uncaught boom');
  });

  it('dedupes: the same error ships at most 3 times per page load', () => {
    for (let i = 0; i < 6; i++) dispatchError('t2 repeated boom');
    vi.advanceTimersByTime(3000);

    const shipped = fetchMock.mock.calls.flatMap((_, n) => fetchBody(n).errors);
    expect(shipped.filter((e) => e.message === 't2 repeated boom')).toHaveLength(3);
  });

  it('captures unhandled promise rejections', () => {
    const event = new Event('unhandledrejection');
    event.reason = new Error('t3 rejected boom');
    window.dispatchEvent(event);
    vi.advanceTimersByTime(3000);

    const body = fetchBody();
    expect(body.errors[0].message).toBe('t3 rejected boom');
    expect(body.errors[0].source).toBe('unhandledrejection');
  });

  it('captures console.error and still forwards to the real console', () => {
    const err = new Error('t4 handled boom');
    console.error('Failed to post comment:', err);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to post comment:', err);

    vi.advanceTimersByTime(3000);
    const body = fetchBody();
    expect(body.errors[0].message).toBe('Failed to post comment: t4 handled boom');
    expect(body.errors[0].source).toBe('console.error');
    expect(body.errors[0].stack).toContain('t4 handled boom');
  });

  it('flushes synchronously via sendBeacon on pagehide', () => {
    dispatchError('t5 pagehide boom');
    window.dispatchEvent(new Event('pagehide'));

    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(beaconMock.mock.calls[0][0]).toBe(CONFIG.APPS_SCRIPT_URL);
    expect(fetchMock).not.toHaveBeenCalled();
    // Nothing left queued — the timer must not re-send the same batch.
    vi.advanceTimersByTime(3000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores resource-load failures (no message, non-window target)', () => {
    const img = document.createElement('img');
    document.body.appendChild(img);
    const event = new Event('error', { bubbles: false });
    Object.defineProperty(event, 'target', { value: img });
    window.dispatchEvent(event);

    vi.advanceTimersByTime(3000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops known third-party noise (GSI / FedCM) without spending budget', () => {
    console.error('[GSI_LOGGER]: FedCM get() rejects with NetworkError: Error retrieving a token.');
    console.error('Not signed in with the identity provider.');
    vi.advanceTimersByTime(3000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2); // still reaches devtools
  });

  it('redacts JWT / session-token shapes from console.error before shipping (SEC8)', () => {
    const jwt = `aaa.${'b'.repeat(40)}.${'c'.repeat(40)}`;
    console.error('t8 leaked token:', jwt);
    vi.advanceTimersByTime(3000);

    const body = fetchBody();
    expect(body.errors[0].message).toContain('[redacted-token]');
    expect(body.errors[0].message).not.toContain(jwt);
    // Devtools still sees the original, unredacted args.
    expect(consoleErrorSpy).toHaveBeenCalledWith('t8 leaked token:', jwt);
  });

  it('swallows report-delivery failures instead of erroring', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    dispatchError('t7 delivery boom');
    vi.advanceTimersByTime(3000);
    await vi.runAllTicks();

    // The rejected fetch was attempted once and swallowed — no retry, no
    // recursive capture of the reporter's own failure.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
