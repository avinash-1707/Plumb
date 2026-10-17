# Plumb

Maps your codebase, runs your app to prove changes actually work, and checks every commit and pull request against your architecture for leaks, races, and design flaws.

Plumb is in early development.

## The name

Builders hang a plumb line, a weight on a string, beside a wall to check that it's straight before they build higher. To plumb something also means to explore it to the bottom. Plumb does both: it maps the repo, then checks each change against that map.

## How it works

Plumb is an open-source CLI that runs on your machine and in your own CI. It plugs into Claude Code as a plugin and into git as a pre-commit hook, with GitHub Actions and MCP support planned.

Running `plumb init` builds a map of how the repo fits together: components, entry points, imports, routes, database tables, queues, and shared state. It then works out how the project builds, runs, and tests, and writes a verification skill for that project. The skill starts the real app, uses it the way a user would, and saves evidence of what happened.

After that, every commit goes through a quick check that never calls a model: lint, typecheck, and tests for the files you changed. When a coding agent commits a change that touches a key feature, Plumb asks it to verify that feature in the running app first. Pull requests get a review scoped to the parts of the repo the change affects, checked against the map and your architecture rules. Plumb reports only problems the change introduced, and blocks only on the ones it can prove.

We don't host anything. Plumb uses the agent you already run, so there's no extra API key or account.

## Glossary

| Term | Meaning |
|---|---|
| Map | The graph of components, entry points, edges, resources, and shared state, stored in `.plumb/map/`. Built by extraction, not by a model. |
| Profile | How the project builds, runs, and tests, and which services it needs. Stored in `.plumb/profile.json`. |
| Verify skill | The project-specific skill at `.claude/skills/verify-<app>/` that drives the real app and captures evidence. |
| Feature map | The `features/` folder inside the verify skill, with one file per user-facing feature: how to drive it and what proves it works. |
| Gate | The checks that run before a commit lands. The fast tier runs plain commands; the deep tier has an agent drive the app. |
| Impact set | The components a diff touches, plus their dependents and anything sharing a resource with them. Computed from the map. |
| Finding | A review result. It needs proof or a concrete failure scenario to block; without one it stays "suspected". |
| Ledger | The committed record of known findings and suppressions, so a review reports only what a change introduces. |
| Host agent | The coding agent Plumb hands judgment work to: your Claude Code session, or headless `claude -p` in CI. |
