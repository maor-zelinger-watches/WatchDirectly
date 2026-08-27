/**
 * Unit tests for js/auth.js (Google Sign-In + session token handling).
 *
 * auth.js holds module-private state (currentUser, listeners, the in-flight
 * refresh promise), so each test re-imports it fresh via vi.resetModules() for
 * full isolation. api-client and toast are mocked (hoisted so the fresh imports
 * share the same spies); `google` and `localStorage` are installed as globals
 * per test, since auth.js reads both at call-time.
 *
 * Coverage:
 *  - FE4  — a throwing localStorage.setItem during sign-in still notifies
 *           listeners and does NOT surface "Sign-in failed".
 *  - FE8  — concurrent ensureToken / refreshToken issue a single createSession.
 *  - SEC8 — a malformed credential logs only error.name, never the token.
 *  - token decode of malformed / expired tokens (isTokenExpired).
 *  - sign-out clears state and notifies listeners with null.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../js/api-client.js', () => ({
  api: { createSession: mocks.createSession },
}));
vi.mock('../../js/toast.js', () => ({
  showToast: mocks.showToast,
}));

// --- helpers ---------------------------------------------------------

function toB64Url(str) {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A Google-JWT-shaped token: header.payload.sig, payload = base64url(JSON). */
function makeJwt(payloadObj) {
  return `${toB64Url('{"alg":"none"}')}.${toB64Url(JSON.stringify(payloadObj))}.sig`;
}

/** An app session token: wds1.<base64url(payload)>.sig */
function makeSessionToken(payloadObj) {
  return `wds1.${toB64Url(JSON.stringify(payloadObj))}.sig`;
}

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;
const pastExp = () => Math.floor(Date.now() / 1000) - 3600;

const IDENTITY = { name: 'Ada', email: 'ada@example.com', picture: 'p.png' };

function installStorage({ throwOnSet = false, throwOnRemove = false } = {}) {
  const store = {};
  const ls = {
    getItem: vi.fn((k) => (k in store ? store[k] : null)),
    setItem: vi.fn((k, v) => {
      if (throwOnSet) throw new Error('QuotaExceededError');
      store[k] = String(v);
    }),
    removeItem: vi.fn((k) => {
      if (throwOnRemove) throw new Error('remove blocked');
      delete store[k];
    }),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    writable: true,
    configurable: true,
  });
  return ls;
}

function installGoogle() {
  const captured = {};
  globalThis.google = {
    accounts: {
      id: {
        // Records the latest callback so a test can drive credential responses.
        initialize: vi.fn((opts) => { captured.callback = opts.callback; }),
        prompt: vi.fn(),
        renderButton: vi.fn(),
        disableAutoSelect: vi.fn(),
      },
    },
  };
  return captured;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function loadAuth() {
  vi.resetModules();
  return import('../../js/auth.js');
}

/** Runs initAuth + drives one credential response through the GIS callback. */
async function signIn(auth, captured, { sessionToken, credentialPayload = IDENTITY } = {}) {
  if (sessionToken) mocks.createSession.mockResolvedValueOnce({ sessionToken });
  else mocks.createSession.mockResolvedValueOnce(undefined);
  auth.initAuth('client-123');
  await captured.callback({ credential: makeJwt(credentialPayload) });
}

let captured;

beforeEach(() => {
  mocks.createSession.mockReset();
  mocks.showToast.mockReset();
  installStorage();
  captured = installGoogle();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- FE4 -------------------------------------------------------------

describe('FE4 — guarded persistence during sign-in', () => {
  it('a throwing localStorage.setItem still signs the user in and notifies listeners', async () => {
    installStorage({ throwOnSet: true }); // Safari private mode / quota full
    const auth = await loadAuth();

    const seen = [];
    auth.onAuthChange((u) => seen.push(u));

    await signIn(auth, captured, { sessionToken: makeSessionToken({ exp: futureExp() }) });

    // The user IS signed in even though persistence threw...
    expect(auth.isSignedIn()).toBe(true);
    expect(auth.getCurrentUser()).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
    // ...listeners fired with the user...
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ email: 'ada@example.com' });
    // ...and NO "Sign-in failed" toast was shown.
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('with working storage, sign-in persists wd_user and notifies listeners', async () => {
    const ls = installStorage();
    const auth = await loadAuth();

    const seen = [];
    auth.onAuthChange((u) => seen.push(u));

    await signIn(auth, captured, { sessionToken: makeSessionToken({ exp: futureExp() }) });

    expect(auth.isSignedIn()).toBe(true);
    expect(ls.setItem).toHaveBeenCalledWith('wd_user', expect.any(String));
    expect(seen).toHaveLength(1);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});

// --- FE8 -------------------------------------------------------------

describe('FE8 — refresh in-flight dedupe', () => {
  it('concurrent ensureToken calls issue a single createSession', async () => {
    const auth = await loadAuth();
    // Sign in with an ALREADY-expired session token so ensureToken must refresh.
    await signIn(auth, captured, { sessionToken: makeSessionToken({ exp: pastExp() }) });
    expect(auth.isTokenExpired()).toBe(true);

    // Reset the mock and hand back a controllable pending refresh.
    mocks.createSession.mockReset();
    const dfd = deferred();
    mocks.createSession.mockReturnValue(dfd.promise);

    const p1 = auth.ensureToken();
    const p2 = auth.ensureToken();

    // Both callers share ONE in-flight refresh — createSession fired once.
    expect(mocks.createSession).toHaveBeenCalledTimes(1);

    const fresh = makeSessionToken({ exp: futureExp() });
    dfd.resolve({ sessionToken: fresh });

    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe(fresh);
    expect(t2).toBe(fresh);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(auth.isTokenExpired()).toBe(false);
  });

  it('concurrent refreshToken calls resolve from one createSession, and a later refresh re-issues', async () => {
    const auth = await loadAuth();
    await signIn(auth, captured, { sessionToken: makeSessionToken({ exp: pastExp() }) });

    mocks.createSession.mockReset();
    const dfd = deferred();
    mocks.createSession.mockReturnValue(dfd.promise);

    const p1 = auth.refreshToken();
    const p2 = auth.refreshToken();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);

    const fresh = makeSessionToken({ exp: futureExp() });
    dfd.resolve({ sessionToken: fresh });
    await Promise.all([p1, p2]);

    // The memoized promise cleared on settle — a later refresh issues anew.
    const dfd2 = deferred();
    mocks.createSession.mockReturnValue(dfd2.promise);
    const p3 = auth.refreshToken();
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    dfd2.resolve({ sessionToken: makeSessionToken({ exp: futureExp() }) });
    await p3;
  });
});

// --- SEC8 ------------------------------------------------------------

describe('SEC8 — credential decode failure logs only the error name', () => {
  it('a malformed credential logs error.name (never the token) and toasts a generic failure', async () => {
    const auth = await loadAuth();
    auth.initAuth('client-123');

    // Payload base64url-decodes to truncated JSON -> JSON.parse SyntaxError,
    // whose message would embed cleartext identity fragments if logged whole.
    const badPayload = toB64Url('{"email":"ada@example.com"'); // no closing brace
    await captured.callback({ credential: `hdr.${badPayload}.sig` });

    expect(auth.isSignedIn()).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith('Sign-in failed. Please try again.', 'error');

    // Only the error name shipped — a string, not the Error, and free of the token.
    expect(console.error).toHaveBeenCalledTimes(1);
    const args = console.error.mock.calls[0];
    expect(args[0]).toBe('Failed to decode credential:');
    expect(args[1]).toBe('SyntaxError');
    expect(args.some((a) => a instanceof Error)).toBe(false);
    expect(JSON.stringify(args)).not.toContain('ada@example.com');
  });
});

// --- token decode / expiry -------------------------------------------

describe('token decode and expiry', () => {
  it('reports a future-dated session token as not expired', async () => {
    const auth = await loadAuth();
    await signIn(auth, captured, { sessionToken: makeSessionToken({ exp: futureExp() }) });
    expect(auth.isTokenExpired()).toBe(false);
  });

  it('reports a past-dated session token as expired', async () => {
    const auth = await loadAuth();
    await signIn(auth, captured, { sessionToken: makeSessionToken({ exp: pastExp() }) });
    expect(auth.isTokenExpired()).toBe(true);
  });

  it('treats a token with no decodable expiry (Google-token fallback) as expired', async () => {
    const auth = await loadAuth();
    // createSession returns nothing -> currentUser.token stays the raw Google JWT,
    // whose payload here carries no exp claim.
    await signIn(auth, captured, { credentialPayload: IDENTITY });
    expect(auth.isSignedIn()).toBe(true);
    expect(auth.isTokenExpired()).toBe(true);
  });
});

// --- sign-out --------------------------------------------------------

describe('sign-out', () => {
  it('clears state, removes wd_user, and notifies listeners with null', async () => {
    const ls = installStorage();
    const auth = await loadAuth();
    await signIn(auth, captured, { sessionToken: makeSessionToken({ exp: futureExp() }) });
    expect(auth.isSignedIn()).toBe(true);

    const seen = [];
    auth.onAuthChange((u) => seen.push(u));
    auth.signOut();

    expect(auth.isSignedIn()).toBe(false);
    expect(auth.getCurrentUser()).toBeNull();
    expect(seen).toEqual([null]);
    expect(ls.removeItem).toHaveBeenCalledWith('wd_user');
    expect(globalThis.google.accounts.id.disableAutoSelect).toHaveBeenCalled();
  });

  it('sign-out with a throwing localStorage.removeItem still clears state', async () => {
    installStorage({ throwOnRemove: true });
    const auth = await loadAuth();
    await signIn(auth, captured, { sessionToken: makeSessionToken({ exp: futureExp() }) });

    const seen = [];
    auth.onAuthChange((u) => seen.push(u));
    auth.signOut(); // must not throw

    expect(auth.isSignedIn()).toBe(false);
    expect(seen).toEqual([null]);
  });
});
