# Writing .plumb/profile.json

The profile says how the project installs, builds, runs, and tests. Build it from the five files in `.plumb/knowledge/`. Plumb validates it against its schema and checks that every command can run, so precision matters more than completeness.

## Fields

- `schemaVersion`: 1.
- `app`: `name` (human-readable) and `slug` (kebab-case; it names the verify skill `verify-<slug>`).
- `strategy`: run `plumb profile validate` once with any value; it tells you the strategy Plumb derives (`must be "..."`). Use that value. Plumb picks it deterministically from the map and `ui.present`; you don't choose it.
- `packageManager`: from the lockfile and `buildSystem` (pnpm, npm, yarn, bun), or null.
- `install`, `build`: from runtime.install and structure (a repo-level build command, if the project needs one before it runs), or null.
- `checks`: from tests.json. `unit` and `integration` keep their `scoped` command (with `{files}`) or null.
- `run`: from runtime.runTargets. `stop` is `"signal"` unless the repo documents a stop command.
- `services`: from runtime.services. A service's `start` must leave it running and return (for example `docker compose up -d --wait postgres`). If migrations or seed data are required before the run targets work, put the repo's own command for that in the service's `start` (for example a script that starts the database, migrates, and seeds).
- `env`: from runtime.env, without the evidence field.
- `ui`: from frontend.json. `harness` is `existing-playwright` or `existing-cypress` when tests.json found one, otherwise `playwright-mcp` when `present` is true, else null.
- `unknowns`: every knowledge `unknowns` entry that verification really needs, plus required secret env vars with no safe default. Each needs an id saying where the answer goes: `env.<NAME>`, `service.<name>.skip|start|stop`, or `note.<kebab-id>`, plus `"storesIn": "local.json"`.
- `evidence`: for each field you filled from knowledge, the JSON path (for example `"run.0.start"`) mapped to the evidence locations it came from.

## Commands

Every command is `{ "cmd", "cwd", "timeoutSec" }`; `cwd` is repo-relative (`.` for the root).

- Use the exact commands the knowledge cites; don't rephrase them.
- A command must never create or overwrite the user's files. Leave out setup steps like `cp .env.example .env`, even when the README documents them: Plumb injects each env var's `defaultForVerification` into every command it runs, so the app gets safe local values without touching `.env`.
- Prefer one repo-level command over a chain when the repo has one.
- Timeouts: install 600, build 600, lint/typecheck 300, unit 600, integration 900, e2e 900, a service start 180, a run target start 120. Raise one only with a reason from the knowledge.

## Ports and readiness

- A run target's `port` is the port it listens on by default, and `portEnv` the env var that changes it, or null.
- Readiness, in order of preference: an HTTP health URL with its status, the port, a log line. A log pattern is a regex.
- Two run targets never share a port.
