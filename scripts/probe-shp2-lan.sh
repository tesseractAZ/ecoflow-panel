#!/usr/bin/env bash
# scripts/probe-shp2-lan.sh — read-only LAN probe of an EcoFlow SHP2 (or any
# EcoFlow device) to surface anything it exposes locally. Nothing here writes
# to the device, fuzzes, or MITMs — it just observes what's already listening.
#
# Usage: scripts/probe-shp2-lan.sh <ip>
#
# Find the SHP2's IP via your router's DHCP lease page, `arp -a`, or the
# EcoFlow mobile app (Device info → Network).
#
# What it does (~2 min):
#   1. Ping + ARP/MAC
#   2. mDNS / Bonjour service browse (5 s × a few common types)
#   3. SSDP / UPnP M-SEARCH multicast (2 s)
#   4. nmap top-1000 TCP scan with service version detection
#   4b. nmap UDP probe on IoT-common ports
#   5. HTTP path probes on every open TCP port (~17 common paths)
#   6. TLS cert dump on every open TCP port that speaks TLS
#
# Output: data/lan-probe-<ip>-<timestamp>.md, plus a short stdout summary.
#
# Requires: nmap, curl, openssl. Optional but recommended:
#   - macOS:  brew install coreutils  (provides `gtimeout`)
#   - Linux:  apt install avahi-utils  (provides `avahi-browse`)

set -euo pipefail

# ── args ─────────────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]] || [[ "${1:-}" =~ ^(-h|--help)$ ]]; then
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
IP="$1"
if ! [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: '$IP' doesn't look like an IPv4 address" >&2
  exit 1
fi

# ── paths + helpers ──────────────────────────────────────────────────────────
TS="$(date +%Y%m%d-%H%M%S)"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${REPO_ROOT}/data"
mkdir -p "$OUT_DIR"
OUT="${OUT_DIR}/lan-probe-${IP}-${TS}.md"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

have() { command -v "$1" >/dev/null 2>&1; }
log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
emit() { printf '%s\n' "$*" >> "$OUT"; }

# Portable timeout wrapper: BSD `timeout` doesn't exist; coreutils ships
# `gtimeout`. Linux ships `timeout`. Fall back to running uncapped if neither.
TIMEOUT_CMD=""
if   have timeout;  then TIMEOUT_CMD="timeout"
elif have gtimeout; then TIMEOUT_CMD="gtimeout"
else warn "no 'timeout' or 'gtimeout' — probes may hang longer (brew install coreutils)"
fi
tm() {
  local secs="$1"; shift
  if [[ -n "$TIMEOUT_CMD" ]]; then "$TIMEOUT_CMD" "$secs" "$@"
  else                              "$@"
  fi
}

# ── header ───────────────────────────────────────────────────────────────────
{
  echo "# SHP2 LAN probe — \`${IP}\`"
  echo
  echo "Generated: \`${TS}\`"
  echo "Host: \`$(uname -srn)\`"
  echo "nmap: \`$(have nmap && nmap --version | head -1 || echo 'missing')\`"
  echo
} > "$OUT"

log "probing ${IP} → ${OUT}"

# ── 1. reachability + MAC ────────────────────────────────────────────────────
emit "## 1. Reachability"
emit
if ping -c 2 -W 2 "${IP}" >/dev/null 2>&1; then
  emit "- ICMP echo: ✅"
  log "ping ok"
else
  emit "- ICMP echo: ❌ (host may filter ICMP — continuing anyway)"
  warn "ping failed"
fi
MAC="$(arp -n "${IP}" 2>/dev/null | awk '/at/{print $4}' | head -1 || true)"
[[ -n "${MAC}" ]] && emit "- MAC: \`${MAC}\`"
emit

# ── 2. mDNS / Bonjour ────────────────────────────────────────────────────────
emit "## 2. mDNS / Bonjour service advertisements"
emit
if have dns-sd; then
  emit "_macOS \`dns-sd\`, 5 s browse per service type:_"
  emit '```'
  for type in _http._tcp _https._tcp _mqtt._tcp _ecoflow._tcp _iotdevice._tcp _coap._udp _services._dns-sd._udp; do
    {
      printf '── %s ──\n' "$type"
      tm 5 dns-sd -B "$type" local. 2>&1 | sed -n '4,30p' | sed 's/^/  /'
    } >> "$OUT" || true
  done
  emit '```'
  log "mdns done"
elif have avahi-browse; then
  emit "_Linux \`avahi-browse\`, 5 s:_"
  emit '```'
  tm 5 avahi-browse -a -r -t 2>&1 | head -200 >> "$OUT" || true
  emit '```'
  log "mdns done"
else
  emit "_(no \`dns-sd\` / \`avahi-browse\` on this host — skipped)_"
  warn "no mDNS tool"
fi
emit

# ── 3. SSDP / UPnP ───────────────────────────────────────────────────────────
emit "## 3. SSDP / UPnP M-SEARCH"
emit
emit "_Responses are from every UPnP device on the LAN (router, TVs, printers) — look for one whose IP matches \`${IP}\`._"
emit '```'
{
  printf 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n' \
    | tm 3 nc -u -w 2 239.255.255.250 1900 2>&1 | head -200
} >> "$OUT" || true
emit '```'
log "ssdp done"
emit

# ── 4. nmap top-1000 TCP + service detection ─────────────────────────────────
emit "## 4. nmap TCP scan (top 1000 ports + version detection)"
emit
if have nmap; then
  emit '```'
  # tee so we can extract open ports for the HTTP/TLS probes below
  nmap -T3 --top-ports 1000 -sV --version-light "${IP}" 2>&1 \
    | tee "${TMP}/nmap.txt" >> "$OUT" || true
  emit '```'
  log "nmap tcp done"
else
  emit "⚠ \`nmap\` not installed — \`brew install nmap\` (macOS) or \`apt install nmap\` (Linux). Most of this probe is meaningless without it."
  : > "${TMP}/nmap.txt"
fi
emit

emit "## 4b. nmap UDP probe (handful of IoT-common ports)"
emit
if have nmap; then
  emit "_( \`-sU\` typically needs root; without it some ports show as \`open|filtered\`. Run with \`sudo\` for cleaner UDP results. )_"
  emit '```'
  nmap -sU -p 53,67,68,123,161,500,1900,5353,5683,5684 "${IP}" 2>&1 >> "$OUT" || true
  emit '```'
fi
emit

# ── 5. HTTP path probes ──────────────────────────────────────────────────────
emit "## 5. HTTP path probes on every open TCP port"
emit
PORTS="$(grep -E '^[0-9]+/tcp[[:space:]]+open' "${TMP}/nmap.txt" 2>/dev/null | awk -F/ '{print $1}' | sort -un || true)"
if [[ -z "$PORTS" ]]; then
  emit "_(no open TCP ports from nmap; skipping HTTP probes)_"
else
  PATHS=(/ /api /api/v1 /api/v2 /v1 /v2 /status /info /health /version /config /setup /device /system /index.html /admin /metrics)
  for PORT in $PORTS; do
    # Decide if HTTP or HTTPS reaches this port by trying root first.
    SCHEME=""
    for s in http https; do
      CODE="$(curl -ksS -m 2 -o /dev/null -w '%{http_code}' "${s}://${IP}:${PORT}/" 2>/dev/null || true)"
      if [[ -n "${CODE}" && "${CODE}" != "000" ]]; then
        SCHEME="$s"
        break
      fi
    done
    if [[ -z "$SCHEME" ]]; then continue; fi

    emit
    emit "### Port ${PORT} (${SCHEME})"
    emit
    HITS=0
    for P in "${PATHS[@]}"; do
      RESP="$(curl -ksS -m 2 -o "${TMP}/body" -w '%{http_code} ct=%{content_type} bytes=%{size_download}' "${SCHEME}://${IP}:${PORT}${P}" 2>/dev/null || echo 'curl-err')"
      CODE="${RESP%% *}"
      if [[ "${CODE}" =~ ^(200|301|302|401|403|405|503)$ ]]; then
        HITS=$((HITS + 1))
        emit "- \`${P}\` → **${RESP}**"
        BODY="$(head -c 400 "${TMP}/body" 2>/dev/null | tr -d '\0\r' | head -3 || true)"
        if [[ -n "$BODY" ]]; then
          emit '  ```'
          while IFS= read -r line; do emit "  ${line}"; done <<< "$BODY"
          emit '  ```'
        fi
      fi
    done
    [[ $HITS -eq 0 ]] && emit "_(no interesting paths)_"
  done
  log "http done"
fi
emit

# ── 6. TLS cert dump on every open TCP port ──────────────────────────────────
emit "## 6. TLS certs (per open TCP port that completes a handshake)"
emit
if [[ -n "${PORTS:-}" ]]; then
  ANY_TLS=0
  for PORT in $PORTS; do
    CERT="$(tm 3 openssl s_client -connect "${IP}:${PORT}" -servername "${IP}" </dev/null 2>/dev/null \
            | openssl x509 -noout -subject -issuer -dates -fingerprint 2>/dev/null || true)"
    if [[ -n "$CERT" ]]; then
      ANY_TLS=1
      emit
      emit "### Port ${PORT}"
      emit '```'
      while IFS= read -r line; do emit "${line}"; done <<< "$CERT"
      emit '```'
    fi
  done
  [[ $ANY_TLS -eq 0 ]] && emit "_(no TLS handshake completed on any open port)_"
else
  emit "_(no open ports; skipped)_"
fi
emit

# ── 7. summary + what to look for ────────────────────────────────────────────
emit "## Summary — what to look for"
emit
emit "- **HTTP path returning 200/401/403** that isn't a generic web server → candidate local API. Pay attention to anything with \`/api\`, \`/device\`, or JSON \`content-type\`."
emit "- **mDNS service** advertising \`_ecoflow._tcp\`, \`_iotdevice._tcp\`, or any vendor-specific prefix → starting point for reverse engineering."
emit "- **Open MQTT port** (1883 or 8883) that completes a TLS handshake → potential local broker. The MQTT-MITM route to true local control opens here."
emit "- **TLS cert** mentioning EcoFlow or Amazon (AWS IoT) → cloud-managed device, but the cert chain itself is useful intel for the MITM path."
emit "- **CoAP** (5683 UDP) open → another IoT-common protocol worth investigating."
emit
emit "Re-run after each firmware update — newly-exposed services would show up here first."

# ── stdout summary ───────────────────────────────────────────────────────────
echo
log "report → \033[97m${OUT}\033[0m"
echo
echo "── what nmap saw (open TCP ports) ──"
grep -E '^[0-9]+/tcp[[:space:]]+open' "${TMP}/nmap.txt" 2>/dev/null || echo "(none)"
echo
echo "── candidate URLs to eyeball first ──"
grep -E '^- `/' "$OUT" | head -10 || echo "(none — no interesting HTTP paths)"
echo
log "done"
