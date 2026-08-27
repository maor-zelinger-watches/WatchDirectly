# Fix plan: fix/seo-social-meta

**Phase:** P3 · **Ships via:** git push (Pages) · **Files:** `index.html`, `privacy.html`, `terms.html`, new `og-image` asset, `robots.txt` (new), `sitemap.xml` (new)

## Findings closed
- **T4 — Missing `og:image`, `og:url`, `twitter:card`, canonical, favicon.** `index.html:22` has only `og:title`/`og:description`/`og:type`; the repo has **zero** image assets. Sharing is first-class (`share.js` mints `?v=<id>` links, wired into every card, 8 e2e cases) yet every shared link unfurls as the same imageless generic card and the tab shows a default globe. `privacy.html`/`terms.html` have no `og:` tags. Canonical also matters because `github.io/WatchDirectly` still 301s in and www/apex both resolve.
- **T6 — Missing `robots.txt` and `sitemap.xml`.** A public aggregator on a fresh custom domain with four indexable pages (`404.html` correctly `noindex`) has no crawl directives at the exact moment the domain changed.

## Approach
1. Add a 1200×630 `og:image` (committed asset), plus `og:url`, `twitter:card=summary_large_image`, and `<link rel="canonical" href="https://www.howyouwatch.com/">` to `index.html`; add basic `og:` tags to `privacy.html`/`terms.html`.
2. Add a favicon set (`.ico` + PNG sizes) and reference it.
3. Add `robots.txt` (`Allow: /`, `Sitemap: https://www.howyouwatch.com/sitemap.xml`) and a static three-URL `sitemap.xml` (index, privacy, terms).

## Verification
- Sharing-debugger style check (or view-source) confirms the OG/Twitter tags resolve and the image loads.
- Tab shows the favicon; `curl` of `/robots.txt` and `/sitemap.xml` returns them.
- Note: `img-src 'self' data: https:` in the CSP already allows the OG image; no CSP change needed.
