#!/usr/bin/env bash
#
# One-time bootstrap for backend deploys (npm run setup:deploy).
#
# Google requires two things that can only be done interactively, once:
#   1. Enabling the Apps Script API for your account
#   2. A browser OAuth login (clasp login)
# This script walks through both and wires up the Script ID. It does NOT install
# any git hook and does NOT deploy — all deploys go through the deploy skill,
# which calls `npm run deploy:backend` explicitly after the release gate passes.
# Committing never deploys anything on its own.
#
# For long-lived credentials that don't hit Google's periodic 'invalid_rapt'
# re-auth (which silently breaks unattended deploys), set CLASP_CREDS to a
# Desktop OAuth client_secret.json from your OWN published GCP OAuth client,
# kept OUTSIDE the repo — this logs in with that client instead of clasp's
# shared one.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

CLASP_DIR="apps-script"

echo "═══ WatchDirectly backend deploy — one-time setup ═══"
echo

# --- 1. Apps Script API toggle -------------------------------------------
echo "Step 1/4 — Enable the Apps Script API (required for clasp push)."
echo "  Opening: https://script.google.com/home/usersettings"
command -v open >/dev/null && open "https://script.google.com/home/usersettings"
read -r -p "  Press Enter once the 'Google Apps Script API' toggle is ON... "

# --- 2. Google login -------------------------------------------------------
echo
echo "Step 2/4 — Sign in with the Google account that owns the Apps Script project."
# Use your own OAuth client when CLASP_CREDS points at its client_secret.json,
# otherwise clasp's shared google-provided client.
if [[ -n "${CLASP_CREDS:-}" ]]; then
  [[ -f "$CLASP_CREDS" ]] || { echo "❌ \$CLASP_CREDS is set but '$CLASP_CREDS' does not exist — aborting." >&2; exit 1; }
  login_cmd=(npx clasp login --creds "$CLASP_CREDS")
  echo "  Using your own OAuth client from \$CLASP_CREDS."
else
  login_cmd=(npx clasp login)
fi

# An existing ~/.clasprc.json can still be stale — Google forces periodic
# re-auth (the 'invalid_rapt' error). Don't trust the file's mere presence:
# probe with a real authenticated call and only skip login when it succeeds,
# so a stale token triggers a fresh login instead of a later deploy failure.
if [[ -f "$HOME/.clasprc.json" ]] && npx clasp list-scripts >/dev/null 2>&1; then
  echo "  Found working clasp credentials — skipping login."
else
  [[ -f "$HOME/.clasprc.json" ]] && echo "  Existing credentials are stale — re-authenticating."
  "${login_cmd[@]}"
fi

# --- 3. Script ID ----------------------------------------------------------
echo
echo "Step 3/4 — Link this repo to your Apps Script project."
if grep -q 'PASTE_SCRIPT_ID_HERE' "$CLASP_DIR/.clasp.json"; then
  echo "  In the Apps Script editor: ⚙ Project Settings → IDs → copy 'Script ID'."
  echo "  (Note: this is NOT the AKfycb... deployment ID from the /exec URL.)"
  read -r -p "  Paste your Script ID: " SCRIPT_ID
  if [[ ! "$SCRIPT_ID" =~ ^[A-Za-z0-9_-]{20,}$ ]]; then
    echo "❌ That doesn't look like a Script ID — aborting, nothing was changed." >&2
    exit 1
  fi
  printf '{\n  "scriptId": "%s",\n  "rootDir": "."\n}\n' "$SCRIPT_ID" > "$CLASP_DIR/.clasp.json"
  echo "  Wrote $CLASP_DIR/.clasp.json"
else
  echo "  $CLASP_DIR/.clasp.json already has a Script ID — keeping it."
fi

# Sanity check: the deployment the frontend points at must belong to this script.
DEPLOYMENT_ID=$(grep -oE 'macros/s/[A-Za-z0-9_-]+' js/config.js | head -1 | cut -d/ -f3)
echo "  Verifying deployment $DEPLOYMENT_ID exists on that script..."
DEPLOY_LIST=$( (cd "$CLASP_DIR" && npx clasp list-deployments) 2>/dev/null || true )
if echo "$DEPLOY_LIST" | grep -q "$DEPLOYMENT_ID"; then
  echo "  ✓ Deployment found — the live /exec URL will be updated in place."
else
  echo "  ⚠️  Could not confirm deployment $DEPLOYMENT_ID on that script."
  echo "     If the Script ID is wrong, deploys will fail or hit the wrong project."
  read -r -p "  Continue anyway? [y/N] " yn
  [[ "$yn" == "y" || "$yn" == "Y" ]] || exit 1
fi

# --- 4. Remove any legacy auto-deploy hook ---------------------------------
echo
echo "Step 4/4 — Making sure nothing deploys behind your back."
if [[ -f .git/hooks/post-commit ]]; then
  rm -f .git/hooks/post-commit
  echo "  ✓ Removed a legacy post-commit auto-deploy hook — deploys go through the skill only."
else
  echo "  ✓ No auto-deploy hook present (good — deploys go through the skill only)."
fi

echo
echo "═══ clasp is wired up. To ship the backend, run the deploy skill; it will"
echo "    validate the release and then call 'npm run deploy:backend' for you. ═══"
