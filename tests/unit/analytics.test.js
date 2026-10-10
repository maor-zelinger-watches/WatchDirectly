/**
 * analytics.js — opt-in GA4 behind the cookie banner.
 *
 * The script is a classic IIFE (not a module), so each test re-evaluates its
 * source against a clean DOM + localStorage, the way a fresh page load would.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../js/analytics.js'), 'utf8');
const KEY = 'wd_analytics_consent';

// jsdom's localStorage isn't usable under this vitest setup; same in-memory
// mock pattern as flags.test.js.
let lsStore = {};
const localStorageMock = {
  getItem: vi.fn((k) => (k in lsStore ? lsStore[k] : null)),
  setItem: vi.fn((k, v) => { lsStore[k] = String(v); }),
  removeItem: vi.fn((k) => { delete lsStore[k]; }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

function load() {
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
}

const gtagScript = () => document.head.querySelector('script[src*="googletagmanager.com/gtag/js"]');
const banner = () => document.querySelector('.cookie-banner');
const consentCalls = () => window.dataLayer.filter(a => a[0] === 'consent').map(a => [a[1], a[2]]);

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '<a href="/privacy.html#cookies" data-cookie-settings>Cookies</a>';
  lsStore = {};
  delete window.dataLayer;
  delete window.gtag;
});

describe('analytics consent', () => {
  it('first visit: shows the banner, loads nothing from Google, defaults everything to denied', () => {
    load();
    expect(banner()).not.toBeNull();
    expect(banner().hidden).toBe(false);
    expect(gtagScript()).toBeNull();
    expect(consentCalls()).toEqual([['default', {
      analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
    }]]);
    expect(window.dataLayer.some(a => a[0] === 'config')).toBe(false);
  });

  it('Accept: remembers the choice, grants analytics_storage, injects gtag.js and configures GA', () => {
    load();
    banner().querySelector('[data-consent="granted"]').click();
    expect(localStorage.getItem(KEY)).toBe('granted');
    expect(banner().hidden).toBe(true);
    expect(gtagScript()).not.toBeNull();
    expect(gtagScript().async).toBe(true);
    expect(consentCalls()).toContainEqual(['update', { analytics_storage: 'granted' }]);
    expect(window.dataLayer.find(a => a[0] === 'config')[1]).toBe('G-M9PXYBQ5X7');
  });

  it('Reject: remembers the choice and never loads GA', () => {
    load();
    banner().querySelector('[data-consent="denied"]').click();
    expect(localStorage.getItem(KEY)).toBe('denied');
    expect(banner().hidden).toBe(true);
    expect(gtagScript()).toBeNull();
  });

  it('returning visitor who accepted: loads GA without showing the banner', () => {
    localStorage.setItem(KEY, 'granted');
    load();
    expect(banner()).toBeNull();
    expect(gtagScript()).not.toBeNull();
  });

  it('returning visitor who rejected: no banner, no GA', () => {
    localStorage.setItem(KEY, 'denied');
    load();
    expect(banner()).toBeNull();
    expect(gtagScript()).toBeNull();
  });

  it('the Cookies link reopens the banner, and withdrawing consent deletes _ga cookies', () => {
    localStorage.setItem(KEY, 'granted');
    document.cookie = '_ga=GA1.1.123; path=/';
    document.cookie = '_ga_LNXRS74XZ3=GS1.1.456; path=/';
    document.cookie = 'unrelated=keep; path=/';
    load();

    document.querySelector('[data-cookie-settings]').click();
    expect(banner().hidden).toBe(false);

    banner().querySelector('[data-consent="denied"]').click();
    expect(localStorage.getItem(KEY)).toBe('denied');
    expect(consentCalls()).toContainEqual(['update', { analytics_storage: 'denied' }]);
    expect(document.cookie).not.toMatch(/_ga/);
    expect(document.cookie).toMatch(/unrelated=keep/);
    document.cookie = 'unrelated=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('Accept twice (via reopen) injects gtag.js only once', () => {
    load();
    banner().querySelector('[data-consent="granted"]').click();
    document.querySelector('[data-cookie-settings]').click();
    banner().querySelector('[data-consent="granted"]').click();
    expect(document.head.querySelectorAll('script[src*="gtag/js"]').length).toBe(1);
  });

  it('blocked localStorage: treats the visitor as undecided instead of throwing', () => {
    localStorageMock.getItem.mockImplementationOnce(() => { throw new Error('blocked'); });
    expect(() => load()).not.toThrow();
    expect(banner().hidden).toBe(false);
    expect(gtagScript()).toBeNull();
  });
});
