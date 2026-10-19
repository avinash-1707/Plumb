#!/bin/sh
# Plumb fast-tier gate, generated from .plumb/profile.json. Runs on every commit (git hook and Claude Code hook)
# and needs no Plumb install: only POSIX sh and git. `plumb gate --regenerate` rewrites the managed regions and
# keeps everything outside them.
# plumb:managed:start header
set -u
cd "$(dirname "$0")/.." || exit 2
TREE=$(git write-tree) || exit 2
STAMP=".plumb/stamps/fast-$TREE"
if [ -f "$STAMP" ] && [ -z "${PLUMB_DRY_RUN:-}" ]; then
  echo "plumb gate: this exact staged tree already passed"
  exit 0
fi
# Every staged change, deletions included: a commit that only deletes a module can still break its importers.
CHANGED=$(git diff --cached --name-only --relative)
STAGED_COUNT=$(printf '%s\n' "$CHANGED" | grep -c . || true)
LOGS=".plumb/evidence/gate-$TREE"
[ -n "${PLUMB_DRY_RUN:-}" ] || mkdir -p "$LOGS"

plumb_report() {
  step=$1; cmd=$2; scope=$3; log=$4
  {
    echo ""
    echo "✗ plumb gate failed: $step"
    echo ""
    echo "  step     $step ($cmd)"
    echo "  scope    $scope"
    echo "  log      $log"
    echo ""
    tail -n 20 "$log" | sed 's/^/  /'
    echo ""
    echo "  bypass (not recommended): git commit --no-verify"
  } >&2
}

# plumb_run <step> <cwd> <scope> <command>: runs one check, logs it, and stops the gate with the standard report.
plumb_run() {
  step=$1; dir=$2; scope=$3; cmd=$4
  if [ -n "${PLUMB_DRY_RUN:-}" ]; then
    echo "would run  $step: $cmd  (in $dir; $scope)"
    return 0
  fi
  log="$LOGS/$step.log"
  printf '$ %s\n# cwd: %s\n' "$cmd" "$dir" > "$log"
  if (cd "$dir" && sh -c "$cmd") >> "$log" 2>&1; then
    echo "✓ $step"
  else
    plumb_report "$step" "$cmd" "$scope" "$log"
    exit 1
  fi
}
# plumb:managed:end header

# plumb:managed:start trivial
{{plumb:trivial}}
# plumb:managed:end trivial

# plumb:managed:start checks
{{plumb:checks}}
# plumb:managed:end checks

# User checks below this line are preserved across regeneration.

# plumb:managed:start footer
if [ -n "${PLUMB_DRY_RUN:-}" ]; then
  echo "dry run: nothing was run or stamped"
  exit 0
fi
mkdir -p .plumb/stamps && : > "$STAMP"
# Keep the newest 50 fast stamps; deep stamps record live verifications and are left alone.
ls -t .plumb/stamps | grep '^fast-' | sed -n '51,$p' | while read -r old; do rm -f ".plumb/stamps/$old"; done
echo "plumb gate passed (stamped $TREE)"
# plumb:managed:end footer
