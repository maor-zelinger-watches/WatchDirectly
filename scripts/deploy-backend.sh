#!/usr/bin/env bash
#
# Deploys apps-script/ to the live Apps Script web app — with a layered safety net.
#
# Three layers, learned the hard way (2026-08 script.scriptapp outage):
#   A. SCOPE-CHANGE HARD BLOCK. A change to the manifest's oauthScopes on an
#      ANONYMOUS web app forces re-authorization and 403s /exec until the owner
#      re-consents. The staging check below CANNOT be relied on to catch this —
#      the dev project's authorization state can differ from prod's — so a scope
#      change is refused here and must be handled deliberately.
#   B. STAGING GATE. Deploy to the dev project first and health-check its /exec;
#      abort before prod if unhealthy. Catches code / logic / serving regressions
#      (NOT auth/scope divergence — see A).
#   C. PROD HEALTH-CHECK + PUSH-BASED ROLLBACK. After promoting to prod, verify
#      /exec serves JSON; if not, re-push the last-good (origin/main) backend and
#      redeploy. (A version-pointer redeploy is NOT enough — it doesn't revert the
#      project's pushed HEAD manifest, so it can't clear a scope-re-auth state.)
#
# Idempotent: skips instantly when apps-script/ content is unchanged since the
# last successful deploy (hash under .git/). FORCE_DEPLOY=1 bypasses the skip.
# ALLOW_SCOPE_CHANGE=1 overrides layer A once you've authorized the scope by hand.
#
# This is the ONLY backend-deploy path; the deploy skill invokes it explicitly,
# and always BEFORE `git push` (so origin/main is the last-good backend for C).
# The prod deployment ID is read from CONFIG.APPS_SCRIPT_URL in js/config.js.
#
# One-time bootstrap: npm run setup:deploy
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

CLASP_DIR="apps-script"
HASH_FILE=".git/backend-deploy-hash"

# Staging (dev) project: scriptId in apps-script/.clasp.staging.json (clasp -P).
# STAGING_DEPLOYMENT_ID is its stable web-app deployment; find it with:
#   cd apps-script && npx clasp -P .clasp.staging.json list-deployments
STAGING_CLASP="$CLASP_DIR/.clasp.staging.json"
STAGING_DEPLOYMENT_ID="AKfycbxLSiG_2DnEkVbvgyUOUPvFJ3aMJkMRYMt7bwAAxzBq3iwKCMaiGDwAmgZeBwB-m3SPfQ"

if [[ ! -f "$CLASP_DIR/.clasp.json" ]] || grep -q 'PASTE_SCRIPT_ID_HERE' "$CLASP_DIR/.clasp.json"; then
  echo "ℹ️  Backend auto-deploy is not configured yet — run: npm run setup:deploy"
  exit 0
fi

PROD_DEPLOYMENT_ID=$(grep -oE 'macros/s/[A-Za-z0-9_-]+' js/config.js | head -1 | cut -d/ -f3)
if [[ -z "$PROD_DEPLOYMENT_ID" ]]; then
  echo "❌ Could not extract the deployment ID from CONFIG.APPS_SCRIPT_URL in js/config.js" >&2
  exit 1
fi

current_hash=$(cat "$CLASP_DIR"/Code.gs "$CLASP_DIR"/appsscript.json | shasum -a 256 | cut -d' ' -f1)
if [[ "${FORCE_DEPLOY:-}" != "1" && -f "$HASH_FILE" && "$(cat "$HASH_FILE")" == "$current_hash" ]]; then
  exit 0 # backend unchanged since last successful deploy
fi

backend_version=$(grep -oE "^const VERSION = '[^']+'" "$CLASP_DIR"/Code.gs | cut -d"'" -f2)

# --- A) SCOPE-CHANGE HARD BLOCK ----------------------------------------------
if git show "origin/main:$CLASP_DIR/appsscript.json" > /tmp/wd_prev_manifest 2>/dev/null; then
  prev_scopes=$(grep -oE 'auth/[A-Za-z._]+' /tmp/wd_prev_manifest | sort -u | tr '\n' ' ')
  cur_scopes=$(grep -oE 'auth/[A-Za-z._]+' "$CLASP_DIR/appsscript.json" | sort -u | tr '\n' ' ')
  rm -f /tmp/wd_prev_manifest
  if [[ "$prev_scopes" != "$cur_scopes" ]]; then
    if [[ "${ALLOW_SCOPE_CHANGE:-}" != "1" ]]; then
      echo "❌ REFUSING TO DEPLOY: manifest OAuth scopes changed vs origin/main." >&2
      echo "     was: $prev_scopes" >&2
      echo "     now: $cur_scopes" >&2
      echo "   On this ANONYMOUS web app a scope change 403s /exec until the owner" >&2
      echo "   re-authorizes the deployment, and the staging check can't reliably" >&2
      echo "   catch it (dev's auth state differs from prod's). To proceed: authorize" >&2
      echo "   the deployment in the Apps Script editor, confirm /exec still serves," >&2
      echo "   then re-run with:  ALLOW_SCOPE_CHANGE=1 npm run deploy:backend" >&2
      exit 1
    fi
    echo "⚠️  OAuth scopes changed and ALLOW_SCOPE_CHANGE=1 is set — proceeding; watch the health-checks."
  fi
fi

# --- Health check: curl /exec, retry for propagation, assert JSON + version --
# A healthy Apps Script /exec 302-redirects to googleusercontent.com and returns
# application/json; an unauthorized/broken one returns HTML (sign-in / 403 page).
health_check() {
  local exec_url="$1" want_version="$2" label="$3"
  local body="/tmp/wd_hc_$$_${label}.txt"
  local attempt http got
  for attempt in 1 2 3 4 5; do
    http=$(curl -s -L -m 30 -o "$body" -w '%{http_code}' \
      "${exec_url}?action=feed&page=1&limit=1" 2>/dev/null || echo "000")
    if [[ "$http" == "200" ]] && grep -q '"status":"ok"' "$body" 2>/dev/null; then
      got=$(grep -oE '"version":"[^"]*"' "$body" | head -1 | sed 's/.*"version":"//; s/"$//')
      if [[ -n "$want_version" && "$got" != "$want_version" ]]; then
        echo "   $label attempt $attempt: serving v$got, expected v$want_version (propagating…)"
      else
        echo "✅ $label healthy — HTTP 200, JSON feed, version ${got:-?}"
        rm -f "$body"; return 0
      fi
    else
      echo "   $label attempt $attempt: not healthy yet (http=$http)"
    fi
    sleep 5
  done
  rm -f "$body"
  return 1
}

# Re-push the last-good (origin/main) backend and redeploy prod. Used only when a
# prod deploy fails its health-check. Restores the working tree afterward.
rollback_prod() {
  echo "↩️  Rolling back prod: re-pushing the origin/main backend snapshot…" >&2
  local saved_code saved_manifest
  saved_code=$(mktemp); saved_manifest=$(mktemp)
  cp "$CLASP_DIR/Code.gs" "$saved_code"; cp "$CLASP_DIR/appsscript.json" "$saved_manifest"
  if git show "origin/main:$CLASP_DIR/Code.gs" > "$CLASP_DIR/Code.gs" 2>/dev/null \
     && git show "origin/main:$CLASP_DIR/appsscript.json" > "$CLASP_DIR/appsscript.json" 2>/dev/null; then
    if (cd "$CLASP_DIR" && npx clasp push -f && npx clasp deploy -i "$PROD_DEPLOYMENT_ID" -d "rollback to origin/main (failed health check)"); then
      echo "↩️  Rolled back to origin/main. Verify the site before re-deploying." >&2
    else
      echo "⚠️  Rollback push/deploy failed — restore manually from origin/main." >&2
    fi
  else
    echo "⚠️  Could not read the origin/main backend snapshot — roll back manually." >&2
  fi
  cp "$saved_code" "$CLASP_DIR/Code.gs"; cp "$saved_manifest" "$CLASP_DIR/appsscript.json"
  rm -f "$saved_code" "$saved_manifest"
}

# --- B) STAGING: deploy to dev + health-check BEFORE prod --------------------
if [[ -f "$STAGING_CLASP" && -n "$STAGING_DEPLOYMENT_ID" ]]; then
  staging_url="https://script.google.com/macros/s/${STAGING_DEPLOYMENT_ID}/exec"
  echo "🧪 Staging: pushing to dev project + updating deployment…"
  (cd "$CLASP_DIR" && npx clasp -P .clasp.staging.json push -f) > /dev/null
  (cd "$CLASP_DIR" && npx clasp -P .clasp.staging.json deploy -i "$STAGING_DEPLOYMENT_ID" -d "staging v$backend_version") > /dev/null
  if ! health_check "$staging_url" "$backend_version" "staging"; then
    echo "❌ Staging health-check FAILED — NOT promoting to prod." >&2
    echo "   Fix the backend and re-run; prod was not touched." >&2
    exit 1
  fi
else
  echo "⚠️  No staging project configured (apps-script/.clasp.staging.json) —"
  echo "    deploying straight to prod with NO pre-flight gate."
fi

# --- C) PROD: deploy, health-check, push-based rollback on failure -----------
echo "🚀 Deploying backend to PROD ($PROD_DEPLOYMENT_ID)…"
(cd "$CLASP_DIR" && npx clasp push -f)
desc="v${backend_version:-?} auto-deploy $(git rev-parse --short HEAD 2>/dev/null || echo '?') $(date '+%Y-%m-%d %H:%M')"
(cd "$CLASP_DIR" && npx clasp deploy -i "$PROD_DEPLOYMENT_ID" -d "$desc")

prod_url="https://script.google.com/macros/s/${PROD_DEPLOYMENT_ID}/exec"
if ! health_check "$prod_url" "$backend_version" "prod"; then
  echo "❌ PROD health-check FAILED after deploy." >&2
  rollback_prod
  exit 1 # do NOT record success hash — a re-run will retry
fi

echo "$current_hash" > "$HASH_FILE"
echo "✅ Backend deployed: $desc (staging + prod health-checked)"
