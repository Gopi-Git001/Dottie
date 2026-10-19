#!/usr/bin/env bash
set -euo pipefail
# Plants fake tokens at runtime and asserts secret-scan.sh fails closed on them.
# Prefixes are built from character codes so this file never contains a literal token.
# Tree placements (cleaned up before exit):
#   (a) a new untracked file, including an sk- value
#   (b) an extra line on an allowlisted file (not the allowlisted line)
#   (c) dist/            (gitignored)
#   (d) a binary file    (NUL before the token)
#   (e) a .log under apps/desktop/smoke-logs/  (gitignored)
# History and fail-closed, in a scratch repo so the real tree stays clean:
#   a token added in one commit and removed in the next, including a line
#   that starts with "++ " and a binary blob
#   an empty range, an unresolvable range, and a missing rg
cd "$(dirname "$0")/.."

canary="scripts/secret-scan-canary.txt"
dist_canary="dist/secret-scan-canary.txt"
bin_canary="scripts/secret-scan-binary-canary.bin"
log_dir="apps/desktop/smoke-logs/secret-scan-self-test"
log_canary="${log_dir}/self_smoke-log_run001.log"
target="packages/codex-adapter/test/units.test.ts"
backup=""
hist_repo=""

cleanup() {
  local status=$?
  rm -f "$canary" "$dist_canary" "$bin_canary" "$log_canary"
  rmdir "$log_dir" 2>/dev/null || true
  if [[ -d dist ]]; then
    rmdir dist 2>/dev/null || true
  fi
  if [[ -n "$backup" && -f "$backup" ]]; then
    mv -f "$backup" "$target" || status=1
  fi
  if [[ -n "$hist_repo" ]]; then
    rm -rf "$hist_repo"
  fi
  exit "$status"
}
trap cleanup EXIT

repeat() {
  local char="$1" n="$2" i out=""
  for ((i = 0; i < n; i++)); do
    out+="$char"
  done
  printf '%s' "$out"
}

# printf %b reads octal escapes. The source stays free of token literals.
oct() { printf '%b' "$1"; }

ghp="$(oct '\147\150\160\137')$(repeat A 36)"
gho="$(oct '\147\150\157\137')$(repeat B 36)"
ghs="$(oct '\147\150\163\137')$(repeat C 36)"
ghu="$(oct '\147\150\165\137')$(repeat D 36)"
ghr="$(oct '\147\150\162\137')$(repeat E 36)"
fine="$(oct '\147\151\164\150\165\142\137\160\141\164\137')$(repeat a 22)_$(repeat b 59)"
akia="$(oct '\101\113\111\101')$(repeat A 16)"
asia="$(oct '\101\123\111\101')$(repeat B 16)"
aws="$(oct '\141\167\163\137\163\145\143\162\145\164\137\141\143\143\145\163\163\137\153\145\171=')$(repeat C 40)"
slack="$(oct '\170\157\170\142\055')$(repeat d 24)"
npm="$(oct '\137\141\165\164\150\124\157\153\145\156=')$(repeat e 32)"
google="$(oct '\101\111\172\141')$(repeat F 35)"
sk="$(oct '\163\153\055')$(repeat a 32)"

log=$(mktemp)

expect_fail() {
  local log_file="$1"
  shift
  set +e
  "$@" >"$log_file" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo "self-test: scan passed while a canary was planted" >&2
    cat "$log_file" >&2
    exit 1
  fi
  if [[ "$rc" -ge 2 ]]; then
    echo "self-test: scan errored (exit $rc) instead of reporting the canary" >&2
    cat "$log_file" >&2
    exit 1
  fi
  if ! grep -q 'secret-scan: FAIL' "$log_file"; then
    echo "self-test: scan exit $rc did not report FAIL" >&2
    cat "$log_file" >&2
    exit 1
  fi
}

expect_closed() {
  local needle="$1"
  shift
  set +e
  "$@" >"$log" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -eq 0 || "$rc" -eq 1 ]]; then
    echo "self-test: expected fail-closed (exit >= 2), got $rc" >&2
    cat "$log" >&2
    exit 1
  fi
  if ! grep -q "$needle" "$log"; then
    echo "self-test: fail-closed output missing [$needle]" >&2
    cat "$log" >&2
    exit 1
  fi
}

only_hits_in() {
  local path_needle="$1"
  if grep 'HIT ' "$log" | grep -v "$path_needle" | grep -q .; then
    echo "self-test: reported a hit outside $path_needle" >&2
    cat "$log" >&2
    exit 1
  fi
}

# Fail closed: rg missing. Builtins only, so an empty PATH still reaches the check.
expect_closed "rg is not installed" env PATH=/tmp/does-not-exist /bin/bash scripts/secret-scan.sh .

# Empty range and a range whose endpoint does not exist. Scratch repo, no canaries.
hist_repo=$(mktemp -d)
git -C "$hist_repo" init -q -b main
git -C "$hist_repo" config user.email scan@example.com
git -C "$hist_repo" config user.name scan
echo base >"$hist_repo/README"
git -C "$hist_repo" add README
git -C "$hist_repo" commit -q -m base
base=$(git -C "$hist_repo" rev-parse HEAD)
expect_closed "history range is empty" bash scripts/secret-scan.sh --history "${base}..${base}" "$hist_repo"
expect_closed "history range is unresolvable" bash scripts/secret-scan.sh --history "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..${base}" "$hist_repo"
# FULL is every commit reachable from HEAD, not a revision named FULL.
bash scripts/secret-scan.sh --history FULL "$hist_repo" >"$log"
if ! grep -q 'secret-scan: PASS' "$log"; then
  echo "self-test: FULL history of a clean scratch repo did not pass" >&2
  cat "$log" >&2
  exit 1
fi

# Token only in history: added, then removed. The text line starts with "++ "
# so a header-parser that treats every "+++ " as a file header would miss it.
# The blob has a NUL, so without git log --text it is "Binary files differ".
{
  printf '%s%s\n' '++ ' "$ghp"
  printf '%s\n' "$sk"
} >"$hist_repo/secret.txt"
python3 -c 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(sys.argv[2].encode() + b"\n\x00\xff")' "$hist_repo/secret.bin" "$slack"
git -C "$hist_repo" add secret.txt secret.bin
git -C "$hist_repo" commit -q -m add
git -C "$hist_repo" rm -q secret.txt secret.bin
git -C "$hist_repo" commit -q -m remove
head=$(git -C "$hist_repo" rev-parse HEAD)
if [[ -e "$hist_repo/secret.txt" || -e "$hist_repo/secret.bin" ]]; then
  echo "self-test: history fixture still has the token on disk" >&2
  exit 1
fi
expect_fail "$log" bash scripts/secret-scan.sh --history "${base}..${head}" "$hist_repo"
for needle in \
  "HIT \\[github-token\\] secret.txt:" \
  "HIT \\[openai-key\\] secret.txt:" \
  "HIT \\[slack-token\\] secret.bin:"
do
  if ! grep -q "$needle" "$log"; then
    echo "self-test: history canary missing [$needle]" >&2
    cat "$log" >&2
    exit 1
  fi
done
if ! grep 'HIT ' "$log" | grep -q '(history)'; then
  echo "self-test: history canary was not reported as history" >&2
  cat "$log" >&2
  exit 1
fi
rm -rf "$hist_repo"
hist_repo=""

# (c) gitignored dist/
mkdir -p dist
printf '%s\n' "$google" >"$dist_canary"
expect_fail "$log" bash scripts/secret-scan.sh .
if ! grep -q "HIT \\[google-api-key\\] $dist_canary:" "$log"; then
  echo "self-test: dist/ canary was not detected" >&2
  cat "$log" >&2
  exit 1
fi
only_hits_in "$dist_canary:"
rm -f "$dist_canary"
rmdir dist 2>/dev/null || true

# (d) binary file. The token sits after a NUL, which a non-text search skips.
python3 -c 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(b"\x00\x01" + sys.argv[2].encode() + b"\x00")' "$bin_canary" "$ghp"
expect_fail "$log" bash scripts/secret-scan.sh .
if ! grep -q "HIT \\[github-token\\] $bin_canary:" "$log"; then
  echo "self-test: binary canary was not detected" >&2
  cat "$log" >&2
  exit 1
fi
only_hits_in "$bin_canary:"
rm -f "$bin_canary"

# (e) gitignored smoke log
mkdir -p "$log_dir"
printf '%s\n' "$npm" >"$log_canary"
expect_fail "$log" bash scripts/secret-scan.sh .
if ! grep -q "HIT \\[npm-auth-token\\] $log_canary:" "$log"; then
  echo "self-test: smoke-logs canary was not detected" >&2
  cat "$log" >&2
  exit 1
fi
only_hits_in "$log_canary:"
rm -f "$log_canary"
rmdir "$log_dir" 2>/dev/null || true

# (a) New file. Every new rule must fire, including sk-, and nothing else may.
printf '%s\n' "$ghp" "$gho" "$ghs" "$ghu" "$ghr" "$fine" "$akia" "$asia" "$aws" "$slack" "$npm" "$google" "$sk" >"$canary"
expect_fail "$log" bash scripts/secret-scan.sh .
for rule in github-token github-fine aws-access-key aws-secret-key slack-token npm-auth-token google-api-key openai-key; do
  if ! grep -q "HIT \\[$rule\\] $canary:" "$log"; then
    echo "self-test: temp-file canary did not trip [$rule]" >&2
    cat "$log" >&2
    exit 1
  fi
done
gh_hits=$(grep -c 'HIT \[github-token\]' "$log" || true)
aws_hits=$(grep -c 'HIT \[aws-access-key\]' "$log" || true)
if [[ "$gh_hits" -ne 5 || "$aws_hits" -ne 2 ]]; then
  echo "self-test: expected 5 github-token hits and 2 aws-access-key hits, got $gh_hits and $aws_hits" >&2
  cat "$log" >&2
  exit 1
fi
only_hits_in "$canary:"
rm -f "$canary"

# (b) A different line of an allowlisted file. The allowlisted jwt line must not be the cause.
backup=$(mktemp)
cp "$target" "$backup"
printf '\n%s\n' "$slack" >>"$target"
expect_fail "$log" bash scripts/secret-scan.sh .
if ! grep -q "HIT \\[slack-token\\] $target:" "$log"; then
  echo "self-test: extra line on the allowlisted file did not trip slack-token" >&2
  cat "$log" >&2
  exit 1
fi
only_hits_in "$target:"
mv -f "$backup" "$target"
backup=""

rm -f "$log"
echo "secret-scan self-test: PASS (canaries failed the scan and were removed)"
