<p align="center"><img src="assets/banner.jpg" alt="Plumb: prove every change in the running app" width="100%"></p>

# Plumb

Plumb maps your codebase, proves changes work in the running app, and checks every commit before it lands.

- **Map.** A deterministic graph of components, routes, imports, database tables, env vars, and shared state, committed in `.plumb/map/`. No model involved.
- **Verify.** A skill generated for your project that boots the real app, drives it the way a user does, and keeps the evidence (screenshots, ARIA snapshots, responses).
- **Gate.** A fast pre-commit check (lint, typecheck, related tests) that never calls a model. When a coding agent commits a change to a key feature, Plumb blocks the commit until that feature has been driven live and passed.

Plumb runs on your machine. It uses the agent you already run (Claude Code), so there's no extra API key, account, or hosted service. The model work counts against your Claude Code usage.

v1 supports Node/TypeScript repositories only.

## Install

You need Node 22.20 or later, git, and Claude Code. Docker is needed only if your app's services (a database, a queue) run in docker compose.

1. Install the Claude Code plugin, in a Claude Code session:

   ```
   /plugin install plumb --marketplace avinash-1707/Plumb
   ```

   On Claude Code older than 2.1.275, run `/plugin marketplace add avinash-1707/Plumb`, then `/plugin install plumb@plumb`.

2. In your repository, in Claude Code:

   ```
   /plumb-init
   ```

3. Optional: `npm install -g @plumb-cli/plumb`. Without it the plugin fetches Plumb through `npx`, which is slower on the commit hook, because the hook runs on every agent Bash call.

`/plumb-init` takes a few minutes and is the largest single use of model time Plumb has: it launches five explorer agents, then generates the verify skill and drives one feature to prove it works. It maps the repo; explores how the app builds, runs, and tests; writes `.plumb/profile.json`; asks you only for what it can't observe (an API key, an external account); proves the app boots; and installs the git hook. Then commit what it generated:

```sh
git add .plumb .claude/skills .gitignore .mcp.json && git commit -m "Add Plumb"
```

`.mcp.json` exists only if your app has a UI and no browser harness of its own; leave it out of the command when there isn't one.

`/plumb-init` (in Claude Code) is the full setup. `plumb init` (the shell command) is only its deterministic part, which the skill calls for you.

## Try it on the example

`examples/node-web` is a small shop built with Next.js, Express, Prisma, and Postgres. Plumb uses it as its own integration test. You need Node, pnpm, git, Claude Code, and Docker (for Postgres). This is optional; to use Plumb on your own repo, `/plumb-init` is enough.

**1. Copy the example into a fresh repository.**

```sh
git clone https://github.com/avinash-1707/Plumb
cp -r Plumb/examples/node-web shop
cd shop
rm -rf .plumb-golden
```

`.plumb-golden` holds Plumb's test fixtures; the shop doesn't need it.

**2. Commit it, then install dependencies and the browser.**

```sh
git init -q
git add -A
git commit -qm init
pnpm install
pnpm --filter @node-web/web exec playwright install chromium
```

**3. Run the setup in Claude Code.**

```sh
claude
```

Then type `/plumb-init` in the session.

**4. Watch the gate work.**

- **A human commit with a type error is blocked.** Break a type in `apps/api/src/pricing.ts`, stage it, and commit. The hook names the failed check, the log, and the error lines.
- **An agent commit to a key feature waits for proof.** Ask Claude to change the order flow and commit. Plumb refuses with "Run /plumb-verify <feature>, then commit again". `/plumb-verify` boots the app on its own ports, drives the feature, and saves the evidence. Then the same commit goes through.

## How it works

| Step | What happens |
|---|---|
| Map | `plumb map` extracts components, entry points, and edges from configs, the TypeScript compiler, and dependency-cruiser. Every fact carries `file:line` evidence. No model |
| Discover | Five read-only explorer agents read the map and the code: structure, runtime, tests, frontend, risk. The CLI validates their findings and every citation |
| Profile | The session writes `.plumb/profile.json` (install, build, checks, run targets, services). `plumb profile verify` runs every command and boots every target, then tears down everything it started |
| Verify skill | `.claude/skills/verify-<app>/`: Launch, Doctor, Drive, Evidence, Cleanup, and a feature map with one file per key feature. Plumb fills everything deterministic; the session writes the recipes; `plumb verify --validate` checks the structure |
| Gate | `.plumb/gate.sh` is plain POSIX sh, committed, and runs without Plumb installed. A pass is stamped by the staged tree's hash, so the same content is never checked twice. No model |
| Agent hook | The plugin's PreToolUse hook sees `git commit`, runs the gate, and blocks while the staged change touches a deep-tier feature that has no passing live verification for that exact tree. No model |

Everything Plumb starts (servers, containers) runs in its own process group and is torn down by recorded id, never by process name. Evidence survives cleanup, and `plumb verify --cleanup` checks that it did.

## Commands

In Claude Code:

| Command | Does |
|---|---|
| `/plumb-init` | Full setup, as above. On a set-up repo it refreshes Plumb's generated sections instead |
| `/plumb-verify [features]` | Drive the features the staged changes touch (or the named ones), keep the evidence, and stamp the staged tree. You run this when the gate asks for it |
| `/plumb-status` | What Plumb has set up and what it last proved |
| `/plumb-pr [base]` | Optional. Verify exactly the features a branch touches and write a PR report |
| `/plumb-refine` | Optional. Re-check every feature file against the code and the live app; ends `clean`, `changed`, or `blocked` |

<details>
<summary>Shell CLI reference</summary>

The skills and hooks call these; you rarely need to. Every command takes `--json` and `--cwd <dir>`; exit 0 ok, 1 check failed, 2 couldn't complete, 3 bad usage.

| Command | Does |
|---|---|
| `plumb init [--refresh]` | Deterministic setup, or regenerate managed sections |
| `plumb map [--update \| --check]`, `plumb map show <id>`, `plumb map query <expr>` | Build, update, check, and query the map |
| `plumb impact <base> \| --staged` | Components and features a diff affects |
| `plumb gate [--dry-run \| --regenerate]` | Run, preview, or regenerate the fast tier |
| `plumb hooks install \| uninstall` | Chain the gate into husky, lefthook, pre-commit, `core.hooksPath`, or `.git/hooks`; uninstall restores the original byte for byte |
| `plumb verify --plan \| --launch \| --doctor \| --cleanup \| --stamp \| --validate` | The deterministic parts of a live verification |
| `plumb pr <base> [--run <id>]` | PR verification plan and report |
| `plumb status` | State of the setup |
| `plumb doctor` | Health of Plumb itself (Node, TypeScript, dependency-cruiser, hook). Not the same as `.plumb/bin/doctor <run-id>`, which checks a running verification instance |

</details>

## Files Plumb writes

Committed: `.plumb/map/`, `.plumb/profile.json`, `.plumb/features.json`, `.plumb/gate.sh`, `.plumb/bin/doctor`, `.claude/skills/verify-<app>/`, and a `playwright` entry in `.mcp.json` only when your app has a UI and no browser harness of its own.

Not committed (Plumb adds them to `.gitignore`): `.plumb/knowledge/`, `.plumb/local.json` (secrets, never printed), `.plumb/evidence/`, `.plumb/stamps/`, `.plumb/cache/`.

Generated files you may edit have `plumb:managed` regions. Plumb only rewrites inside them, and if you edited inside one it writes `<file>.plumb-new` next to your file instead of overwriting it.

## Bypassing

- Humans: `git commit --no-verify` skips the git hook, as with any hook.
- Agents: prefixing the command with `PLUMB_SKIP=1` skips the Claude Code hook. Every bypass is logged and shown by `plumb status`.

## Strategies

Plumb picks a strategy from what discovery finds: `web-app`, `api-backend`, `library-cli`, or `monorepo`. See [guides/strategies.md](guides/strategies.md).

## Status

Review agents (architecture rules, resilience, concurrency, resource leaks), a GitHub Action, and an MCP server are planned.

## The name

Builders hang a plumb line, a weight on a string, beside a wall to check that it's straight before they build higher. To plumb something also means to explore it to the bottom. Plumb does both.

## Credits

The verification method (the verify skill's five sections, the feature map, the self-proof, and the refine loop) is adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (MIT). See [NOTICE](NOTICE).

## License

MIT. See [LICENSE](LICENSE). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
