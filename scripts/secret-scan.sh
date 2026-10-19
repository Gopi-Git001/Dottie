#!/usr/bin/env bash
set -euo pipefail
# Dottie secret scan (E01 draft for DOT-003/DOT-083; co-owned by E08 + E07; see the dottie-evidence-pack skill).
# Prints file:line and the NAME of the rule only, never the matched value. Exits 1 on any hit.
# Needs ripgrep (rg). Missing rg, or rg exiting 2 or higher, fails the scan (fail closed).
# rg exit 1 is the only "no matches" status.
# Usage: scripts/secret-scan.sh [--history A..B|FULL] [repo-root]
#   --history RANGE  also scan every added line in RANGE (two-dot, A..B).
#                    FULL scans every commit reachable from HEAD (a new branch, whose
#                    push has no "before" sha). An empty or unresolvable range fails.
#
# Allowlist: scripts/secret-scan.allow. A hit is ignored only when the path AND the full line
# text match one entry. A different line in an allowlisted file, or the same line with any edit,
# still fails. There is no path-wide or pattern-wide exclusion.
HISTORY=0
RANGE=""
ROOT="."
args=("$@")
i=0
while (( i < ${#args[@]} )); do
  arg="${args[$i]}"
  case "$arg" in
    --history)
      HISTORY=1
      i=$((i + 1))
      if (( i >= ${#args[@]} )); then
        echo "secret-scan: FAIL (history range is missing)" >&2
        exit 2
      fi
      RANGE="${args[$i]}"
      ;;
    --)
      ;;
    -*)
      echo "secret-scan: FAIL (unknown option: $arg)" >&2
      exit 2
      ;;
    *) ROOT="$arg" ;;
  esac
  i=$((i + 1))
done

# Resolve the script directory before cd. A relative BASH_SOURCE is based on the
# caller's cwd; after cd it would point at the scan root (for example smoke-logs).
source_path="${BASH_SOURCE[0]}"
source_dir="${source_path%/*}"
if [[ "$source_dir" == "$source_path" ]]; then
  source_dir="."
fi
SCRIPT_DIR=$(cd "$source_dir" && pwd) || {
  echo "secret-scan: FAIL (cannot locate scripts/)" >&2
  exit 2
}
cd "$ROOT" || exit 2

if ! command -v rg >/dev/null 2>&1; then
  echo "secret-scan: FAIL (rg is not installed)" >&2
  exit 2
fi

# --no-ignore: rg must not honor .gitignore. dist/, *.log and smoke-logs/ are ignored
# there, so a token in a build output or a smoke log would otherwise pass and could be
# uploaded. --hidden still searches dotfiles. --text searches binaries as text.
# The only exclusions are .git/ (object store, not source) and node_modules/ (the
# third-party install at runtime, not this repo).
GLOBS=(--hidden --no-ignore --text -g '!.git/**' -g '!**/.git/**' -g '!**/node_modules/**')
hits=0

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

# Run rg. Exit 1 (no matches) returns success to the caller. Exit 0 prints hits via the
# callback file. Exit 2+ fails the process.
run_rg() { # outfile, name, pattern, rg-args...
  local out="$1" name="$2" pat="$3"
  shift 3
  local err rc
  err=$(mktemp)
  set +e
  rg -n --no-heading --color never --text "${GLOBS[@]}" -e "$pat" "$@" >"$out" 2>"$err"
  rc=$?
  set -e
  if (( rc == 1 )); then
    rm -f "$err"
    return 1
  fi
  if (( rc != 0 )); then
    echo "secret-scan: FAIL (rg exited $rc for [$name])" >&2
    cat "$err" >&2
    rm -f "$err"
    exit 2
  fi
  rm -f "$err"
  return 0
}

note_hit() { # name, path, lineno, where
  local name="$1" path="$2" lineno="$3" where="${4:-}"
  if [[ -n "$where" ]]; then
    echo "HIT [$name] ${path#./}:$lineno ($where)"
  else
    echo "HIT [$name] ${path#./}:$lineno"
  fi
  hits=1
}

scan() { # name, pattern, paths...
  local name="$1" pat="$2"
  shift 2
  local out row path rest lineno content
  out=$(mktemp)
  if ! run_rg "$out" "$name" "$pat" "$@"; then
    rm -f "$out"
    return 0
  fi
  while IFS= read -r row || [[ -n "$row" ]]; do
    [[ -z "$row" ]] && continue
    path="${row%%:*}"
    rest="${row#*:}"
    lineno="${rest%%:*}"
    content="${rest#*:}"
    if allow_hit "$path" "$content"; then
      continue
    fi
    note_hit "$name" "$path" "$lineno"
  done < "$out"
  rm -f "$out"
}

# Added lines in the history range passed by the caller.
# content file: one added line of text per record (this is what rg searches).
# index file:  path<US>lineno on the same record. Paths are not searched: a name
# such as task-….json contains "sk-" plus a long suffix and is not a secret value.
# +++ / --- are file headers only inside the diff header block (right after
# diff --git). An added line whose text starts with "++ " is a normal addition.
extract_added_lines() {
  local content_file="$1" index_file="$2" raw rc err count left right
  if ! command -v git >/dev/null 2>&1; then
    echo "secret-scan: FAIL (git is not installed; history was not scanned)" >&2
    exit 2
  fi
  if [[ -z "$RANGE" ]]; then
    echo "secret-scan: FAIL (history range is empty)" >&2
    exit 2
  fi
  local -a log_spec=()
  if [[ "$RANGE" == "FULL" ]]; then
    if ! git rev-parse --verify --quiet HEAD >/dev/null; then
      echo "secret-scan: FAIL (history range is unresolvable: FULL)" >&2
      exit 2
    fi
    log_spec=(HEAD)
  else
    if [[ "$RANGE" == *...* || "$RANGE" != *..* ]]; then
      echo "secret-scan: FAIL (history range must be A..B, got: $RANGE)" >&2
      exit 2
    fi
    left="${RANGE%%..*}"
    right="${RANGE#*..}"
    if [[ -z "$left" || -z "$right" ]]; then
      echo "secret-scan: FAIL (history range is empty: $RANGE)" >&2
      exit 2
    fi
    if ! git rev-parse --verify --quiet "${left}^{commit}" >/dev/null; then
      echo "secret-scan: FAIL (history range is unresolvable: $left)" >&2
      exit 2
    fi
    if ! git rev-parse --verify --quiet "${right}^{commit}" >/dev/null; then
      echo "secret-scan: FAIL (history range is unresolvable: $right)" >&2
      exit 2
    fi
    log_spec=("$RANGE")
  fi
  set +e
  count=$(git rev-list --count "${log_spec[@]}")
  rc=$?
  set -e
  if (( rc != 0 )); then
    echo "secret-scan: FAIL (history range is unresolvable: $RANGE)" >&2
    exit 2
  fi
  if [[ "$count" -eq 0 ]]; then
    echo "secret-scan: FAIL (history range is empty: $RANGE)" >&2
    exit 2
  fi
  raw=$(mktemp)
  err=$(mktemp)
  set +e
  # --text: a binary added and later removed still contributes its added lines.
  git --no-pager -c core.quotepath=false log -p --text --format= --no-color "${log_spec[@]}" >"$raw" 2>"$err"
  rc=$?
  set -e
  if (( rc != 0 )); then
    echo "secret-scan: FAIL (git log exited $rc; history was not scanned)" >&2
    cat "$err" >&2
    rm -f "$raw" "$err"
    exit 2
  fi
  rm -f "$err"
  awk -v content_file="$content_file" -v index_file="$index_file" '
    BEGIN { in_header = 0; path = ""; lineno = 0 }
    /^diff --git / { in_header = 1; path = ""; next }
    in_header && /^--- / { next }
    in_header && /^\+\+\+ / {
      path = substr($0, 5)
      sub(/\r$/, "", path)
      if (path == "/dev/null") { path = ""; next }
      if (substr(path, 1, 1) == "\"") {
        sub(/^"/, "", path)
        sub(/"$/, "", path)
      }
      if (substr(path, 1, 2) == "b/") path = substr(path, 3)
      next
    }
    /^@@ / {
      in_header = 0
      plus = $0
      sub(/^.*\+/, "", plus)
      sub(/[^0-9].*/, "", plus)
      lineno = plus + 0
      next
    }
    /^\+/ {
      if (path == "") next
      content = substr($0, 2)
      sub(/\r$/, "", content)
      print content >> content_file
      printf "%s\037%s\n", path, lineno >> index_file
      lineno++
      next
    }
    /^ / {
      if (path != "") lineno++
      next
    }
  ' "$raw"
  rm -f "$raw"
}

scan_added() { # name, pattern, content-file, index-file, scope (all|evidence)
  local name="$1" pat="$2" file="$3" index="$4" scope="$5"
  local out err rc row nrec index_line path lineno content
  [[ -s "$file" ]] || return 0
  out=$(mktemp)
  err=$(mktemp)
  set +e
  rg -n --no-heading --color never --text -e "$pat" "$file" >"$out" 2>"$err"
  rc=$?
  set -e
  if (( rc == 1 )); then
    rm -f "$out" "$err"
    return 0
  fi
  if (( rc != 0 )); then
    echo "secret-scan: FAIL (rg exited $rc for [$name] history)" >&2
    cat "$err" >&2
    rm -f "$out" "$err"
    exit 2
  fi
  rm -f "$err"
  while IFS= read -r row || [[ -n "$row" ]]; do
    [[ -z "$row" ]] && continue
    nrec="${row%%:*}"
    content="${row#*:}"
    if ! [[ "$nrec" =~ ^[0-9]+$ ]]; then
      echo "secret-scan: FAIL (unparseable history hit for [$name])" >&2
      rm -f "$out"
      exit 2
    fi
    index_line=$(sed -n "${nrec}p" "$index")
    path="${index_line%%$'\037'*}"
    lineno="${index_line#*$'\037'}"
    if [[ "$scope" == evidence ]]; then
      case "$path" in
        docs/evidence/*|scripts/week1-probe/linux-selftest/*) ;;
        *) continue ;;
      esac
    fi
    if allow_hit "$path" "$content"; then
      continue
    fi
    note_hit "$name" "$path" "$lineno" "history"
  done < "$out"
  rm -f "$out"
}

# Value-shaped rules. A bare prefix in prose (ghp_, AIza, AKIA, xoxb-) is not a hit.
EVIDENCE_PAT='eyJ[A-Za-z0-9_-]{10,}|refresh_token|access_token|code_challenge|sk-[A-Za-z0-9_-]{16,}|Bearer |CANARY-'
JWT_PAT='eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}'
OPENAI_PAT='sk-(proj-)?[A-Za-z0-9_-]{32,}'
BEARER_PAT='Bearer [A-Za-z0-9._~+/-]{24,}'
OAUTH_PAT='auth\.openai\.com/[^ "'"'"'`)]*[?&](code_challenge|state|code)=[A-Za-z0-9_-]{16,}'
TOKEN_JSON_PAT='"(access_token|refresh_token|id_token|accessToken|refreshToken|idToken)"[[:space:]]*:[[:space:]]*"[A-Za-z0-9._-]{16,}"'
CANARY_PAT='CANARY-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}'
PRIVATE_KEY_PAT='-----BEGIN [A-Z ]*PRIVATE KEY-----'
WINDOWS_HOST_PAT='DESKTOP-[A-Z0-9]{7}\b'
GITHUB_TOKEN_PAT='g(hp|ho|hs|hu|hr)_[A-Za-z0-9]{36}'
GITHUB_FINE_PAT='github_pat_[A-Za-z0-9_]{22,}'
AWS_ACCESS_KEY_PAT='(AKIA|ASIA)[A-Z0-9]{16}'
AWS_SECRET_PAT='aws_secret_access_key[[:space:]]*=[[:space:]]*[A-Za-z0-9/+=]{20,}'
SLACK_PAT='xox[abpors]-[A-Za-z0-9-]{10,}'
NPM_PAT='_authToken[[:space:]]*=[[:space:]]*[A-Za-z0-9/+_.=-]{8,}'
GOOGLE_PAT='AIza[0-9A-Za-z_-]{35}'

# 1) Evidence dirs: the exact dottie-evidence-pack step-5 sweep. It must return nothing.
EVID=()
for d in docs/evidence scripts/week1-probe/linux-selftest; do [[ -d $d ]] && EVID+=("$d"); done
if ((${#EVID[@]})); then
  scan evidence-pack "$EVIDENCE_PAT" "${EVID[@]}"
fi
# 2) Whole repo: secret-shaped VALUES. Keywords on their own are allowed in code and docs.
scan jwt "$JWT_PAT" .
scan openai-key "$OPENAI_PAT" .
scan bearer-value "$BEARER_PAT" .
scan oauth-query "$OAUTH_PAT" .
scan token-json "$TOKEN_JSON_PAT" .
scan canary "$CANARY_PAT" .
scan private-key "$PRIVATE_KEY_PAT" .
scan windows-host "$WINDOWS_HOST_PAT" .
scan github-token "$GITHUB_TOKEN_PAT" .
scan github-fine "$GITHUB_FINE_PAT" .
scan aws-access-key "$AWS_ACCESS_KEY_PAT" .
scan aws-secret-key "$AWS_SECRET_PAT" .
scan slack-token "$SLACK_PAT" .
scan npm-auth-token "$NPM_PAT" .
scan google-api-key "$GOOGLE_PAT" .

if (( HISTORY )); then
  added_content=$(mktemp)
  added_index=$(mktemp)
  extract_added_lines "$added_content" "$added_index"
  scan_added evidence-pack "$EVIDENCE_PAT" "$added_content" "$added_index" evidence
  scan_added jwt "$JWT_PAT" "$added_content" "$added_index" all
  scan_added openai-key "$OPENAI_PAT" "$added_content" "$added_index" all
  scan_added bearer-value "$BEARER_PAT" "$added_content" "$added_index" all
  scan_added oauth-query "$OAUTH_PAT" "$added_content" "$added_index" all
  scan_added token-json "$TOKEN_JSON_PAT" "$added_content" "$added_index" all
  scan_added canary "$CANARY_PAT" "$added_content" "$added_index" all
  scan_added private-key "$PRIVATE_KEY_PAT" "$added_content" "$added_index" all
  scan_added windows-host "$WINDOWS_HOST_PAT" "$added_content" "$added_index" all
  scan_added github-token "$GITHUB_TOKEN_PAT" "$added_content" "$added_index" all
  scan_added github-fine "$GITHUB_FINE_PAT" "$added_content" "$added_index" all
  scan_added aws-access-key "$AWS_ACCESS_KEY_PAT" "$added_content" "$added_index" all
  scan_added aws-secret-key "$AWS_SECRET_PAT" "$added_content" "$added_index" all
  scan_added slack-token "$SLACK_PAT" "$added_content" "$added_index" all
  scan_added npm-auth-token "$NPM_PAT" "$added_content" "$added_index" all
  scan_added google-api-key "$GOOGLE_PAT" "$added_content" "$added_index" all
  rm -f "$added_content" "$added_index"
fi

# 3) Forbidden files.
while IFS= read -r f; do echo "HIT [forbidden-file] $f"; hits=1; done < <(
  find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type f \
    \( -name auth.json -o -name '.env' -o \( -name '.env.*' ! -name '.env.example' \) -o -name '*.pem' -o -name '*.pfx' -o -name '*.p12' \) -print)
# 4) Large files (> 2 MB) need an explicit decision.
while IFS= read -r f; do echo "HIT [large-file>2MB] $f"; hits=1; done < <(
  find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type f -size +2M -print)
if ((hits)); then echo "secret-scan: FAIL"; exit 1; fi
echo "secret-scan: PASS (0 hits)"
