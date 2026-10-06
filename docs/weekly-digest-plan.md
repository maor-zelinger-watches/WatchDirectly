# Weekly "Top This Week" email digest — plan

**Status:** proposal, 2026-10-02 · **Owner:** Maor · **Ships via:** two feature branches (see §6), deploy skill

## 0. What we're building

Every week, with no human in the loop, every subscriber who answered **"Email me"**
gets one email showing the **top 10 of the site's Top This Week ranking** — the same
ten cards the `Top This Week` tab shows at that moment, rendered as **static
thumbnails** (no iframes; email clients don't run them) that link back to the site.

Hard constraints the plan respects:

- Only rows with `marketing_consent = 'yes'` in the CUSTOMERS sheet may ever be
  mailed (Code.gs:4588, privacy.html §2.6). The digest never reads any other list.
- The privacy policy promises "every marketing email we send also tells you how to
  opt out" and names Email preferences as the unsubscribe path. The email must carry
  both an unsubscribe link and the Email-preferences instructions.
- The main backend is an **anonymous** Apps Script web app. Adding an OAuth scope to it
  (which sending mail requires) 403s the live `/exec` until re-auth, and
  `scripts/deploy-backend.sh` hard-blocks scope changes. **The mailer therefore
  must not live in `apps-script/Code.gs`.**

## 1. Sending service: recommendation

**Now: Apps Script's built-in `MailApp`, from the script owner account
(admin@maorzelinger.com, Google Workspace).** Zero cost, zero vendor, no DNS work,
and a quota of **1,500 recipients per day** (Workspace; a consumer Gmail owner
would get only 100). That is more than every free third-party tier offers
(Resend 100/day, Mailgun 100/day, Mailjet 200/day, Brevo 300/day), so for a
weekly send to an opt-in list under ~1,500 people MailApp is simply the best
option available. Mail goes out through Google's infrastructure with the
Workspace domain's SPF/DKIM, and each recipient gets an individual message
(never BCC), so the unsubscribe link is personal and no address leaks.

What MailApp cannot do: set custom headers, so no RFC 8058 `List-Unsubscribe`.
Gmail only **requires** one-click unsubscribe from senders of 5,000+ messages a
day to gmail.com addresses; below that it is best practice, not a rule. The
visible unsubscribe link in the body (§2.1) is what keeps the complaint rate low,
and it works with MailApp.

**Later, when the list passes ~1,500 or spam-foldering shows up: a paid
transactional API called from `UrlFetchApp`.** Recommended **Resend Pro
($20/month, 50k emails)**: Bearer-token JSON API, explicit `headers` support
documented with `List-Unsubscribe`, newsletters allowed, sends from
`@howyouwatch.com` once SPF/DKIM/DMARC records are added at Squarespace DNS (the
registrar, per `docs/custom-domain-switch.md`). Alternative if you would rather
outsource compliance: **Postmark Broadcast stream ($15/month, 10k)**, which adds
the RFC 8058 headers and an unsubscribe link itself, but then keeps its own
suppression list that we would have to sync back into CUSTOMERS by webhook.

The sender is written as a **pluggable transport** from day one (`sendOne(to,
subject, html, text)` behind a META switch `digest_transport = mailapp | resend`),
so the switch is one adapter plus DNS records, not a rewrite.

### 1.1 Why not the alternatives

- **Mailer inside Code.gs** — needs the `script.send_mail` scope on the anonymous
  web app → the 403 outage of 2026-08-27 again. Ruled out.
- **A newsletter SaaS (Mailchimp, Buttondown, Loops) owning the list** — a second
  copy of consent data to keep in sync, a per-contact price, and still needs Apps
  Script to generate the weekly content. The CUSTOMERS sheet stays the single
  source of truth instead.
- **Amazon SES** — cheapest at scale, but requests need AWS SigV4 signing, which is
  painful from Apps Script, and sandbox exit is a manual review. Not worth it
  under thousands of recipients a week.

### 1.2 Service comparison (checked 2026-10-02)

| Option | Free tier | Cheapest paid | Callable from Apps Script with a plain API key? | `List-Unsubscribe` header? | Newsletters allowed? | Verdict |
|---|---|---|---|---|---|---|
| **MailApp / GmailApp** (Workspace owner) | 1,500 recipients/day, 400 KB body | n/a | built in | **No** (no custom headers) | yes | **Use now** |
| GmailApp via Gmail API raw MIME | same account quota (unverified) | n/a | yes, Advanced Gmail service | yes (hand-built MIME) | yes | fallback if we ever want RFC 8058 without an ESP |
| **Resend** | 3,000/mo but **100/day** | Pro $20/mo, 50k | yes, Bearer JSON | yes, documented | yes | **Paid tier = later default** |
| Postmark | 100/mo | Basic $15/mo, 10k | yes, token header | Broadcast stream adds it automatically | yes, Broadcast stream only | alternative later |
| Brevo | **300/day**, logo in footer | Starter $9/mo, 5k, no daily cap | yes, `api-key` header | doubtful (docs: standard headers unsupported) | yes | cheap, but header support unverified |
| Mailjet | 6,000/mo but **200/day**, logo | $9/mo, 8k | yes, Basic auth | yes | yes | ok, logo until $19 tier |
| Mailgun | **100/day**, 1 domain | $15/mo, 10k | yes, Basic auth | yes | yes | ok |
| MailerSend | 500/mo | $5.60/mo, 5k | yes | **paid Professional only** | yes | no |
| Amazon SES | credits only for new accounts | $0.10/1k | **no**, needs AWS SigV4 signing | yes | yes | too much plumbing from Apps Script |
| SendGrid | **free plan ended 2025**, 60-day trial | $19.95/mo | yes | yes | yes | no |
| Loops | 4,000/30 days | ~$49/mo | yes, but template-only API, no raw HTML | n/a | UI campaigns only | no |
| Mailchimp Transactional | demo only | needs paid Mailchimp | yes | yes | **banned by AUP** | no |
| Buttondown | 100 subscribers | ~$9/mo | API tier unverified | handled by platform | yes | second copy of the list; no |

Sources: Apps Script quotas page (updated 2026-09-03), Gmail sender guidelines and
FAQ, each provider's pricing and API-reference pages. Brevo's pricing page refused
automated fetches; its numbers come from Brevo help-center snippets and 2026
reviews. Full research notes are in the session, not the repo.

Other facts that shaped the design:

- Gmail enforcement of its sender guidelines ramped up from November 2025:
  SPF **or** DKIM, TLS, spam rate under 0.3% apply to **every** sender. Workspace
  handles SPF; DKIM must be switched on once in the Workspace admin console (§5).
- Gmail clips HTML over ~102 KB and Gmail iOS clips earlier; images do not count.
- Gmail proxies every remote image through googleusercontent.com, so thumbnails
  must be public https URLs. `i.ytimg.com` loads fine. `maxresdefault.jpg` is
  missing for ~12% of videos; `mqdefault.jpg` (320×180) always exists and is 16:9
  without letterbox bars, while `hqdefault.jpg` (what the RSS crawl stores) is 4:3
  with black bars.
- `UrlFetchApp` requests time out at ~60 s, each execution at 6 min; Workspace
  triggers get 6 h of runtime per day. All far above what one weekly send needs.

## 2. Architecture

```
  Time trigger (weekly)                     ┌────────────────────────────┐
  in NEW standalone script  ──── GET ─────▶ │ prod /exec?action=topWeek  │  same ranking
  "howyouwatch-digest"                      │ &limit=10  (public, cached)│  the site shows
  owner: admin@maorzelinger.com             └────────────────────────────┘
          │
          ├── reads META sheet   : digest_enabled, digest_unsubscribe_secret, from/reply-to, transport
          ├── reads CUSTOMERS    : rows with marketing_consent = 'yes'  (dedupe, lowercase)
          ├── renders table-based HTML + plain text  (10 cards, thumbnails, deep links)
          ├── sends 1 message per recipient via transport (MailApp now, API later)
          │     batches of ~150 per execution, continuation trigger, quota-aware
          ├── state in PropertiesService : week key + cursor  → idempotent, resumable
          └── writes a DIGEST_RUNS row + emails the owner on failure
```

**Where it lives:** `apps-script-digest/` in this repo — `Digest.gs`,
`appsscript.json` (scopes: `spreadsheets`, `script.external_request`,
`script.send_mail`, `script.scriptapp`), `.clasp.json` for a **new standalone
project** created under admin@maorzelinger.com. It has **no web-app deployment** and
is never anonymous, so scope changes there can never break the site. Triggers run
the pushed HEAD, so `clasp push` is the deploy.

**Why fetch the ranking over HTTP instead of reading the VIDEOS sheet:** parity.
`handleTopWeek` (Code.gs:3503) owns the score (`votes + views/5000`), the 7-day
window, expiry drops and URL dedupe. Re-implementing that in a second script would
drift. The call is one public GET that the site already makes.

### 2.1 Main backend + frontend changes (small, **no new scopes**)

1. **One-click unsubscribe.** New action `unsubscribe` in Code.gs that accepts the
   token from a JSON POST body (the site), from `e.parameter` on a GET, **and**
   from a form-encoded POST whose body is `List-Unsubscribe=One-Click`. The last
   two cost nothing now and are exactly what RFC 8058 mail clients send to the
   `List-Unsubscribe` URL later, so the later ESP phase needs no backend change.
   `token = base64url(HMAC-SHA256(digest_unsubscribe_secret, lowercase email))`,
   computed with the `Utilities.computeHmacSha256Signature` helpers already used
   for request signing. The handler walks the Customers tab, finds the matching
   row, sets `marketing_consent = 'no'` + `consent_updated_at`, and returns ok. No
   email ever appears in a URL. Unknown token → generic error, same timing.
   Note `doPost` today does `JSON.parse` on every body; the form-encoded case
   needs a guard before the parse.
2. **Frontend:** on load, if `?unsubscribe=<token>` is present, call the action,
   show a toast ("You're unsubscribed. Change your mind under Email
   preferences."), strip the param (same pattern as `?v=` in js/share.js). Works
   signed-out — that is the whole point.
3. **privacy.html §2.6:** add one sentence that every email carries a one-click
   unsubscribe link.

### 2.2 Email content

- **Header:** "How You Watch · Top This Week", date range (Asia/Jerusalem week).
- **10 cards**, rank-numbered, visually matching `createMediaCard` (js/feed.js:70)
  and the site tokens (css/style.css `:root`): black canvas, off-black card,
  white title, slate meta, chartreuse accent used once per card. Email-safe
  stack (Arial/Helvetica) since Gmail drops web fonts.
  - Image, fixed 560×315, `alt` = title. YouTube rows: try
    `i.ytimg.com/vi/<id>/maxresdefault.jpg` with one `HEAD` request (10 calls per
    run, trivial), fall back to `mqdefault.jpg`, which always exists and is 16:9.
    The stored `preview_image` (`hqdefault`) is 4:3 with black bars, so it is not
    used for the email. Articles: stored og:image if it answers a `HEAD` with 200,
    else a dark placeholder block with the site's article icon as inline SVG.
  - Image and title both link to the site deep link
    `https://www.howyouwatch.com/?v=<video_id>` so the click lands on the card in
    the fullscreen overlay with comments and votes, not on YouTube.
  - Meta line: channel · time ago · views · ▲ votes · comments. Articles get a
    "Read article" pill like the site.
  - Shorts are kept if they rank, for parity with the tab.
- **Footer:** why you got this ("you chose *Email me* on How You Watch"),
  **Unsubscribe** link (one click), "or tap your avatar → Email preferences",
  Privacy link, reply-to contact@andrewmorganwatches.com.
- **Plain-text part** generated from the same data (MailApp `body` + `htmlBody`).
- Budget: 10 cards ≈ 15–20 KB. Unit test caps the HTML at 60 KB, under Gmail's
  ~102 KB clip and with room for Gmail iOS, which clips earlier.
- Styling: critical styles inline on every cell (some Gmail surfaces strip
  `<style>`); a small `<style>` block only for the mobile media query.

### 2.3 Run semantics (the "no human touch" guarantees)

| Concern | Behaviour |
|---|---|
| Schedule | `setupWeeklyDigest()` installs one time trigger, default **Friday 17:00 Asia/Jerusalem** (constants `DIGEST_DAY`, `DIGEST_HOUR`). Run once from the editor by the owner — the only human step. |
| Idempotency | Week key `YYYY-Www`. `PropertiesService` holds `digest_<week>_status` and `_cursor`. A second fire in the same week is a no-op. |
| Thin week | Fewer than 3 items in the ranking → skip, log, email owner. 3–9 items → send what exists. |
| Ranking fetch fails | Retry twice with backoff inside the run; still failing → one-off trigger in 60 min, max 3 retries, then give up for the week and email owner. |
| 6-minute execution cap | Send in batches of ~150; after each batch persist the cursor; if elapsed > 4.5 min, schedule a continuation trigger `after(60s)` and exit. |
| Daily quota | Check `MailApp.getRemainingDailyQuota()` before each send; at zero, persist cursor and schedule continuation for +24 h. |
| Per-recipient failure | Catch, count, continue. Never abort the run for one bad address. |
| Kill switch | META `digest_enabled` ≠ `yes` → run exits immediately (default off until the preview is approved). |
| Observability | Append to a `DIGEST_RUNS` tab in LOGS: week, started, finished, items, recipients, sent, failed, status, error. Any ERROR also mails the owner. |
| Preview | `sendDigestPreviewToOwner()` renders the live top 10 and sends only to the owner — run before flipping the kill switch, and whenever the template changes. |
| Dry run | META `digest_dry_run = yes` → full run, writes the DIGEST_RUNS row with recipient count, sends nothing. |

## 3. Settings (META sheet, new rows)

| Key | Purpose | Default |
|---|---|---|
| `digest_enabled` | Kill switch | blank (off) |
| `digest_dry_run` | Count recipients, send nothing | blank |
| `digest_unsubscribe_secret` | HMAC key shared by both scripts | **must be set**, long random |
| `digest_from_name` | Display name | `How You Watch` |
| `digest_reply_to` | Reply-To | `contact@andrewmorganwatches.com` |
| `digest_transport` | `mailapp` or `resend` | `mailapp` |
| `resend_api_key` | Branch 3 only | blank |

Both scripts open the same META spreadsheet (same owner), so no secret ever
crosses the wire.

## 4. Tests

- `tests/unit/backend/digest.test.js` — loads `apps-script-digest/Digest.gs` the
  way the other backend suites load Code.gs (read source, mock `SpreadsheetApp`,
  `UrlFetchApp`, `MailApp`, `PropertiesService`, `ScriptApp`, `Utilities`):
  - selects only `marketing_consent = 'yes'`, lowercases and dedupes, ignores blanks
  - renders 10 cards, every image absolute https, **no `<iframe>`**, HTML < 60 KB,
    every card links to `?v=<id>`, unsubscribe token present per recipient
  - skips below 3 items; idempotent per week key; cursor resumes mid-list;
    quota 0 → defers; one bad recipient does not stop the batch
  - `digest_enabled` blank → nothing sent; dry run → count only
- `tests/unit/backend/email_consent.test.js` — add `unsubscribe`: valid token flips
  the row to `no` with a timestamp; wrong/missing token rejected; no new scopes
  in `apps-script/appsscript.json` (snapshot the scope list).
- `tests/unit/share.test.js` style test for `?unsubscribe=` handling and param strip.
- Manual once: preview to owner; open in Gmail web, Gmail iOS, Apple Mail,
  Outlook; dark-mode check; click thumbnail → lands on the card.

## 5. Human steps (one-time, Maor)

1. Confirm admin@maorzelinger.com is a Workspace account (that is what gives the
   1,500/day quota; a consumer account would cap the list at 100).
2. In the Workspace admin console, check that **DKIM** is turned on for
   maorzelinger.com (Apps → Google Workspace → Gmail → Authenticate email) and
   that the domain has a `DMARC` record, `p=none` is enough. Gmail has enforced
   SPF-or-DKIM for all senders since late 2025.
3. Generate `digest_unsubscribe_secret` and add the META rows in §3.
4. `npx clasp login` as admin@maorzelinger.com, then `clasp create --type standalone`
   for the digest project (Claude prepares the files; the create and the first
   authorization need the owner session — see memory on clasp credential expiry).
5. In the digest project editor: run `setupWeeklyDigest()` once (grants scopes,
   installs the trigger), then `sendDigestPreviewToOwner()` and check the inbox.
6. Pick send day/hour if not Friday 17:00 Israel time.
7. Set `digest_enabled = yes`.
8. Optional, better sender identity: add a `hello@howyouwatch.com` send-as alias in
   Gmail (needs the domain verified in Workspace or an alias domain) and switch
   the transport to `GmailApp` with `from` — or go straight to branch 3.

## 6. Delivery order

| # | Branch | Scope | Ships |
|---|---|---|---|
| 1 | `feature/one-click-unsubscribe` | Code.gs `unsubscribe` action, `?unsubscribe=` on the frontend, privacy.html sentence, tests | Frontend + Backend via the deploy skill (no scope change → normal deploy) |
| 2 | `feature/weekly-digest` | `apps-script-digest/` (Digest.gs, manifest, clasp config), `scripts/deploy-digest.sh` + `npm run deploy:digest`, `validate-release.js` learns a third component `Digest`, README operator section, tests | `clasp push` to the new project; human steps §5 |
| 3 | `feature/digest-resend-transport` (later) | Resend adapter, `List-Unsubscribe` + `List-Unsubscribe-Post` headers, bounce/complaint webhook → sets consent `no`, DNS records at Squarespace | When the list nears the daily quota or spam-foldering is seen |

Branch 1 ships first so the very first digest already carries a working
one-click unsubscribe.

## 7. Risks and open questions

- **Quota ceiling.** MailApp's 1,500-recipients-a-day cap is the limit until branch 3; above it
  the run spills into the next day by design, but that is the signal to do branch 3.
- **Sender domain mismatch.** Until branch 3, mail comes from `@maorzelinger.com` with the
  display name "How You Watch". Fine for an opt-in list; branch 3 fixes it properly.
- **No bounce handling with MailApp.** MailApp gives no bounce feedback. Hard
  bounces just fail silently each week; acceptable for a small list, solved by the
  ESP webhook in branch 3.
- **Gmail dark mode** may recolour the dark template. Keep backgrounds explicit on
  every table cell and test the preview on Gmail iOS before enabling.
- **Trigger authorization** is tied to the owner account. If the Workspace
  session policy ever revokes it, the run fails and the owner gets no email either
  (same scope). Mitigation: the scheduled CI smoke suite gets one check that the
  latest `DIGEST_RUNS` row is < 8 days old. Decide whether that is worth adding now.
- **Send time** — Friday 17:00 Israel is a guess at "end of the week" for a global
  audience (15:00 UK, 10:00 US East). Your call.
