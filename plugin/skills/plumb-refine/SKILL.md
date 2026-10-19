---
name: plumb-refine
description: Keep the repo's verify skill and feature map honest as the app changes. Reads every feature against the source in parallel, drives every feature live, triages drift, and ends with exactly one outcome - clean, changed, or blocked. Use when the user runs /plumb-refine, after verification missed a bug, or on a schedule.
disable-model-invocation: true
allowed-tools: Bash(plumb *) Bash(.plumb/bin/doctor *) Bash(curl *) Bash(node *) Read Glob Grep Write Edit Agent
---

# Refine the verify skill

You keep `.claude/skills/verify-<slug>/` and `.plumb/features.json` true to the app. You may change only the verify skill (through its draft), `.plumb/features.json`, and `.plumb/bin/doctor` below its managed block. Never product code. Never edit inside a `plumb:managed` block.

Run each `plumb` command exactly as written, on its own: no `;`, `&&`, pipes, or redirects.

The run ends with exactly one outcome, stated explicitly:

- **clean**: every feature got source and live coverage; nothing to change.
- **changed**: one set of proven corrections to the skill, feature map, features.json, or doctor helper.
- **blocked**: coverage couldn't finish or a fix couldn't be proven; say exactly what blocked it.

Write run notes (features covered, unreachable prerequisites, drift found, outcome) to `.plumb/evidence/refine-<timestamp>/notes.md`. They are not committed.

## 0. Locate the skill

Run `plumb status`. If no skill is published, stop: the user needs `/plumb-init`. Read the skill, `features/README.md`, every feature file, and `.plumb/features.json`.

## 1. Index hygiene

Run `plumb verify --validate`. Missing, extra, duplicate, or dead entries (a feature file without a features.json entry or the reverse, an entry point or path the map no longer has, a README index line for a missing file) are doc drift to fix in step 5.

## 2. Source wave

Launch one `plumb:feature-source-reader` agent per feature file, all in a single message so they run in parallel. Each prompt names the feature file path and pastes its `.plumb/features.json` entry. They read only; they never drive the app or edit files.

## 3. Reconcile

- Every feature has a returned summary; relaunch any that failed, once.
- Merge the live recipes so the live pass needs as few app states (sign-ins, seeded records) as practical.
- Spot-check each cited drift claim by opening the cited line yourself. Drop claims that don't hold.
- Sweep recent churn for user-facing surfaces missing from the map: run `plumb map --update`, then `plumb map show <component>` for components whose entry points changed. Call a surface missing only with a concrete source path.

## 4. Live pass

Required even when the source looks clean. You own all driving. Follow the skill's Launch model: launch once, Doctor, then drive every feature at least once, saving evidence under the run directory. Doctor after any failed drive. If Doctor fails because the skill itself is wrong (a stale URL, a renamed selector), fix that in the draft (step 5) and retry once before calling it blocked. Always finish with `plumb verify --cleanup <run-id>`.

## 5. Triage and fix

For each finding:

- **Doc drift** (the skill or a feature file is wrong about working code): fix it.
- **Harness gap** (working behavior the recipe can't drive): fix the recipe, then drive it live again to prove the fix.
- **Product gap** (the app is broken): report it with its evidence. Keep it out of the change.

To change the skill, run `plumb verify --edit`: it copies the published skill to `.plumb/cache/draft/verify-<slug>/`. Edit only there (Claude Code asks before every write under `.claude/`), plus `.plumb/features.json` and the doctor helper. Then run `plumb verify --validate` until it passes and `plumb verify --publish`.

## 6. Ship or stop

- **changed**: re-read every file you changed, then present the change set: each fix with the drift it corrects (`path:line` in the code) and the live evidence that proves it.
- **clean** or **blocked**: report the outcome and the coverage honestly: which features got source and live coverage, and what blocked the rest.
