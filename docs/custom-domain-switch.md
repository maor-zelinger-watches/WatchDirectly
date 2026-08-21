# Custom domain switch — runbook

Prepared 2026-08-20 on branch `feature/custom-domain`. This branch holds the
code half of the switch (404 page re-rooted to `/`). Nothing here ships until
DNS is live — the 404 page's root-absolute paths are only correct once the
site is served from a domain root, so merging early would break the 404 page
on the current `github.io/WatchDirectly/` subpath.

Domain (confirmed 2026-08-20, from the CNAME file GitHub committed):
**`www.howyouwatch.com`**, apex `howyouwatch.com` redirecting to it.

Status 2026-08-20: the custom domain is already set in the repo's Pages
settings, so `github.io/WatchDirectly` now 301s to www.howyouwatch.com —
which still resolves to the registrar's (Squarespace) parking records.
**The live site is unreachable until the partner swaps DNS.**

## 1. Send the partner (registrar side — Squarespace DNS)

The domain currently carries Squarespace's defaults, so these are
REPLACEMENTS, not additions. If Squarespace shows the records as linked to
a parked/connected site, disconnect that first.

```text
1. CHANGE the www CNAME record
   Host/Name:  www
   Old value:  ext-sq.squarespace.com
   New value:  maor-zelinger-watches.github.io.

2. REPLACE the four apex A records
   Host/Name:  @  (bare howyouwatch.com)
   Delete:     198.49.23.144 / 198.49.23.145 /
               198.185.159.144 / 198.185.159.145  (Squarespace)
   Add:        185.199.108.153
               185.199.109.153
               185.199.110.153
               185.199.111.153  (GitHub Pages)

3. ADD a TXT record — get the exact name/value from GitHub first:
   github.com → account Settings → Pages → Add a verified domain.
   Name looks like: _github-pages-challenge-maor-zelinger-watches
```

Needed back from the partner: which domain is ours (apex / www / both),
confirmation the records are in, and when.

## 2. Maor, in GitHub (after DNS is confirmed)

1. Repo → Settings → Pages → Custom domain → enter the domain → Save.
   GitHub commits a `CNAME` file to `main` itself — run `git pull` after.
2. Wait for the DNS check to pass, then tick **Enforce HTTPS**
   (certificate can take minutes to hours).
3. Account Settings → Pages → verify the domain (the TXT record above).

## 3. Maor, in Google Cloud Console

OAuth client `58088759188-uhqgajeoe8h218h3o6pql634pkcjsu70` →
Authorized JavaScript origins → add:

- `https://howyouwatch.com`
- `https://www.howyouwatch.com`

Without this, Google Sign-In fails on the new domain (the old origin keeps
working and can stay listed).

## 4. Ship this branch (Claude, via the deploy skill)

1. `git pull` on main (picks up GitHub's CNAME commit), rebase this branch.
2. Update the CHANGELOG entry's date to the actual ship date; re-run
   `npm run validate:release`.
3. Merge, test, deploy through the deploy skill as usual (frontend-only).

## 5. Verify after the switch

- `https://<domain>/` loads, HTTPS padlock, feed renders.
- `https://<domain>/nonexistent` shows the styled 404 with working links.
- Google Sign-In works on the new domain (needs step 3).
- Old `maor-zelinger-watches.github.io/WatchDirectly/` URL redirects to the
  new domain (GitHub does this automatically once the custom domain is set).
- Comments/votes still work — backend is domain-agnostic, nothing to change.
- Frontend error sheet: no new-domain rows beyond the expected — a burst
  here means something on the new origin broke (likely a missed OAuth
  origin or CSP surprise).
