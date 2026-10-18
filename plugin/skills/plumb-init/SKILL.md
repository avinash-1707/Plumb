---
name: plumb-init
description: Set up Plumb in this repository. Maps the code, explores how it builds, runs, and tests, writes .plumb/profile.json, asks only what can't be observed, and proves the app boots. Use when the user runs /plumb-init or asks to set up Plumb.
disable-model-invocation: true
allowed-tools: Bash(plumb *) Read Glob Grep Write Edit Agent AskUserQuestion
---

# Set up Plumb

You are running Plumb's init flow in this repository. Plumb's CLI (`plumb`) does everything deterministic and validates everything you write; you do the judgment work. Follow the steps in order. Don't skip a validation step, and don't edit anything outside `.plumb/`: never product code, never the user's configs.

Every `plumb` command exits 0 on success, 1 when a check fails, 2 when Plumb couldn't complete (the message names the blocker), 3 on invalid usage.

Run each `plumb` command exactly as written, on its own: no `;`, `&&`, pipes, redirects, or `echo $?`. The Bash tool already reports the exit code, and sessions often allow `plumb` commands and nothing else, so a chained command can be refused.

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

## 8. Report

End with a short report:

- **Detected**: strategy and why, components, run targets, services.
- **Written**: `.plumb/knowledge/*`, `.plumb/profile.json`, and any `.plumb/local.json` answers (ids only, never values).
- **Proven**: the `plumb profile verify` result, with the evidence directory it printed.
- **Needs you**: unanswered unknowns, or the blocker that stopped init.
