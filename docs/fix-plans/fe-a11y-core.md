# Fix plan: fix/fe-a11y-core

**Phase:** P2 · **Ships via:** git push (Pages) · **Files:** `css/style.css`, `index.html`, `js/views.js`, `js/feed.js`

## Findings closed
- **T7 — `outline:none` with no `:focus-visible` fallback anywhere.** `css/style.css:423/1041/1181` remove outlines; grep for `focus-visible`/`sr-only`/`prefers-reduced-motion` returns zero. The ~20 interactive controls per card and the four `role="tab"` buttons get no focus styling → keyboard users have no visible position.
- **T8 — `role="tablist"` without keyboard semantics or panel association.** `index.html:60` tabs set `aria-selected` but have no `aria-controls`, no `role="tabpanel"`, and no arrow-key/roving-tabindex handler (only Escape exists, in fullscreen). Declaring the role without the behavior is worse than plain buttons.
- **T12 — `--text-muted: #5a5a5a` on black is ~3.0:1 (below AA 4.5:1)** and is used for the search + textarea placeholders (`css/style.css:32`, call sites 431/1046) — the only visible field labels.
- **T13 — `#toast-container` is not a live region.** `index.html:123`; `showToast` errors (e.g. `views.js:437`) are never announced. The sibling `#feed-searching` already uses `role="status" aria-live="polite"`.
- **T15 — Comments toggle has no `aria-expanded` and headings skip a level.** `.media-card__comments-toggle` (`feed.js:121`) never exposes expanded state (siblings got `aria-pressed`); card titles jump `h1`→`h3` with no `h2`.

## Approach
1. Add a global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` and delete the bare `outline:none` declarations.
2. Tabs: add `aria-controls` + a `role="tabpanel"`/`aria-labelledby` container and arrow-key roving-tabindex in `views.js`; **or** downgrade to `aria-pressed` plain buttons. Pick one and apply consistently.
3. Lighten `--text-muted` to ~`#767676` (≥4.5:1 on black), or reserve it strictly for non-informational text.
4. Add `role="status" aria-live="polite" aria-atomic="true"` to `#toast-container`.
5. Add `aria-expanded`/`aria-controls` to the comments toggle (flip in `toggleComments`) and an `aria-label` (its name is currently "💬 12 comments"); add a visually-hidden `<h2>` per feed section to fix the heading jump.

## Verification
- Keyboard: Tab through cards and tabs shows a visible focus ring everywhere; arrow keys move between tabs (if tab pattern kept).
- Screen reader: toast errors announced; comments toggle announces expanded/collapsed; heading outline has no skipped level.
- Contrast checker: placeholders ≥ 4.5:1.
