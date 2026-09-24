/**
 * Unit tests for js/flags.js — the per-browser storage-engine flag.
 *
 * The flag decides whether the large cache snapshots live in localStorage
 * ('legacy', the default) or IndexedDB ('idb'). What must hold: an absent,
 * junk, or unreadable flag always lands on the default; the answer is fixed
 * for the whole page load; ?storage= sets it on browsers without devtools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CONFIG } from '../../js/config.js';
import {
  FLAG_KEYS, storageEngine, setStorageEngineFlag, __test__ as flagsTest,
} from '../../js/flags.js';

let lsStore = {};
const localStorageMock = {
  getItem: vi.fn((k) => (k in lsStore ? lsStore[k] : null)),
  setItem: vi.fn((k, v) => { lsStore[k] = String(v); }),
  removeItem: vi.fn((k) => { delete lsStore[k]; }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

const KEY = FLAG_KEYS.STORAGE_ENGINE;
const originalDefault = CONFIG.STORAGE_ENGINE_DEFAULT;

beforeEach(() => {
  lsStore = {};
  localStorageMock.getItem.mockImplementation((k) => (k in lsStore ? lsStore[k] : null));
  localStorageMock.setItem.mockImplementation((k, v) => { lsStore[k] = String(v); });
  localStorageMock.removeItem.mockImplementation((k) => { delete lsStore[k]; });
  for (const fn of Object.values(localStorageMock)) fn.mockClear();
  flagsTest.reset();
  history.replaceState(null, '', '/');
});

afterEach(() => {
  CONFIG.STORAGE_ENGINE_DEFAULT = originalDefault;
  history.replaceState(null, '', '/');
});

describe('storage engine flag', () => {
  it('ships defaulting to legacy (localStorage)', () => {
    expect(CONFIG.STORAGE_ENGINE_DEFAULT).toBe('legacy');
    expect(storageEngine()).toEqual({ engine: 'legacy', source: 'default' });
  });

  it('honors an explicit idb or legacy flag', () => {
    lsStore[KEY] = 'idb';
    expect(storageEngine()).toEqual({ engine: 'idb', source: 'flag' });
    flagsTest.reset();
    lsStore[KEY] = 'legacy';
    expect(storageEngine()).toEqual({ engine: 'legacy', source: 'flag' });
  });

  it.each(['', 'IDB', 'indexeddb', 'true', '1', ' idb', 'null'])('treats %j as no flag', (junk) => {
    lsStore[KEY] = junk;
    expect(storageEngine()).toEqual({ engine: 'legacy', source: 'default' });
  });

  it('falls back to the default when localStorage throws on read', () => {
    localStorageMock.getItem.mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(storageEngine()).toEqual({ engine: 'legacy', source: 'default' });
  });

  it('follows a flipped default for browsers without a flag, but not for ones with one', () => {
    CONFIG.STORAGE_ENGINE_DEFAULT = 'idb';
    expect(storageEngine()).toEqual({ engine: 'idb', source: 'default' });
    flagsTest.reset();
    lsStore[KEY] = 'legacy';
    expect(storageEngine()).toEqual({ engine: 'legacy', source: 'flag' });
  });

  it('a nonsense default can never select an engine that does not exist', () => {
    CONFIG.STORAGE_ENGINE_DEFAULT = 'cache';
    expect(storageEngine().engine).toBe('legacy');
  });

  it('is fixed for the page load: a mid-session flip waits for the next load', () => {
    lsStore[KEY] = 'idb';
    expect(storageEngine().engine).toBe('idb');
    lsStore[KEY] = 'legacy';                    // another tab, or devtools
    expect(storageEngine().engine).toBe('idb'); // this load is unaffected
    flagsTest.reset();                          // …the next load
    expect(storageEngine().engine).toBe('legacy');
  });

  it('returns a frozen answer nobody can mutate into a different engine', () => {
    const answer = storageEngine();
    expect(Object.isFrozen(answer)).toBe(true);
  });
});

describe('setStorageEngineFlag', () => {
  it('writes idb and legacy, removes on null', () => {
    expect(setStorageEngineFlag('idb')).toBe(true);
    expect(lsStore[KEY]).toBe('idb');
    expect(setStorageEngineFlag('legacy')).toBe(true);
    expect(lsStore[KEY]).toBe('legacy');
    expect(setStorageEngineFlag(null)).toBe(true);
    expect(KEY in lsStore).toBe(false);
  });

  it('refuses anything else and leaves the flag alone', () => {
    lsStore[KEY] = 'idb';
    expect(setStorageEngineFlag('cache')).toBe(false);
    expect(setStorageEngineFlag('')).toBe(false);
    expect(lsStore[KEY]).toBe('idb');
  });

  it('reports false instead of throwing when localStorage is blocked', () => {
    localStorageMock.setItem.mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    expect(() => setStorageEngineFlag('idb')).not.toThrow();
    expect(setStorageEngineFlag('idb')).toBe(false);
  });
});

describe('?storage= URL parameter', () => {
  it('?storage=idb and ?storage=legacy persist the flag', () => {
    history.replaceState(null, '', '/?storage=idb');
    flagsTest.applyUrlParam();
    expect(lsStore[KEY]).toBe('idb');
    history.replaceState(null, '', '/?storage=legacy');
    flagsTest.applyUrlParam();
    expect(lsStore[KEY]).toBe('legacy');
  });

  it('?storage=default removes it', () => {
    lsStore[KEY] = 'idb';
    history.replaceState(null, '', '/?storage=default');
    flagsTest.applyUrlParam();
    expect(KEY in lsStore).toBe(false);
  });

  it('ignores unknown values', () => {
    lsStore[KEY] = 'idb';
    history.replaceState(null, '', '/?storage=cache');
    flagsTest.applyUrlParam();
    expect(lsStore[KEY]).toBe('idb');
  });

  it('coexists with a shared deep link (?v=…&storage=…)', () => {
    history.replaceState(null, '', '/?v=abc12345678&storage=idb');
    flagsTest.applyUrlParam();
    expect(lsStore[KEY]).toBe('idb');
    expect(new URLSearchParams(location.search).get('v')).toBe('abc12345678'); // untouched
  });

  it('does nothing without a query string', () => {
    flagsTest.applyUrlParam();
    expect(localStorageMock.setItem).not.toHaveBeenCalledWith(KEY, expect.anything());
  });
});
