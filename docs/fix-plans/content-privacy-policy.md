# Fix plan: fix/content-privacy-policy

**Phase:** P3 · **Ships via:** git push (Pages) · **Files:** `privacy.html`

⚠️ **Wording is user-owned — flag for legal review before publishing.** This branch drafts accurate text; final language is the user's call.

## Finding closed
- **SEC7 — The privacy policy contradicts what the code stores and transmits.**
  - `privacy.html:55` says the Google authentication token is *"not stored persistently"* — but `auth.js:183` writes `wd_user` (name, email, picture URL, **30-day bearer token**) to `localStorage` and `auth.js:273` refreshes it indefinitely.
  - `privacy.html:63` (§2.4) says localStorage is used *"to cache the video feed"* and *"is not transmitted to us"* — both wrong: it also holds the identity blob, and the token is sent on every write request.
  - The error reporter ships `location.href`, full `navigator.userAgent`, a session id, and arbitrary error text to the backend spreadsheet on every page, disclosed **nowhere** — while §3 claims no analytics/profiling.

## Approach
1. Amend §2.2/§2.4 to describe the persistent stored identity + session token and its 30-day (→ ~90-day absolute after `fix/be-session-revocation`) lifetime, and that the token is transmitted on authenticated requests.
2. Add a §2.5 covering error telemetry: URL, user agent, error/`console.error` text, per-page session id, and its retention.
3. Reconcile §3's "no analytics" claim with the telemetry disclosure (telemetry is operational, not advertising/profiling — state that precisely).

## Verification
- Read-through: every claim in `privacy.html` matches an actual code behavior (cross-check `auth.js`, `error-reporter.js`, `cache.js`).
- Hand to the user/legal for sign-off before it ships. Relevant to the Google OAuth verification review.
