#!/usr/bin/env bash
# scripts/probe-shp2-reboot.sh — try a series of candidate command shapes
# against an SHP2 to discover whether any documented/speculative reboot
# request is accepted by the EcoFlow Open API.
#
# Why this exists: v0.9.6 shipped a reboot button using the DPU shape
# `{ cmdSet, cmdId, params }` — EcoFlow rejected it with code 8524
# ("invalid parameter") because SHP2 uses a different protocol family,
# `{ cmdCode, params }`. tolwi/hassio-ecoflow-cloud reverse-engineered
# 12 SHP2 setters (backup reserve, EPS mode, circuit load, …) but no
# reboot — so we don't even know if a reboot exists in the public API.
# This script empirically probes the candidate shapes one at a time.
#
# Each probe goes through the add-on's own `/api/device/send-command`
# endpoint (audit-logged + signed via your existing EcoFlow creds), so
# you don't need to know any of the signing details.
#
# Usage:
#   PANEL_URL=http://homeassistant.local:8787 \
#   WRITE_DEBUG_TOKEN=your-secret-here \
#   SHP2_SN=SHP21ZAW5ZN... \
#     scripts/probe-shp2-reboot.sh [--yes]
#
#   --yes : skip the per-attempt y/n confirmation (use only if you're
#           absolutely sure none of these will trip a real reboot, OR
#           you've already verified each shape is safe).
#
# Output: one line per probe — STATUS | code | message | request body.
# A `code: 0` line means EcoFlow accepted that shape. If that happens
# and your SHP2 actually reboots, congrats — copy the body into
# `server/src/ecoflow/commands.ts` rebootShp2() and ship a patch.

set -euo pipefail

: "${PANEL_URL:?set PANEL_URL, e.g. http://homeassistant.local:8787}"
: "${WRITE_DEBUG_TOKEN:?set WRITE_DEBUG_TOKEN (also configured in the HA add-on)}"
: "${SHP2_SN:?set SHP2_SN to your SHP2 serial number}"

AUTO_YES=0
if [[ "${1:-}" == "--yes" ]]; then AUTO_YES=1; fi

# Candidate command-body shapes. Ordered safest → most speculative.
#
#   1-2: known SHP2 setter shape with empty params — proves the cmdCode
#        protocol is reachable. Expected outcome: accepted-but-no-op,
#        or "missing required param" with a clearer code than 8524.
#   3-7: speculative cmdCode values that follow EcoFlow's naming pattern
#        for SHP2. None are documented — pure guesswork.
#   8-9: legacy SHP1 moduleType/operateType shape, in case SHP2 still
#        understands it for system-level operations.
#  10:   DPU cmdSet/cmdId shape (the original v0.9.6 attempt) for
#        reference — should still fail 8524.
CANDIDATES=(
  '{"cmdCode":"PD303_APP_SET","params":{}}'
  '{"cmdCode":"PD303_APP_SET","params":{"backupReserveSoc":20}}'
  '{"cmdCode":"PD303_REBOOT","params":{}}'
  '{"cmdCode":"PD303_APP_REBOOT","params":{}}'
  '{"cmdCode":"PD303_RESET","params":{}}'
  '{"cmdCode":"PD303_SYS_REBOOT","params":{}}'
  '{"cmdCode":"PD303_APP_SET","params":{"reboot":1}}'
  '{"moduleType":1,"operateType":"reboot","params":{}}'
  '{"moduleType":1,"operateType":"powerOff","params":{}}'
  '{"cmdSet":11,"cmdId":17,"params":{}}'
)

echo "── EcoFlow SHP2 reboot probe ──────────────────────────────────────"
echo "  PANEL_URL : ${PANEL_URL}"
echo "  SHP2_SN   : ${SHP2_SN}"
echo "  candidates: ${#CANDIDATES[@]}"
echo "──────────────────────────────────────────────────────────────────"

i=0
for body in "${CANDIDATES[@]}"; do
  i=$((i+1))
  echo
  echo "[$i/${#CANDIDATES[@]}] ${body}"
  if (( AUTO_YES == 0 )); then
    read -r -p "    Send? [y/N/q] " ans
    case "$ans" in
      y|Y) ;;
      q|Q) echo "    Aborted by user."; exit 0;;
      *)   echo "    Skipped."; continue;;
    esac
  fi

  # Wrap in the send-command envelope { sn, body }
  envelope=$(printf '{"sn":"%s","body":%s}' "$SHP2_SN" "$body")

  resp=$(curl -sS -X POST \
    -H "Content-Type: application/json" \
    -H "x-write-debug-token: ${WRITE_DEBUG_TOKEN}" \
    --data "$envelope" \
    "${PANEL_URL%/}/api/device/send-command" \
    -w "\n__HTTP__:%{http_code}\n") || resp="(curl failed)"

  http=$(printf '%s\n' "$resp" | sed -n 's/^__HTTP__://p' | tr -d '\r\n')
  body_out=$(printf '%s\n' "$resp" | sed '/^__HTTP__:/d')
  # Pretty-print outcome / code / message if jq is around; raw otherwise.
  if command -v jq >/dev/null 2>&1; then
    summary=$(printf '%s\n' "$body_out" | jq -rc '{outcome, code, message, durationMs}' 2>/dev/null || echo "$body_out")
  else
    summary="$body_out"
  fi
  echo "    HTTP ${http}  →  ${summary}"

  # Be polite to EcoFlow; don't hammer if a real reboot lands.
  sleep 2
done

echo
echo "Done. If any probe returned code 0, that's the working shape — wire it"
echo "into rebootShp2() in server/src/ecoflow/commands.ts. If they all returned"
echo "8524 / non-zero, the public IoT API likely doesn't expose SHP2 reboot."
