#!/usr/bin/env bash
#
# Deploys apps-script/ to the live Apps Script web app.
#
# Idempotent: skips instantly when apps-script/ content is unchanged since the
# last successful deploy (hash stored under .git/, machine-local), so the deploy
# skill can call it on every ship at ~zero cost when the backend hasn't moved.
#
# This is the ONLY backend-deploy path, and the deploy skill invokes it
# explicitly (never a git hook) — deploying is always a deliberate, validated
# step, never a side-effect of committing.
#
# The deployment ID is read from CONFIG.APPS_SCRIPT_URL in js/config.js — the
# frontend's URL is the single source of truth, and redeploying that same ID
# (clasp deploy -i) keeps the URL stable instead of minting a new /exec URL.
#
# One-time bootstrap: npm run setup:deploy
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

CLASP_DIR="apps-script"
HASH_FILE=".git/backend-deploy-hash"

if [[ ! -f "$CLASP_DIR/.clasp.json" ]] || grep -q 'PASTE_SCRIPT_ID_HERE' "$CLASP_DIR/.clasp.json"; then
  echo "ℹ️  Backend auto-deploy is not configured yet — run: npm run setup:deploy"
  exit 0
fi

DEPLOYMENT_ID=$(grep -oE 'macros/s/[A-Za-z0-9_-]+' js/config.js | head -1 | cut -d/ -f3)
if [[ -z "$DEPLOYMENT_ID" ]]; then
  echo "❌ Could not extract the deployment ID from CONFIG.APPS_SCRIPT_URL in js/config.js" >&2
  exit 1
fi

current_hash=$(cat "$CLASP_DIR"/Code.gs "$CLASP_DIR"/appsscript.json | shasum -a 256 | cut -d' ' -f1)
if [[ -f "$HASH_FILE" && "$(cat "$HASH_FILE")" == "$current_hash" ]]; then
  exit 0 # backend unchanged since last successful deploy
fi

echo "🚀 Deploying backend (deployment $DEPLOYMENT_ID)..."
(cd "$CLASP_DIR" && npx clasp push -f)
backend_version=$(grep -oE "^const VERSION = '[^']+'" "$CLASP_DIR"/Code.gs | cut -d"'" -f2)
desc="v${backend_version:-?} auto-deploy $(git rev-parse --short HEAD 2>/dev/null || echo '?') $(date '+%Y-%m-%d %H:%M')"
(cd "$CLASP_DIR" && npx clasp deploy -i "$DEPLOYMENT_ID" -d "$desc")

echo "$current_hash" > "$HASH_FILE"
echo "✅ Backend deployed: $desc"
