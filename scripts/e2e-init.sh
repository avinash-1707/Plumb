#!/bin/sh
# Runs /plumb-init headlessly on a fresh copy of examples/node-web and checks what it left behind:
#   - the verify skill validates, the gate and git hook are installed;
#   - the self-proof drove a feature and its evidence survived cleanup;
#   - nothing the run started is still running (containers, process groups);
#   - a second /plumb-init changes no tracked file.
# Needs Claude Code (`claude`, logged in or with CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY set), Docker, and pnpm.
# Usage: scripts/e2e-init.sh [work-dir]   (default: a new temp dir; kept afterwards for inspection)
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd -P)
work=${1:-$(mktemp -d "${TMPDIR:-/tmp}/plumb-e2e.XXXXXX")}
app="$work/app"
plumb="$repo/plugin/bin/plumb"
budget=${PLUMB_E2E_BUDGET_USD:-15}
fail() { echo "✗ $*" >&2; exit 1; }

containers_before=$(docker ps -q | sort)

echo "== copying the example to $app"
rm -rf "$app" && mkdir -p "$app"
(cd "$repo/examples/node-web" && git ls-files -z . | grep -zv '^\.plumb-golden/' | tar --null -T - -cf -) | tar -xf - -C "$app"
cd "$app"
git init -q && git add -A && git -c user.name=e2e -c user.email=e2e@plumb -c commit.gpgsign=false commit -qm init
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @node-web/web exec playwright install ${PLUMB_E2E_PLAYWRIGHT_DEPS:+--with-deps} chromium >/dev/null

run_init() {
  claude -p "/plumb:plumb-init" --plugin-dir "$repo/plugin" --permission-mode dontAsk \
    --allowedTools "Bash(plumb *)" "Bash(.plumb/bin/doctor *)" "Bash(curl *)" "Bash(node *)" Read Glob Grep Write Edit Agent \
    --max-budget-usd "$budget" --no-session-persistence --output-format stream-json --verbose > "$work/$1.jsonl" 2> "$work/$1.err" ||
    fail "/plumb-init ($1) exited non-zero; transcript in $work/$1.jsonl"
}

echo "== /plumb-init (first run)"
run_init init-1

echo "== checking the result"
"$plumb" verify --validate || fail "the verify skill doesn't validate"
"$plumb" status --json > "$work/status.json"
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const problems = [];
  if (!s.initialized) problems.push("not initialized");
  if (s.skill === null) problems.push("no published verify skill");
  if (!s.gate.present) problems.push("no .plumb/gate.sh");
  if (s.hooks === null) problems.push("git hook not installed");
  if (s.conflicts.length > 0) problems.push("conflicts: " + s.conflicts.join(", "));
  if (problems.length > 0) { console.error(problems.join("\n")); process.exit(1); }
' "$work/status.json" || fail "plumb status shows an incomplete setup"

proof=""
for dir in .plumb/evidence/run-*; do
  [ -f "$dir/report.json" ] && proof=$(basename "$dir")
done
[ -n "$proof" ] || fail "no self-proof run with a report.json under .plumb/evidence/"
# Cleanup is idempotent: run again, it re-checks that nothing survived and every artifact still exists.
"$plumb" verify --cleanup "$proof" || fail "self-proof run $proof: something survived teardown or evidence is missing"

containers_after=$(docker ps -q | sort)
[ "$containers_before" = "$containers_after" ] || fail "containers left running: $(docker ps --format '{{.Names}}')"

echo "== committing what init generated, then /plumb-init again"
# Through the installed git hook, like a user's commit.
git add -A && git -c user.name=e2e -c user.email=e2e@plumb -c commit.gpgsign=false commit -qm "Add Plumb" || fail "committing the generated files failed the gate"
run_init init-2
changes=$(git status --porcelain)
[ -z "$changes" ] || fail "the second /plumb-init changed tracked files:
$changes"

echo "✓ /plumb-init passed on the example (self-proof run $proof); work dir: $work"
