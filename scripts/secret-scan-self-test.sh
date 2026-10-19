#!/usr/bin/env bash
# Plants fake tokens at runtime and asserts secret-scan.sh fails closed on them.
# Prefixes are built from character codes so this file never contains a literal token.
# Two placements, each cleaned up before exit:
#   (a) a new untracked file
#   (b) an extra line on an allowlisted file (not the allowlisted line)
set -euo pipefail
cd "$(dirname "$0")/.."

canary="scripts/secret-scan-canary.txt"
target="packages/codex-adapter/test/units.test.ts"
backup=""

cleanup() {
  local status=$?
  rm -f "$canary"
  if [[ -n "$backup" && -f "$backup" ]]; then
    mv -f "$backup" "$target" || status=1
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

expect_fail() {
  local log="$1"
  set +e
  bash scripts/secret-scan.sh --history . >"$log" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo "self-test: scan passed while a canary was planted" >&2
    cat "$log" >&2
    exit 1
  fi
  if [[ "$rc" -ge 2 ]]; then
    echo "self-test: scan errored (exit $rc) instead of reporting the canary" >&2
    cat "$log" >&2
    exit 1
  fi
  if ! grep -q 'secret-scan: FAIL' "$log"; then
    echo "self-test: scan exit $rc did not report FAIL" >&2
    cat "$log" >&2
    exit 1
  fi
}

log=$(mktemp)

# (a) New file. Every new rule must fire, and nothing else may.
printf '%s\n' "$ghp" "$gho" "$ghs" "$ghu" "$ghr" "$fine" "$akia" "$asia" "$aws" "$slack" "$npm" "$google" >"$canary"
expect_fail "$log"
for rule in github-token github-fine aws-access-key aws-secret-key slack-token npm-auth-token google-api-key; do
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
if grep 'HIT ' "$log" | grep -v "$canary:" | grep -q .; then
  echo "self-test: temp-file run reported a hit outside the canary" >&2
  cat "$log" >&2
  exit 1
fi
rm -f "$canary"

# (b) A different line of an allowlisted file. The allowlisted jwt line must not be the cause.
backup=$(mktemp)
cp "$target" "$backup"
printf '\n%s\n' "$slack" >>"$target"
expect_fail "$log"
if ! grep -q "HIT \\[slack-token\\] $target:" "$log"; then
  echo "self-test: extra line on the allowlisted file did not trip slack-token" >&2
  cat "$log" >&2
  exit 1
fi
if grep 'HIT ' "$log" | grep -v "$target:" | grep -q .; then
  echo "self-test: allowlisted-file run reported a hit outside that file" >&2
  cat "$log" >&2
  exit 1
fi
mv -f "$backup" "$target"
backup=""

rm -f "$log"
echo "secret-scan self-test: PASS (canaries failed the scan and were removed)"
