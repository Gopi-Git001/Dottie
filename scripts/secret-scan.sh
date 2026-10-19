#!/usr/bin/env bash
# Dottie secret scan (E01 draft for DOT-003/DOT-083; co-owned by E08 + E07; see the dottie-evidence-pack skill).
# Prints file:line and the NAME of the rule only, never the matched value. Exits 1 on any hit.
# Needs ripgrep (rg). Usage: scripts/secret-scan.sh [repo-root]
#
# Allowlist: scripts/secret-scan.allow. A hit is ignored only when the path AND the full line
# text match one entry. A different line in an allowlisted file, or the same line with any edit,
# still fails. There is no path-wide or pattern-wide exclusion.
set -uo pipefail
ROOT="${1:-.}"
cd "$ROOT" || exit 2
GLOBS=(--hidden -g '!.git/' -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/.venv/**')
hits=0

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ALLOWLIST="${SCRIPT_DIR}/secret-scan.allow"
declare -A ALLOW=()
if [[ -f "$ALLOWLIST" ]]; then
  allow_path=""
  while IFS= read -r allow_line || [[ -n "$allow_line" ]]; do
    if [[ "$allow_line" == '@@ '* ]]; then
      allow_path="${allow_line#@@ }"
    elif [[ -n "$allow_path" ]]; then
      ALLOW["${allow_path}"$'\n'"${allow_line}"]=1
      allow_path=""
    fi
  done < "$ALLOWLIST"
fi

allow_hit() { # path, full line text
  local path="${1#./}" content="$2"
  [[ -n "${ALLOW["${path}"$'\n'"${content}"]+x}" ]]
}

scan() { # name, pattern, paths...
  local name="$1" pat="$2"; shift 2
  local row path rest lineno content
  while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    path="${row%%:*}"
    rest="${row#*:}"
    lineno="${rest%%:*}"
    content="${rest#*:}"
    if allow_hit "$path" "$content"; then
      continue
    fi
    echo "HIT [$name] ${path#./}:$lineno"
    hits=1
  done < <(rg -n --no-heading --color never "${GLOBS[@]}" -e "$pat" "$@" 2>/dev/null || true)
}
# 1) Evidence dirs: the exact dottie-evidence-pack step-5 sweep. It must return nothing.
EVID=()
for d in docs/evidence scripts/week1-probe/linux-selftest; do [[ -d $d ]] && EVID+=("$d"); done
if ((${#EVID[@]})); then
  scan evidence-pack 'eyJ[A-Za-z0-9_-]{10,}|refresh_token|access_token|code_challenge|sk-[A-Za-z0-9_-]{16,}|Bearer |CANARY-' "${EVID[@]}"
fi
# 2) Whole repo: secret-shaped VALUES. Keywords on their own are allowed in code and docs.
scan jwt            'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}' .
scan openai-key     'sk-(proj-)?[A-Za-z0-9_-]{32,}' .
scan bearer-value   'Bearer [A-Za-z0-9._~+/-]{24,}' .
scan oauth-query    'auth\.openai\.com/[^ "'"'"'`)]*[?&](code_challenge|state|code)=[A-Za-z0-9_-]{16,}' .
scan token-json     '"(access_token|refresh_token|id_token|accessToken|refreshToken|idToken)"[[:space:]]*:[[:space:]]*"[A-Za-z0-9._-]{16,}"' .
scan canary         'CANARY-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}' .
scan private-key    '-----BEGIN [A-Z ]*PRIVATE KEY-----' .
scan windows-host   'DESKTOP-[A-Z0-9]{7}\b' .
# 3) Forbidden files.
while IFS= read -r f; do echo "HIT [forbidden-file] $f"; hits=1; done < <(
  find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type f \
    \( -name auth.json -o -name '.env' -o \( -name '.env.*' ! -name '.env.example' \) -o -name '*.pem' -o -name '*.pfx' -o -name '*.p12' \) -print)
# 4) Large files (> 2 MB) need an explicit decision.
while IFS= read -r f; do echo "HIT [large-file>2MB] $f"; hits=1; done < <(
  find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type f -size +2M -print)
if ((hits)); then echo "secret-scan: FAIL"; exit 1; fi
echo "secret-scan: PASS (0 hits)"
