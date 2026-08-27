# Fix plan: fix/clickjacking-frame-buster

**Phase:** P3 · **Ships via:** git push (Pages) · **Files:** `js/bootstrap.js` (or an early inline script), `index.html`

## Finding closed
- **SEC6 — No clickjacking protection.** The CSP is otherwise well-built (no `unsafe-inline` in `script-src`, `base-uri 'self'`, `object-src 'none'`), but `frame-ancestors` is spec-defined to be **ignored** when delivered via `<meta http-equiv>` (index.html:16), and GitHub Pages can't set `X-Frame-Options`. There's no JS frame-buster. An attacker frames the site invisibly over decoy UI; a returning visitor is already signed in from the restored `localStorage` session (no Google interaction, so GSI's own anti-framing doesn't help), and their clicks land on `.media-card__vote`/`__star`/comment submit → forced upvotes/stars or a comment under their real name.

## Approach
1. Add a frame-buster early in `js/bootstrap.js` (loaded before `app.js`):
   `if (self !== top) { document.documentElement.style.display = 'none'; try { top.location = self.location; } catch (e) {} }`.
2. Note in a comment why the meta-CSP `frame-ancestors` can't carry this and Pages can't send the header — so a future maintainer doesn't "simplify" the buster away.
3. Optional/future: if the site later moves behind a CDN/host that can send headers, add `X-Frame-Options: DENY` / `Content-Security-Policy: frame-ancestors 'none'` and keep the JS as defense-in-depth.

## Verification
- Manual: an `<iframe src="https://www.howyouwatch.com/">` test page fails to render the app (blanks and/or breaks out).
- Confirm normal (top-level) load is unaffected.
