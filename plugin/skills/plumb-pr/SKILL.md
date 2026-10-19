---
name: plumb-pr
description: Verify a branch the way a pull request needs it: Plumb's impact set picks the deep-tier features the branch touches, you drive exactly those in the running app with the repo's verify skill, and Plumb writes the PR report. Use when the user runs /plumb-pr or asks to verify a branch or PR.
argument-hint: "[base, default main]"
disable-model-invocation: true
allowed-tools: Bash(plumb *) Bash(.plumb/bin/doctor *) Bash(curl *) Bash(node *) Read Glob Grep Write Edit
---

# Verify this branch for a pull request

Base: $ARGUMENTS (use `main` when empty).

Run every shell command as its own Bash call, exactly as written: no `;`, `&&`, pipes, redirects, or `echo $?`. Sessions allow commands one by one (`plumb`, `node`, `curl`), so a chained command is refused even when each part alone would run. Create folders and files with the Write tool, and capture command output from a drive script, not with shell redirects. Never edit product code.

## 1. Plan

Run `plumb pr <base>`. It prints whether the committed map is current, the impacted components, and under `verify` each deep-tier feature the branch touches with its recipe file. If nothing needs verifying, say so and stop. If the map is stale, mention it in your report; don't fix it.

Verify exactly the listed features: no more, no fewer.

## 2. Launch, drive, report, clean up

Read the verify skill and each recipe, then:

1. Launch as the skill's Launch section says, and note the run id and tree. Run `.plumb/bin/doctor <run-id>`.
2. Drive every sub-feature of each listed feature, saving evidence as the skill's Evidence section says. Doctor again after anything surprising.
3. Write `report.md` and `report.json` in the run directory (the tree is the one `--launch` printed).
4. Clean up as the skill's Cleanup section says, ending with `plumb verify --cleanup <run-id>`, also after a failure. It must report the evidence intact.

## 3. PR report

Run `plumb pr <base> --run <run-id>`. It checks the run covers exactly the planned features with nothing failed, and writes `pr-report.md` in the run directory.

End with its verdict, the features and sub-features with their status, the report path, and anything the user must do (a failed feature with its evidence, a stale map).
