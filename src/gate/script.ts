import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { Command, Profile, ScopedCommand } from "../profile/types.ts";
import { withHashes } from "../managed/regions.ts";
import { render } from "../template.ts";

export const GATE_PATH = ".plumb/gate.sh";

const TEMPLATE = new URL("../../templates/gate.sh", import.meta.url);
/** Staged files that never need checks (doc 6: docs-only diffs take the fast path), plus Plumb's own files. */
const TRIVIAL_PATTERNS = ["*.md", "*.mdx", "*.txt", "docs/*", "LICENSE*", ".gitignore", ".plumb/*"];

/** Single-quotes a string for POSIX sh. */
export function shQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * A glob as a `case` pattern. SIMPLIFIED: `case` wildcards match `/`, so `**` and `*` both become `*`; a
 * single-segment glob like `src/*.ts` also matches deeper files. Ignore globs are rarely written that way. Brackets
 * are literal, as everywhere in Plumb (see matchGlob).
 */
export function casePattern(glob: string): string {
  return glob.replaceAll("**/", "*").replaceAll("**", "*").replaceAll(/([ |;&()<>"'\\$`[\]])/g, "\\$1");
}

function trivialSection(config: Config): string {
  const patterns = [...TRIVIAL_PATTERNS, ...(config.ignore ?? []).map(casePattern)];
  return [
    "# Every staged file is docs or matches config.json `ignore`: nothing to check.",
    'NONTRIVIAL=$(printf \'%s\\n\' "$CHANGED" | while IFS= read -r f; do',
    '  [ -n "$f" ] || continue',
    '  case "$f" in',
    // The leading "(" form: bash 3.2 (macOS /bin/sh) misparses a bare `pattern)` inside $( ... ).
    `    (${patterns.join("|")}) ;;`,
    '    (*) echo "$f" ;;',
    "  esac",
    "done)",
    'if [ -z "$NONTRIVIAL" ]; then',
    '  echo "plumb gate: only docs or ignored files are staged; no checks to run"',
    "fi",
  ].join("\n");
}

function runLine(step: string, command: Command, scope: string): string {
  return `  plumb_run ${step} ${shQuote(command.cwd)} ${scope} ${shQuote(command.cmd)}`;
}

/** The unit step: scoped to the staged files (absolute paths, so any cwd works) when the profile can scope it. */
function unitLines(unit: ScopedCommand): string[] {
  if (unit.scoped === null || !unit.scoped.includes("{files}")) return [runLine("unit", unit, '"all tests"')];
  const [before = "", ...rest] = unit.scoped.split("{files}");
  const after = rest.join("{files}");
  return [
    "  # Related tests only: files from plumb impact when Plumb is installed, else the staged list.",
    "  # Each path is single-quoted, because the command is re-parsed by sh -c: `app/(shop)/page.tsx` stays one word.",
    "  if command -v plumb >/dev/null 2>&1; then",
    '    SCOPE_FILES=$(plumb impact --staged --format=files 2>/dev/null)',
    '    [ -n "$SCOPE_FILES" ] || SCOPE_FILES=$NONTRIVIAL',
    "  else",
    "    SCOPE_FILES=$NONTRIVIAL",
    "  fi",
    `  FILES=$(printf '%s\\n' "$SCOPE_FILES" | while IFS= read -r f; do [ -n "$f" ] && [ -f "$f" ] && printf "'%s' " "$(printf '%s' "$PWD/$f" | sed "s/'/'\\\\\\\\''/g")"; done)`,
    '  if [ -n "$FILES" ]; then',
    `    plumb_run unit ${shQuote(unit.cwd)} "$STAGED_COUNT staged files" ${shQuote(before)}"$FILES"${shQuote(after)}`,
    "  else",
    '    echo "- unit: no staged file has related tests to run"',
    "  fi",
  ];
}

const SMOKE = `  # Smoke boot: launch the run targets, run Doctor, tear down (needs Plumb for process-group bookkeeping).
  if ! command -v plumb >/dev/null 2>&1; then
    echo "- smoke: skipped (plumb is not installed)"
  elif [ -n "\${PLUMB_DRY_RUN:-}" ]; then
    echo "would run  smoke: plumb verify --launch, doctor, cleanup"
  else
    SMOKE_LOG="$LOGS/smoke.log"
    PLUMB_RUN=""
    plumb_smoke_cleanup() {
      [ -z "$PLUMB_RUN" ] || plumb verify --cleanup "$PLUMB_RUN" >> "$SMOKE_LOG" 2>&1
      PLUMB_RUN=""
    }
    trap plumb_smoke_cleanup EXIT
    trap 'exit 130' INT TERM
    plumb verify --launch > "$SMOKE_LOG" 2>&1 && PLUMB_RUN=$(sed -n 's/^launched run //p' "$SMOKE_LOG")
    if [ -z "$PLUMB_RUN" ]; then
      plumb_report smoke "plumb verify --launch" "boot every run target" "$SMOKE_LOG"
      exit 1
    fi
    if [ -x .plumb/bin/doctor ]; then
      plumb_run doctor . "run $PLUMB_RUN" ".plumb/bin/doctor $PLUMB_RUN"
    else
      plumb_run doctor . "run $PLUMB_RUN" "plumb verify --doctor $PLUMB_RUN"
    fi
    plumb_smoke_cleanup
    trap - EXIT INT TERM
    echo "✓ smoke"
  fi`;

function checksSection(profile: Profile, smoke: boolean): string {
  const lines = ['if [ -n "$NONTRIVIAL" ]; then'];
  const { lint, typecheck, unit } = profile.checks;
  if (lint !== null) lines.push(runLine("lint", lint, '"whole project"'));
  if (typecheck !== null) lines.push(runLine("typecheck", typecheck, '"whole project"'));
  if (unit !== null) lines.push(...unitLines(unit));
  if (smoke) lines.push(SMOKE);
  if (lint === null && typecheck === null && unit === null && !smoke) lines.push('  echo "- the profile has no fast checks (lint, typecheck, unit)"');
  lines.push("fi");
  return lines.join("\n");
}

/** gate.sh for the profile: header, trivial-diff skip, the fast checks (plus smoke boot when on), stamp footer. */
export function renderGate(profile: Profile, config: Config, smoke: boolean): string {
  return withHashes(render(readFileSync(TEMPLATE, "utf8"), { trivial: trivialSection(config), checks: checksSection(profile, smoke) }));
}

/** Whether the strategy boots something worth a smoke check (doc 6: api-backend and web-app). */
export function smokeApplies(profile: Profile): boolean {
  return profile.run.length > 0 && profile.strategy !== "library-cli";
}

/** Whether an existing gate.sh has the smoke step, so regeneration keeps the decision init measured. */
export function hasSmoke(script: string): boolean {
  return script.includes("plumb verify --launch");
}
