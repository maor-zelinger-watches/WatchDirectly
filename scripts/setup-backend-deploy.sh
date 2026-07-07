#!/usr/bin/env bash
#
# One-time bootstrap for automatic backend deploys (npm run setup:deploy).
#
# Google requires two things that can only be done interactively, once:
#   1. Enabling the Apps Script API for your account
#   2. A browser OAuth login (clasp login)
# This script walks through both, wires up the Script ID, installs the
# post-commit hook, and runs the first deploy. After it finishes, every
# commit that changes apps-script/ deploys automatically.
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
if [[ -f "$HOME/.clasprc.json" ]]; then
  echo "  Found existing clasp credentials (~/.clasprc.json) — skipping login."
else
  npx clasp login
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
DEPLOYMENT_ID=$(grep -oE 'macros/s/[A-Za-z0-9_-]+' js/app.js | head -1 | cut -d/ -f3)
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

# --- 4. Hook + first deploy -------------------------------------------------
echo
echo "Step 4/4 — Installing the post-commit hook and running the first deploy."
mkdir -p .git/hooks
cat > .git/hooks/post-commit <<'HOOK'
#!/bin/sh
# Auto-deploys the Apps Script backend after each commit. No-ops instantly
# when apps-script/ is unchanged since the last successful deploy.
# Installed by: npm run setup:deploy
cd "$(git rev-parse --show-toplevel)" || exit 0
./scripts/deploy-backend.sh || echo "⚠️  Backend auto-deploy failed — run: npm run deploy:backend"
HOOK
chmod +x .git/hooks/post-commit
echo "  ✓ Hook installed (.git/hooks/post-commit)"

rm -f .git/backend-deploy-hash   # force a full deploy now
./scripts/deploy-backend.sh

echo
echo "═══ Done. From now on, committing a change under apps-script/ deploys it. ═══"
