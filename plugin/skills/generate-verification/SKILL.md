---
name: generate-verification
description: Generate this repository's verify skill and feature map from Plumb's scaffold, the profile, and the explorer findings. Used by /plumb-init after the profile boots.
user-invocable: false
---

# Generate the verify skill

You turn Plumb's scaffold into a verify skill an agent can follow cold, mid-task, with no knowledge of this app. Plumb wrote every deterministic part (launch facts, teardown, evidence layout, proof standards) inside `plumb:managed` markers. You write the rest. Never edit inside a managed block, and never edit product code.

You work in a draft directory, `.plumb/cache/draft/verify-<slug>/`, never in `.claude/`: Claude Code asks before every write under `.claude/`, so Plumb moves the finished draft there itself in step 5.

Run every shell command as its own Bash call, exactly as written: no `;`, `&&`, pipes, redirects, or `echo $?`. Sessions allow commands one by one (`plumb`, `node`, `curl`), so a chained command is refused even when each part alone would run. Create folders and files with the Write tool, and capture command output from a drive script, not with shell redirects.

## 1. Scaffold

Run `plumb verify --scaffold`. It writes, only where missing:

- `.plumb/features.json`: the features to verify, drafted from `.plumb/knowledge/risk.json` and the map.
- The draft: `.plumb/cache/draft/verify-<slug>/SKILL.md`, `features/README.md`, and one `features/<id>.md` per feature.
- `.plumb/bin/doctor`, the Doctor helper.
- `.mcp.json` gets a `playwright` entry only when the app has a UI and no browser harness of its own.

Files it reports as `kept` already existed; leave them alone. If it reports the skill under `.claude/skills/` (already published), there is no draft: skip to step 4.

## 2. Refine features.json

Read `.plumb/knowledge/risk.json`, `frontend.json`, and `runtime.json`, then check each drafted feature:

- `paths` are globs of the code that implements the feature: its routes, handlers, pages, components, and the data code they call. Add what's missing; remove globs that only match shared plumbing (a whole `src/**`), or every change would touch every feature.
- `entryPoints` and `components` must be ids from the map (`plumb map show <id>` prints one).
- `tier` is `deep` when a change to it needs a live drive (writes data, money, auth, a user-visible flow), `fast-only` otherwise.

Keep the ids and file names as drafted unless one is plainly wrong; a renamed id needs its feature file renamed too.

## 3. Fill the tokens

Replace every `{{fill: ...}}` token in the draft directory and in `.plumb/bin/doctor`. Each token says what belongs there. Ground every sentence in what discovery found or what you read in the code:

- **Commands and selectors are real.** Copy routes, ARIA roles and names, `data-testid`s, CLI flags, and seeded users from the code or the existing tests (the knowledge files cite them). Never invent one. If you can't find a stable handle, say so in Gotchas.
- **Feature files** (`features/<id>.md`): an H1 title, one paragraph of user-visible behavior, then exactly the four H2s: `Sub-features` (bullets starting with a backticked kebab-case id), `How to get to it (user POV)`, `Driving it with <harness>` (starts with `Preconditions:`, then one labeled bullet per sub-feature: action, exact command or script step, observable result, and the read-back for any write), and `Gotchas`. Every entry point a user can reach the feature through is listed, not just the convenient one.
- **Secrets**: never write a secret value anywhere. Refer to where it comes from (`.plumb/local.json`, a seeded demo account documented in the README).
- **Launch**: the exact `plumb verify --launch` command, with `--env 'NAME=value'` only for variables that must follow another run target's port or the run id. Plumb already moves loopback URLs that pointed at a target's default port, so most apps need no `--env` at all.
- **Doctor helper**: app-specific checks must be read-only (GET requests, status commands). Use the `URL_<TARGET>` variables the helper sources.

## 4. Validate

Run `plumb verify --validate`. Each issue names a file and line: a leftover token, a missing or misordered section, a feature file without its four H2s, a features.json entry that doesn't match a file or the map, a helper that isn't executable or isn't shown in the skill. Fix exactly those and validate again, at most three rounds; then stop and report what is still invalid.

## 5. Publish

Run `plumb verify --publish`. It validates the draft once more and moves it to `.claude/skills/verify-<slug>/`, where Claude Code and every agent in the repo find it. From here on, follow the published copy.
