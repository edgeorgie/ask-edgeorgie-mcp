#!/usr/bin/env bash
# Mutation battery for the critic's findings. Each mutation reintroduces the
# exact defeat the critic measured; the guard must now FAIL on it.
# Usage: bash scripts/mutation-battery.sh   (cds to repo root itself)
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0; fail=0
snapshot() { cp src/engine.ts /tmp/mb-engine.ts; cp data/BUILD-LOG.md /tmp/mb-bl.md;
             cp examples/transcript.json /tmp/mb-stdio.json;
             cp examples/http-transcript.json /tmp/mb-http.json; }
restore()  { cp /tmp/mb-engine.ts src/engine.ts; cp /tmp/mb-bl.md data/BUILD-LOG.md;
             cp /tmp/mb-stdio.json examples/transcript.json;
             cp /tmp/mb-http.json examples/http-transcript.json; }

# $1 = label, $2 = expectation (fail|pass), $3 = command producing the verdict
check() {
  local label="$1" want="$2"; shift 2
  local out rc
  out=$("$@" 2>&1); rc=$?
  local got="pass"; [ $rc -ne 0 ] && got="fail"
  if [ "$got" = "$want" ]; then
    echo "  OK   [$label] guard=$got (wanted $want)"; pass=$((pass+1))
  else
    echo "  MISS [$label] guard=$got (wanted $want)"; fail=$((fail+1))
    echo "$out" | grep -E "AssertionError|claims|NOT FOUND|could NOT|DRIFT" | head -3 | sed 's/^/        /'
  fi
}

suite() { npm test >/dev/null 2>&1; }
external() { npm run --silent check:external >/dev/null 2>&1; }

echo "=== baseline (everything must PASS) ==="
snapshot
check "baseline suite"    pass suite
check "baseline external" pass external

echo
echo "=== F1: reworded claim must be UNCHECKED, not clean (checker) ==="
sed -i 's/0 open issues on the repo as of 2026-10-11/7 open issues on the tracker as of 2026-10-11/' src/engine.ts
check "reworded open-issues claim" fail external
restore

echo
echo "=== F2: thousands separator must not defeat the stars check ==="
# Pattern has NO trailing period: the real prose reads "0 GitHub stars," and an
# earlier version of this line matched nothing, which scored as a guard MISS
# when the guard was never exercised. A mutation that does not apply is a bug
# in the battery, not a passing guard — hence the applied-check below.
sed -i 's/0 GitHub stars/1,000 GitHub stars/' src/engine.ts
grep -q "1,000 GitHub stars" src/engine.ts || { echo "  BATTERY BUG [F2] mutation did not apply"; fail=$((fail+1)); }
check "stars '1,000' vs live 0" fail external
restore

echo
echo "=== F3: dated decoy must not hijack the download match ==="
sed -i 's/The download count is a lifetime total/The retrieval index covers 1266 as of 2026-10-11. The download count is a lifetime total/' src/engine.ts
check "decoy + rotten real figure" fail suite
restore

echo
echo "=== F4: undated figure reintroduced alongside the dated one ==="
sed -i 's/which is the shape of registry mirrors/npm reports 754 downloads, which is the shape of registry mirrors/' src/engine.ts
check "undated 754 alongside dated" fail suite
restore

echo
echo "=== F5: forged provenance in the stdio transcript ==="
# Must target a `source` INSIDE the get_projects payload. An earlier version
# used `0,/"source": "/` which hit the first of 30 occurrences — one in
# get_experience, a section this guard deliberately does not cover — so it
# scored a MISS against a guard that was never given a projects-level forgery.
sed -i 's|"source": "progress.log 2026-10-09 entries (triage-desk sections)|"source": "independently audited by a third-party firm (triage-desk sections)|' examples/transcript.json
grep -q "independently audited by a third-party firm" examples/transcript.json || { echo "  BATTERY BUG [F5] mutation did not apply"; fail=$((fail+1)); }
check "forged \`source\` provenance" fail suite
restore

echo
echo "=== F6: stale transcript (lag bound) ==="
sed -i '0,/"ranAt": "/s//"ranAt": "2025-01-01T00:00:00.000Z", "_ranAtReal": "/' examples/http-transcript.json
check "ranAt 600+ days stale" fail suite
restore

echo
echo "=== restored state must be green again ==="
check "post-battery suite"    pass suite
check "post-battery external" pass external

echo
echo "RESULT: $pass expected, $fail unexpected"
[ $fail -eq 0 ] || exit 1
