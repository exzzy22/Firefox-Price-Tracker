#!/usr/bin/env bash
set -euo pipefail

echo "Updating AMO listing using release/amo-metadata.json"
if [ ! -f release/amo-metadata.json ]; then
  echo "release/amo-metadata.json not found; skipping AMO update"
  exit 0
fi

SLUG=$(python3 -c "import json,sys;print(json.load(open('release/amo-metadata.json')).get('addon_slug',''))")
if [ -z "$SLUG" ]; then
  echo "addon_slug missing in release/amo-metadata.json; skipping"
  exit 0
fi

echo "Preparing auth header for AMO via JWT"
if [ -z "${AMO_JWT_ISSUER:-}" ] || [ -z "${AMO_JWT_SECRET:-}" ]; then
  echo "AMO JWT credentials not present; skipping AMO update"
  exit 0
fi

echo "AMO_JWT_ISSUER: ${AMO_JWT_ISSUER}"
python3 -m pip install --quiet PyJWT
# generate short-lived JWT and expose it as JWT_TOKEN
JWT_TOKEN=$(python3 -c "import os,time,uuid,jwt; iss=os.environ.get('AMO_JWT_ISSUER'); secret=os.environ.get('AMO_JWT_SECRET'); iat=int(time.time()); payload={'iss':iss,'jti':str(uuid.uuid4()),'iat':iat,'exp':iat+60}; token=jwt.encode(payload,secret,algorithm='HS256'); print(token.decode('utf-8') if isinstance(token,bytes) else token)")

echo "JWT generated (not printing token)"
# export so child processes see it (diagnostic Python looks for env var)
export JWT_TOKEN="$JWT_TOKEN"
# Show decoded JWT payload for diagnostics (no secret printed)
python3 <<'PY'
import os, jwt, sys
tok = os.environ.get('JWT_TOKEN')
if not tok:
  print('JWT_TOKEN not set')
  sys.exit(0)
try:
  payload = jwt.decode(tok, options={'verify_signature': False})
  print('JWT payload:', payload)
except Exception as e:
  print('Failed to decode JWT payload:', e)
PY

# Test GET access to the add-on with the generated token
echo "Checking AMO GET /addons/addon/$SLUG/ with JWT auth"
HTTP_STATUS=$(curl -s -o amo-get.json -w "%{http_code}" -H "Authorization: JWT ${JWT_TOKEN}" "https://addons.mozilla.org/api/v5/addons/addon/$SLUG/" || true)
echo "AMO GET status: $HTTP_STATUS"
echo "AMO GET body:"; cat amo-get.json || true

# If we don't have permission, show guidance and skip the PATCH
if [ "$HTTP_STATUS" = "403" ]; then
  echo "AMO GET returned 403: token lacks permission or add-on is disabled by developer."
  echo "Check that the JWT key belongs to the add-on owner and that the add-on is enabled in AMO Developer Hub."
  echo "AMO GET body:"; cat amo-get.json || true
  echo "Skipping PATCH due to insufficient permissions."
  exit 0
fi

echo "Attempting PATCH to update listing (show full response)"
curl -i -s -X PATCH "https://addons.mozilla.org/api/v5/addons/addon/$SLUG/" \
  -H "Authorization: JWT ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @release/amo-metadata.json | tee amo-update.log || true

echo "AMO update (tail):"; tail -n 200 amo-update.log || true
