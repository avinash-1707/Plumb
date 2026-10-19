---
name: plumb-verify
description: Deep-verify staged changes, or named features, by driving the running app with the repo's verify skill and capturing evidence; writes Plumb's deep stamp on a pass. Use when the user runs /plumb-verify, or when Plumb's commit hook blocks a git commit and says to run /plumb-verify.
argument-hint: "[feature-id ...]"
allowed-tools: Bash(plumb *) Bash(.plumb/bin/doctor *) Bash(curl *) Bash(node *) Read Glob Grep Write
---

# Verify changes in the running app

Features to verify: $ARGUMENTS (when empty, the staged changes decide).

Run each `plumb` command exactly as written, on its own: no `;`, `&&`, pipes, or redirects.

## 1. Plan

Run `plumb verify --plan --staged`. It prints the verify skill's path and, for each mapped feature the staged changes touch, whether to drive it and its recipe file. If features were named above, verify those instead (each must exist in `.plumb/features.json`). If nothing needs a drive, say so and stop: there is nothing to stamp.

Read the verify skill (`SKILL.md`) and each recipe file before you start.

## 2. Launch and Doctor

Launch exactly as the skill's Launch section says. Note the run id, the tree, and the URLs it prints. Then run `.plumb/bin/doctor <run-id>`. If the launch or Doctor fails, go to step 5 (Cleanup) and report the failure; don't drive.

## 3. Drive and capture evidence

For each feature, drive every sub-feature reachable from the changed code, following its recipe and the skill's Drive section, on this run's URLs only. Save evidence under `.plumb/evidence/<run-id>/<feature-id>/` as the skill's Evidence section says.

- After any failed or surprising drive, run Doctor again before the next one. If Doctor can't see the problem (a wedged page on a healthy process), relaunch: cleanup, then launch.
- A sub-feature you can't reach is `verified-unreachable` with the attempted entry point and the missing prerequisite. Never mark it verified through a different path.
- Never edit product code to make a drive pass. A wrong behavior is a `failed` sub-feature with its evidence.

## 4. Report

Write `report.md` and `report.json` in the run directory, as the skill's Evidence section shows. Use the tree `--launch` printed.

## 5. Cleanup

Do the skill's Cleanup steps, ending with `plumb verify --cleanup <run-id>`. Always, also after a failure. It must report the evidence intact; if it doesn't, the run proves nothing.

## 6. Stamp

Run `plumb verify --stamp <run-id>`. On success the commit gate accepts this exact staged content. If it refuses, its issues say why (a feature not verified, a failed sub-feature, staged changes that moved since launch); fix the cause and verify again, or report it.

End with: features driven, each sub-feature's status, the evidence directory, and the stamp (or why there is none).
