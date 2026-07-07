# Changelog

Every part of WatchDirectly carries its own [semver](https://semver.org/)
version (npm scheme: MAJOR.MINOR.PATCH), so progress can be followed per
component:

| Component | Version lives in | Visible at |
|---|---|---|
| Frontend | `APP_VERSION` in [js/config.js](js/config.js) | header badge + browser console at boot |
| Backend (Apps Script) | `VERSION` in [apps-script/Code.gs](apps-script/Code.gs) | `version` field on every API response, and `?action=version`; also in the clasp deployment description |
| Repo / tooling | `version` in [package.json](package.json) | `npm pkg get version` |

Bump rules (npm scheme):

- **PATCH** (1.0.x) — bug fixes, no behavior change callers notice
- **MINOR** (1.x.0) — new features, backwards compatible
- **MAJOR** (x.0.0) — breaking changes (e.g. API response shape changes)

When you change a component, bump its version and add an entry below under
that component's heading.

## Frontend

### 1.1.0 — 2026-07-07
- Replaced the creator-category chips and the Shorts on/off toggle with a
  multi-select content-type filter: **All / Videos / Articles / Shorts**.
  "All" is exclusive; picking a type clears it; selecting every type (or
  deselecting the last one) collapses back to "All". Deferred shorts
  rendering (long-form first, shorts slide in) is unchanged.

### 1.0.0 — 2026-07-07
- Initial versioned release. Paginated chronological feed with
  stale-while-revalidate caching, fuzzy full-catalog search, Top This Week
  and Starred views, inline comments, votes, stars, Shorts toggle,
  fullscreen watch-and-discuss overlay, Google Sign-In.

## Backend

### 1.0.0 — 2026-07-07
- Initial versioned release. Google Apps Script web app over Sheets:
  feed/comments/topWeek/refresh/logs GET actions,
  comment/vote/star POST actions, token verification, rate limiting,
  blocklist. Adds `version` stamp on all responses and `?action=version`.

## Repo

### 1.0.0 — 2026-07-07
- Initial versioned release. Vitest unit tests, Playwright e2e tests,
  channel resolution script, clasp-based backend auto-deploy.
