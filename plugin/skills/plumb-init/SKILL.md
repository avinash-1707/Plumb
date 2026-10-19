---
name: plumb-init
description: Set up Plumb in this repository. Maps the code, explores how it builds, runs, and tests, writes .plumb/profile.json, asks only what can't be observed, proves the app boots, then generates a verify skill and proves it by driving one feature. Use when the user runs /plumb-init or asks to set up Plumb.
disable-model-invocation: true
allowed-tools: Bash(plumb *) Bash(.plumb/bin/doctor *) Bash(curl *) Bash(node *) Read Glob Grep Write Edit Agent AskUserQuestion
---

# Set up Plumb

You are running Plumb's init flow in this repository. Plumb's CLI (`plumb`) does everything deterministic and validates everything you write; you do the judgment work. Follow the steps in order. Don't skip a validation step, and don't edit anything outside `.plumb/`: never product code, never the user's configs. Plumb's CLI writes the few files that live elsewhere (`.claude/skills/verify-<slug>/`, `.mcp.json`, `.gitignore`).

Every `plumb` command exits 0 on success, 1 when a check fails, 2 when Plumb couldn't complete (the message names the blocker), 3 on invalid usage.

Run each `plumb` command exactly as written, on its own: no `;`, `&&`, pipes, redirects, or `echo $?`. The Bash tool already reports the exit code, and sessions often allow `plumb` commands and nothing else, so a chained command can be refused.

## 0. Already set up?

If `.plumb/profile.json` and `.plumb/features.json` both exist, this repository was initialized before. Don't rediscover or regenerate by hand:

1. Run `plumb init --refresh`. It rebuilds the map and regenerates Plumb's managed sections from the current profile. When nothing changed, it changes nothing. A managed region someone edited by hand is left alone, and the new version is written next to it as `<file>.plumb-new`.
2. Run `plumb verify --validate`.

If both pass, report that Plumb is already set up (include the refresh output) and stop; `/plumb-refine` is the flow for updating the skill's content. If the refresh reports conflicts, list them and stop. If validate fails, continue from step 8 to repair the skill, keeping every file that is still valid.

## 1. Map the repository

Run `plumb map`. If it exits 2, read the failures. "dependencies not installed" means the checkout has no `node_modules`: stop and tell the user the install command the repo documents. Plumb doesn't install for you before it knows the project.

## 2. Prepare context for the explorers

Run `plumb knowledge prepare`. It writes `.plumb/knowledge/context.json` and prints the absolute knowledge directory. Use that exact path, copied from its output, for every file you write in steps 3 and 4.

## 3. Explore, in parallel

For each explorer in structure, runtime, tests, frontend, risk:

1. Run `plumb knowledge schema <name>` and keep its output.
2. Launch the `plumb:explorer-<name>` agent. Launch all five in a single message so they run in parallel. Each prompt is: "Explore this repository for Plumb. Your output must match this JSON schema:" followed by the schema output.

When each returns, use the Write tool to write its JSON object to `<knowledge directory>/<name>.json` and its `## Summary` section to `<knowledge directory>/<name>.md`.

## 4. Validate the findings

Run `plumb knowledge validate`. For each issue, fix the JSON if the fix is mechanical (a wrong line number you can confirm by reading the file), otherwise relaunch that explorer with the issues appended to its prompt. Repeat until it passes, at most twice; then stop and report what is still invalid.

## 5. Write the profile

Read `${CLAUDE_PLUGIN_ROOT}/skills/plumb-init/profile-synthesis.md` and follow it to write `.plumb/profile.json` from the five knowledge files. `plumb profile schema` prints the schema the profile must match.

Then run `plumb profile validate`. Each issue names a JSON path and what is wrong: a command that won't run, a script that doesn't exist, or the strategy Plumb derives. Fix exactly those and validate again until it passes (at most three rounds; then stop and report the remaining issues).

## 6. Ask only what can't be observed

Run `plumb local status`. For each unanswered unknown:

- In an interactive session, ask the user the question verbatim with AskUserQuestion (include the "why"). Store the answer with `plumb local set <id> '<answer>'` (write a `'` inside the answer as `'\''`). Never repeat a secret back to the user.
- If you can't ask the user (non-interactive run), don't guess: stop here and report the unanswered unknowns with their questions.

## 7. Make it boot

Run `plumb profile verify` with the Bash tool's maximum timeout (600000 ms): it runs install, build, services, every check, and boots every run target, then tears down everything it started.

If it fails, read the failure block (step, command, reason, log tail):

- If the profile is wrong (a wrong command, readiness probe, port, or timeout), fix `.plumb/profile.json`, run `plumb profile validate`, and verify again. At most two fixes.
- If the checkout itself doesn't build or boot (a broken script, a missing file, failing tests), stop. Never generate anything against a broken base, and never edit product code to make it pass. Report the failure block verbatim and the most likely cause.

## 8. Generate the verify skill

Read `${CLAUDE_PLUGIN_ROOT}/skills/generate-verification/SKILL.md` and follow it. It ends when `plumb verify --publish` has moved the validated skill into `.claude/skills/`.

Then generate the commit gate: run `plumb gate --regenerate --measure` (Bash timeout 600000 ms). It writes `.plumb/gate.sh` from the profile and turns the smoke boot on only if launching, Doctor, and teardown fit in half the gate's time budget.

## 9. Prove the skill works

A verify skill that never ran is a draft. First run `plumb gate` (Bash timeout 600000 ms): the fast tier must pass on the checkout. Then follow the generated skill yourself, exactly as written, to drive one feature end to end:

1. Pick the highest-ranked feature in `.plumb/features.json` that the launch can reach without anything from the user.
2. Launch as the skill's Launch section says and note the run id. Then run `.plumb/bin/doctor <run-id>`.
3. Drive the feature's first sub-feature with its recipe, and save evidence where the Evidence section says.
4. Write `report.md` and `report.json` in the run directory.
5. Clean up as the Cleanup section says, ending with `plumb verify --cleanup <run-id>`. It must print `evidence intact`.

If any step fails, always run `plumb verify --cleanup <run-id>` first. Then fix the skill (a wrong selector, URL, or recipe step; never product code): run `plumb verify --edit`, change the copy in `.plumb/cache/draft/verify-<slug>/` (never edit `.claude/` directly), run `plumb verify --validate`, then `plumb verify --publish`, and try again. At most three attempts; then stop and report the blocker with the failing step's output. Don't stamp anything: there is no staged change to prove.

If something irrelevant to the feature blocks the app from starting (a sample config file, a static directory the API never serves), the skill may create it in its Launch steps, marked as verification scaffolding, and remove it in Cleanup.

## 10. Install the gate

Run `plumb hooks install`. It chains `.plumb/gate.sh` into the repository's existing pre-commit setup (husky, lefthook, the pre-commit framework, `core.hooksPath`, or `.git/hooks`) without replacing anything, and records what it changed so `plumb hooks uninstall` can undo it exactly. Agent commits are gated by the plugin's own hook; nothing to install for that.

Finally run `plumb map --update`, so the committed map includes the files this run added (such as `.mcp.json` or the `.gitignore` block).

## 11. Report

End with a short report:

- **Detected**: strategy and why, components, run targets, services.
- **Written**: `.plumb/knowledge/*`, `.plumb/profile.json`, and any `.plumb/local.json` answers (ids only, never values).
- **Generated**: the verify skill directory, `.plumb/features.json` (feature ids and tiers), `.plumb/bin/doctor`, `.plumb/gate.sh` (with whether smoke boot is on, and why), and `.mcp.json` if it changed.
- **Installed**: how the gate hooks into commits (`plumb hooks install` output), and that agent commits touching deep features need `/plumb-verify` first.
- **Proven**: the `plumb profile verify` result, and the self-proof: the feature and sub-feature driven, its run id, and the evidence directory that survived cleanup.
- **Needs you**: unanswered unknowns, or the blocker that stopped init.
