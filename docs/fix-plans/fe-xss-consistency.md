# Fix plan: fix/fe-xss-consistency

**Phase:** P3 · **Ships via:** git push (Pages) · **Files:** `js/comments-ui.js`, `js/app.js`

Neither is currently exploitable, but both break an invariant the rest of the codebase holds — one backend change away from being a real sink.

## Findings closed
- **SEC10 — Unescaped API value interpolated into `innerHTML`.** `comments-ui.js:320` builds `` `<button … data-comment-id="${response.comment_id}">↩ Reply</button>` `` — the only place an API value reaches `innerHTML` without `sanitizeHtml`. `comments.js:99` does `sanitizeHtml(comment.comment_id)` for the identical markup. Safe today (`comment_id` is server-generated `c_<12 hex>`, CSP blocks injected `<script>`), but inconsistent.
- **SEC11 — Header avatar skips `safeUrl`.** `app.js:786` does `<img src="${sanitizeHtml(user.picture)}" …>`; `sanitizeHtml` alone doesn't validate the scheme. `comments.js:101` and `feed.js:74/197` all gate on `safeUrl`. Minimal impact (own Google profile, `javascript:` in `img src` doesn't execute), but the value is read back from `localStorage` with no re-validation.

## Approach
1. Wrap the `comment_id` interpolation in `sanitizeHtml`, matching `comments.js:99`.
2. Change `app.js:786` to `sanitizeHtml(safeUrl(user.picture))`, matching the other avatar renders.

## Verification
- `grep` confirms every `innerHTML`/`insertAdjacentHTML` interpolation of API/localStorage data now passes through `sanitizeHtml` (+ `safeUrl` for URLs).
- Sign-in still renders the avatar; comment reply button still works.
