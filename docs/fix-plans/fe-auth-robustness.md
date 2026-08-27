# Fix plan: fix/fe-auth-robustness

**Phase:** P1 · **Ships via:** git push (Pages) · **Files:** `js/auth.js`, `js/app.js`, `js/error-reporter.js`

## Findings closed
- **FE4 — Unguarded `localStorage.setItem` makes a successful sign-in report failure.** `auth.js` bypasses `cache.js`'s try/catch. In `handleCredentialResponse`, `currentUser` is set (L180) then `localStorage.setItem('wd_user', ...)` (L183); if that throws (Safari private mode, quota full from the search index) the outer `catch` (L186) fires "Sign-in failed" **while the user is actually signed in** — `notifyListeners()` never runs, so the UI stays on the sign-in button. Also L200 (`signOut`) and L273 (`updateSessionToken`).
- **FE8 — `refreshToken` has no in-flight dedupe; `interactiveRefresh` hijacks the GIS callback.** Concurrent mutations each issue their own `createSession` (`auth.js:284`); last-write-wins orphans freshly minted tokens. `interactiveRefresh` (L311) calls `google.accounts.id.initialize({callback})` with a one-shot closure and never restores `handleCredentialResponse`, leaving the global GIS callback a stale closure.
- **FE15 — GIS detected by a 50×200ms poll that gives up silently.** `app.js:61` polls for `google.accounts`; after 10s it stops with no toast/fallback, `#auth-container` empty forever.
- **SEC8 — Error reporter can exfiltrate ID-token fragments.** `auth.js:187` does `console.error('Failed to decode credential:', error)`; the `console.error` hook ships every arg to the sheet, and a `JSON.parse` `SyntaxError.message` embeds a slice of the malformed token (base64 fragments of email/name/`sub`). Breaks the reporter's stated "no token ever leaves the page" invariant.

## Approach
1. Route all `wd_user` reads/writes through guarded primitives (reuse `cache.js`'s `read`/`write`, or a local try/catch); call `notifyListeners()` regardless of whether persistence succeeded.
2. Memoize a single in-flight refresh promise in `refreshToken` (clear on settle). After `interactiveRefresh` resolves, re-`initialize` GIS with `handleCredentialResponse`.
3. Replace the poll with `window.onGoogleLibraryLoad` (or the script tag's `load` event); surface a toast if GIS truly fails to load.
4. `auth.js:187`: log only `error.name` (never the error object). Optionally scrub JWT-shaped substrings in the `console.error` hook.

## Verification
- New `tests/unit/auth.test.js` (shared with `fix/test-url-and-hygiene`): sign-in with a throwing `localStorage` still notifies listeners; concurrent `ensureToken` calls issue one `createSession`.
- Manual: private-browsing sign-in shows signed-in UI; rapid multi-vote after expiry mints one token.
