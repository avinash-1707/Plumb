# Strategies

Plumb picks one strategy per repository from what discovery finds. It decides what the fast gate runs and how the verify skill drives the app. You can force one with `plumb init --strategy <s>` or `"strategy"` in `.plumb/config.json`.

Plumb takes the first row that matches:

| Strategy | When | Fast gate (every commit) | Deep verification (agent commits to deep features, PRs) |
|---|---|---|---|
| `monorepo` | Several components with their own build or test setup | Lint, typecheck, and the unit tests related to the staged files, across the workspace | Each touched feature with its own component's recipe |
| `web-app` | The profile has a UI | Lint, typecheck, related unit tests; a smoke boot when it fits the time budget | Boot the stack on free ports, drive the feature in a browser (the repo's Playwright or Cypress, else Playwright MCP), check console errors, save ARIA snapshots and screenshots, read writes back |
| `api-backend` | HTTP entry points and no UI | Lint, typecheck, related unit tests; a smoke boot when it fits | Boot the service and its services, Doctor, drive the endpoints with real requests, save request, status, and body, read writes back |
| `library-cli` | Anything else | Lint, typecheck, related unit tests | Build once, run each drive in a scratch directory, save command, stdout, stderr, and exit code |

## The smoke boot

For `web-app`, `api-backend`, and `monorepo` repos with run targets, the gate can boot the app, run Doctor, and tear it down on every commit. `/plumb-init` measures that (`plumb gate --regenerate --measure`) and turns it on only if it takes at most half the gate's budget (30 seconds by default, `gate.budgetSec` in config.json). Force it with `"gate": { "smoke": true }` or `false`.

## Deep and fast-only features

Each feature in `.plumb/features.json` has a `tier`. `deep` features need a live drive when an agent's commit touches them (their `paths` globs match a staged file); `fast-only` features are covered by the fast gate alone. `/plumb-init` seeds the 3 to 5 features where a break would hurt most (money, auth, data writes, frequently changed code) as `deep`. Edit the tiers and paths as you see fit; `plumb verify --validate` checks them against the map.

## Services and secrets

Databases and queues come from docker compose when the repo has it. Safe local values come from `.env.example`. Anything else (an API key, an external account) is asked once and stored in `.plumb/local.json`, which is never committed and never printed. A feature that needs an external service Plumb can't reach is reported as `verified-unreachable` with the missing prerequisite, never as verified.
