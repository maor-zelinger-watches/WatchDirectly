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

## Shipping

Nothing ships by hand — releases go through the **deploy skill**, which bumps
versions, writes CHANGELOG entries, validates them with
`npm run validate:release` ([`scripts/validate-release.js`](scripts/validate-release.js)),
and only then deploys: the backend via `npm run deploy:backend`
(clasp, staging-gated with health checks), the frontend via `git push`
(GitHub Pages). Committing never deploys anything on its own.

One-time backend deploy setup: `npm run setup:deploy`.
