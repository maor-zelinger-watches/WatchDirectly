# WatchDirectly — Operator Guide

Everything **you** (the operator) can do to run the site: add channels, tune
settings, moderate users, and trigger refreshes. No coding required — most
actions are either editing a spreadsheet cell or clicking **Run** on a function
in the Apps Script editor.

The whole backend lives in [`Code.gs`](Code.gs). The frontend (what visitors
see) needs no operator action once deployed — it reads from the backend.

---

## How the data is stored

Each "sheet" is a **separate Google Spreadsheet**. There are six:

| Spreadsheet | What it holds | Do you edit it? |
|---|---|---|
| **CHANNELS** | The list of channels/sites the app pulls from | ✅ Yes — this is where you add channels |
| **VIDEOS** | Every fetched video/article (filled automatically) | ❌ No — the crawl manages it |
| **META** | Settings & secrets (see the config table below) | ✅ Yes — for settings/keys |
| **BLOCKED** | Users banned from commenting | ✅ Yes — for moderation |
| **COMMENTS** | User comments (filled automatically) | ❌ No |
| **LOGS** | Diagnostic log (filled automatically) | ❌ No |

---

## Things you do by editing a spreadsheet

### ➕ Add a new channel — from just a URL

1. Open the **CHANNELS** spreadsheet, go to a new empty row.
2. Paste the channel link into the **`url`** column. Leave `channel_name`,
   `channel_id`, `feed_url`, and `avatar` blank.
   - Works with a **YouTube** link (`youtube.com/@handle`, `/channel/UC…`, `/c/…`,
     `/user/…`, or the RSS feed URL), or any **news / blog** site link.
   - Optionally set `tier` and `category` yourself — those are editorial and
     can't be guessed from the link.
3. Run the **`enrichChannels`** function (see [Editor functions](#things-you-do-in-the-apps-script-editor) below).

It visits the link and fills in the rest automatically:
- **YouTube** → `channel_id`, `feed_url`, `channel_name`, `avatar`.
- **News/blog** → `feed_url` and `channel_name`; the icon is pulled from the
  site's favicon automatically, so `avatar` stays blank.

It also flips the channel **on** (`enabled` → TRUE) so it starts being crawled.
You can paste several rows and run once. It **only fills blank cells**, so
re-running is always safe and never overwrites your edits.

### ⏸️ Pause or remove a channel

Set the channel's **`enabled`** cell to **`FALSE`**. It immediately stops being
crawled and disappears from the site's Channels tab. Set it back to `TRUE` to
resume. (Deleting the row also works, but disabling keeps its history.)

### 🚫 Block a user from commenting

Add the user's email to the **`email`** column of the **BLOCKED** spreadsheet.
They can still read the site but can't post comments, vote, or star. Remove the
row to unblock.

### ⚙️ Change a setting

Edit the value in the **META** spreadsheet for the key you want. See the
[Settings reference](#settings-reference-meta-sheet) at the bottom.

---

## Things you do in the Apps Script editor

Open the script (Extensions → Apps Script), pick the function from the dropdown
at the top, and click **▶ Run**. The first run of any function may ask you to
authorize permissions once.

| Function | What it does | When to run it |
|---|---|---|
| **`enrichChannels`** | Fills in missing info for channels you added by URL (see above) | Every time you add channel URLs to the sheet |
| **`setupScheduledRefresh`** | Installs the automatic every-4-hours refresh | **Once**, after first deploying (or if the trigger was removed) |
| **`runSessionSelfTest`** | Checks the login/session signing is healthy | Rarely — only when debugging sign-in issues |

### Rarely: re-seeding from scratch (in [`Setup.gs`](Setup.gs))

These are archival — only for rebuilding a spreadsheet from zero. **Don't run
them on a live site**; they overwrite rows.

| Function | What it does |
|---|---|
| `populateChannels` | Writes the original hard-coded channel list |
| `populateChannelAvatars` | Backfills avatars for that original list |
| `populateMeta` | Writes the default settings into META |

---

## Things you do with a link (admin-only)

These require the **admin token** (the `admin_token` value in the META sheet).
Without a valid token they're refused.

### 🔄 Force an immediate refresh

Visit (or `curl`) your deployed web-app URL with:

```
?action=refresh&token=YOUR_ADMIN_TOKEN
```

Kicks off a full crawl right now instead of waiting for the 4-hour schedule.
Useful right after adding channels, to see their content appear immediately.

### 📋 Read the diagnostic logs

Send a `POST` to the web-app URL with a JSON body:

```json
{ "action": "logs", "token": "YOUR_ADMIN_TOKEN" }
```

Returns recent log entries. (Sent as POST so the token never lands in a URL.)

---

## Things that happen automatically (no action needed)

- **Every 4 hours:** all enabled channels are crawled for new content (once
  `setupScheduledRefresh` has been run once).
- **On demand:** if a visitor loads the site and the data is stale, a refresh is
  kicked off in the background — the visitor still sees cached content instantly.
- **Retention:** videos older than 60 days are moved to an Archive tab so the
  live catalog stays fast. Nothing is deleted; archived items still power search
  and history.

---

## Settings reference (META sheet)

Each row is a `key` in column A and its `value` in column B.

| Key | What it controls | Example |
|---|---|---|
| `admin_token` | Secret that unlocks the admin actions above. **Keep private.** If unset, admin actions are fully disabled. | `a-long-random-string` |
| `youtube_api_key` | YouTube Data API key. Enables live/premiere detection and fresh view counts. Without it, the app still works from plain RSS. | `AIza…` |
| `refresh_interval_hours` | How stale (in hours) data can get before a refresh is triggered | `4` |
| `log_level` | How much detail to log: `DEBUG`, `INFO`, `WARN`, or `ERROR` | `ERROR` |
| `site_name` | Display name of the site | `WatchDirectly` |

> `last_fetch` and `fetch_in_progress` also appear in META — those are managed
> automatically by the crawl. Leave them alone.

---

## Quick reference: "I want to…"

| Goal | Do this |
|---|---|
| Add a YouTube channel or news site | Paste its URL into CHANNELS → run `enrichChannels` |
| Stop pulling from a channel | Set its `enabled` cell to `FALSE` |
| See new content right now | `?action=refresh&token=…` |
| Ban a commenter | Add their email to the BLOCKED sheet |
| Change how often it refreshes | Edit `refresh_interval_hours` in META |
| Turn on live/premiere + view counts | Add `youtube_api_key` to META |
| Turn on automatic refreshing | Run `setupScheduledRefresh` once |
