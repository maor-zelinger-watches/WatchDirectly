# Fix plan: fix/fe-fullscreen

**Phase:** P2 · **Ships via:** git push (Pages) · **Files:** `js/views.js`, `js/fullscreen.js`, `css/style.css`

## Findings closed
- **FE9 — Switching tabs from fullscreen scrolls to the old position, not the top.** `switchView` does `window.scrollTo({top: 0})` (`views.js:387`), then `update()` calls `exitFullscreen()` whose tail does `window.scrollTo({top: returnScrollY})` + an anchor `scrollBy`. Expanding a card 15 screens down then tapping "Top This Week" undoes the scroll-to-top and lands the user mid-list on a view they just opened; `exitFullscreen` also strips `?v=` as a side effect.
- **T3 — The fullscreen overlay is a modal with no dialog semantics and no focus management.** `.media-card--fullscreen` is `position:fixed; inset:0; z-index:300` with `body{overflow:hidden}`, but no `role="dialog"`, no `aria-modal`, the background feed isn't `inert`/`aria-hidden`, focus is never moved in, and never restored to the expand button on exit. A keyboard user tabs out of the visible overlay into ~100 invisible cards behind it.

## Approach
1. Call `exitFullscreen()` **before** `window.scrollTo({top: 0})` in `switchView` (or give `exitFullscreen(restoreScroll)` a flag that `update()` passes as `false`).
2. On fullscreen enter: set `role="dialog" aria-modal="true"` on the card, `inert` on `#feed-container` + `#header` + `#footer`, move focus to the exit button. On exit: reverse all of it and return focus to the originating `.media-card__expand`.
3. Keep the existing Escape handler; ensure focus can't leave the overlay while open.

## Verification
- e2e: expand a deep card, switch to Top → lands at top of Top (not mid-list); `?v=` cleared cleanly.
- Manual a11y: with the overlay open, Tab cycles only within it; Escape/exit returns focus to the expand button; a screen reader announces a dialog.
