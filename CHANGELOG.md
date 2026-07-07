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

### 1.2.1 — 2026-07-07
- Feed batches now insert in a single synchronous DOM pass — layout settles
  in one frame instead of shifting for ~1s per page while cards trickled in
  on timers (clicks kept landing on a moving page). The staggered entrance
  reveal looks the same but runs compositor-only via per-card CSS
  `animation-delay` (long-form first, Shorts fade in after at their
  chronological position), so it causes zero layout shift.
- Scroll targets no longer land underneath the sticky header: a universal
  `scroll-margin-top` means keyboard focus (Tab) and `scrollIntoView` leave
  chips, vote/star/expand buttons and cards below the header instead of
  burying them where taps hit the header. Generalizes the fix `.media-card`
  already had for the post-fullscreen scroll restore.

### 1.2.0 — 2026-07-07
- Content-type chips are now pure UI visibility filters (CSS hide/show over
  already-rendered cards) instead of re-rendering through the search index —
  a type-only filter matched most of the catalog and painting thousands of
  cards per click froze the app. Cards carry `data-media-type`; deselected
  types get a `feed--hide-<type>` class on the feed container.
- Pagination and infinite scroll keep running under a type filter, and a new
  top-up setting (`TYPE_FILTER_MIN_CARDS: 20`) automatically pulls more pages
  when the filtered Latest feed has fewer than 20 matching items (bounded by
  `TYPE_FILTER_TOP_UP_MAX_PAGES` per interaction).

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

### 1.1.0 — 2026-07-07
- Pull premieres and scheduled/active live streams. RSS entries for these are
  indistinguishable from normal uploads (no broadcast state, no air time), so
  the crawl now enriches each YouTube item via the Data API `videos.list`
  (`part=snippet,liveStreamingDetails`, 50 ids/call) into three self-initialized
  columns: `live_status` (`upcoming`/`live`/`none`), `scheduled_start`, and
  `expires_at`. A premiere/live entry gets an `expires_at` (scheduled start, or
  ingest time, + 12h grace); once it airs it keeps the **same** video id and the
  existing row is re-enriched in place to `none` with `expires_at` cleared —
  becoming permanent. `readAllVideos` drops rows whose `expires_at` has passed,
  so an entry that never airs expires out instead of lingering. Requires a
  `youtube_api_key` Meta value; without one the crawl is unchanged.

### 1.0.0 — 2026-07-07
- Initial versioned release. Google Apps Script web app over Sheets:
  feed/comments/topWeek/refresh/logs GET actions,
  comment/vote/star POST actions, token verification, rate limiting,
  blocklist. Adds `version` stamp on all responses and `?action=version`.

## Repo

### 1.1.0 — 2026-07-07
- New performance test suite (`tests/perf/`, `npm run test:perf`): 16
  user-journey latency tests against a fully mocked backend (cold/warm load,
  revalidation non-blocking, prefetch consumption, scroll jank via longtask
  observer, chip filters, progressive search, tab switches, fullscreen,
  optimistic votes, a full multi-stage journey, and a CPU/network-throttled
  mobile variant). Runs as its own Playwright project, serially — latency
  measured under 16-way parallelism is noise. E2E projects now skip
  `tests/perf/`; the suite holds to the same 30s/test and 5s/action
  standards as e2e.

### 1.0.0 — 2026-07-07
- Initial versioned release. Vitest unit tests, Playwright e2e tests,
  channel resolution script, clasp-based backend auto-deploy.
