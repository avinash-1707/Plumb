# Contributing to Plumb

## Setup

Node 22.20 or later, pnpm, git, and Docker (for the example's Postgres).

```sh
pnpm install
pnpm --dir examples/node-web install
pnpm typecheck && pnpm lint && pnpm test
```

Run the CLI from source with `node src/cli.ts <command>` (Node strips the types). To use your checkout from Claude Code, start a session with `claude --plugin-dir ./plugin`: the plugin's `bin/plumb` runs the checkout's `src/cli.ts`.

## Rules the code follows

- **The CLI never calls a model.** Anything that needs judgment goes to the host agent through a plugin skill; the CLI prepares inputs and validates outputs.
- **Every map fact has evidence and provenance.** `file:line` plus `extracted` or `inferred`. Inferred facts never block a commit.
- **Never overwrite a user's files.** Hooks are chained, configs are edited inside `plumb:managed` regions only, and regeneration writes `<file>.plumb-new` when a region was edited by hand.
- **Kill what you started, never by process name.** Everything Plumb starts runs in its own process group, recorded and torn down by id, also on failure and Ctrl-C.
- **Evidence survives cleanup.**
- **Prompts, agent definitions, schemas, and templates are files** (`plugin/`, `schemas/`, `templates/`), never inline strings.
- TypeScript strict, no `any`. Stdlib before a new dependency, and every dependency needs a reason.

## Tests

- `test/` holds unit and integration tests (Vitest). Tests that start processes must leave nothing running; they create throwaway git repositories under the OS temp dir.
- `examples/node-web` is the integration target. Its golden map in `examples/node-web/.plumb-golden/map/` is the extractors' reliability check: an extractor change must keep `test/map-golden.test.ts` passing, or update the golden files deliberately after reviewing the diff line by line.
- `scripts/e2e-init.sh` runs the full `/plumb-init` headlessly against a fresh copy of the example and checks the result: skill valid, evidence kept, nothing left running, and a second init changes nothing. It needs a logged-in Claude Code and Docker, and uses a few dollars of model usage, so run it by hand before a release, not on every change.

## Commits

Short imperative summaries. Group related changes; keep refactors separate from behavior changes.
