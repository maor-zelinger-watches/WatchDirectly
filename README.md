# How You Watch

A chronological feed of watch (horology) content — videos and articles from
curated YouTube channels and news sites, with community comments, votes, and
stars. No algorithm, just the latest first.

Live at **[www.howyouwatch.com](https://www.howyouwatch.com)**.

## Architecture

Two parts, deployed independently:

- **Frontend** — a static site (plain HTML/CSS + vanilla ES modules in
  [`js/`](js/), no build step), hosted on **GitHub Pages** and published by
  pushing to `main`.
- **Backend** — a **Google Apps Script** web app ([`apps-script/Code.gs`](apps-script/Code.gs))
  backed by Google Spreadsheets. It crawls the configured channels, serves the
  feed API, and stores comments/votes. See the
  [operator guide](apps-script/README.md) for running it: adding channels,
  settings, moderation, and admin actions.

## Versioning

Three independently-versioned components (details and bump rules in
[`CHANGELOG.md`](CHANGELOG.md)):

| Component | Version lives in |
|---|---|
| Frontend | `APP_VERSION` in [`js/config.js`](js/config.js) |
| Backend | `VERSION` in [`apps-script/Code.gs`](apps-script/Code.gs) |
| Repo / tooling | `version` in [`package.json`](package.json) |

## Development

```sh
npm install
npm run serve        # static server on http://localhost:3000
```

## Tests

```sh
npm test             # unit + integration (vitest, jsdom)
npm run test:e2e     # end-to-end (Playwright, mobile + desktop Chrome)
npm run test:smoke   # smoke suite (Playwright)
npm run test:perf    # performance suite (Playwright)
npm run test:all     # all of the above
```

Run by hand, never by CI or the deploy gate:

```sh
npm run test:storage:webkit  # storage-flag e2e + perf specs on WebKit (Safari's engine);
                             # needs `npx playwright install webkit` once
npm run test:perf-live       # against the PRODUCTION backend; see
                             # playwright.perf-live.config.js (PERF_LIVE_STORAGE=idb|legacy)
```

## Storage engine flag

The large cache snapshots (feed, search index, Top This Week, channels) can
live in **IndexedDB** (`idb`, the default) or **localStorage** (`legacy`, the
pre-1.31 path, kept as a per-browser kill switch). The choice is per browser, via
[`js/flags.js`](js/flags.js):

| How | Effect |
|---|---|
| open `?storage=idb` | this browser uses IndexedDB from the next load on |
| open `?storage=legacy` | back to localStorage |
| open `?storage=default` | follow `STORAGE_ENGINE_DEFAULT` in [`js/config.js`](js/config.js) |
| devtools: `localStorage.setItem('wd_storage_engine', 'idb')` | same as `?storage=idb` |

- The URL form works on phones without devtools, and is removed from the
  address bar once applied, so a reload or bookmark can't re-assert it later.
- The engine is fixed for a page load; a flip applies on the next load.
- The console prints `storage engine: idb (default)` / `legacy (flag)` at boot.
- `legacy` never opens IndexedDB, so it's a safe kill switch. Going
  `idb` → `legacy` costs one cold load (IndexedDB's copy is ignored, not moved
  back); going `legacy` → `idb` moves the localStorage copy over.
- IndexedDB is on for everyone via `STORAGE_ENGINE_DEFAULT: 'idb'`. Rolling it
  back for everyone = setting it to `'legacy'`. Browsers that set the flag
  explicitly keep their choice either way.

Why it exists: Safari counts localStorage at 2 bytes per character once any
character is outside Latin-1, which halves its effective cap to ~2.6M
characters. The full search index is around that size and growing. When it
doesn't fit, it silently isn't saved, and a returning visitor's search re-walks
the whole catalog.

## Installable app (PWA)

The site installs as an app on Android, desktop Chrome/Edge, and (via "Add to
Home Screen") iOS. Three files make it one:

- [`manifest.webmanifest`](manifest.webmanifest) — name, icons
  (`assets/icon-*.png`, rendered from `assets/favicon.svg`), standalone display.
- [`sw.js`](sw.js) — a module service worker that precaches the app shell
  (HTML, CSS, every ES module, fonts, icons) into a cache named after
  `CONFIG.APP_VERSION`, imported straight from `js/config.js`. It answers
  same-origin GETs only; the backend, Google Sign-In, YouTube and analytics are
  never touched. Nothing is cached at runtime — a version bump installs a whole
  new shell and deletes the old one, so a page never mixes modules from two
  versions.
- [`js/pwa.js`](js/pwa.js) — registers the worker after `load`, shows a toast
  when a new version has taken over, and reveals the footer "Install app" link
  when the browser fires `beforeinstallprompt`.

Because the worker is keyed on `APP_VERSION`, shipping any frontend change
through the deploy skill (which bumps that version) is also what rolls the
offline shell forward. `tests/unit/pwa.test.js` keeps the precache list in
step with `index.html`; `tests/e2e/pwa.spec.js` installs the worker for real
and reloads offline. Every other e2e spec runs with service workers blocked
(`playwright.config.js`), so `page.route()` mocks keep seeing every request.

## Shipping

Nothing ships by hand — releases go through the **deploy skill**, which bumps
versions, writes CHANGELOG entries, validates them with
`npm run validate:release` ([`scripts/validate-release.js`](scripts/validate-release.js)),
and only then deploys: the backend via `npm run deploy:backend`
(clasp, staging-gated with health checks), the frontend via `git push`
(GitHub Pages). Committing never deploys anything on its own.

One-time backend deploy setup: `npm run setup:deploy`.
