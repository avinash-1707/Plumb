---
name: verify-{{plumb:slug}}
description: "Drive {{plumb:app}} ({{plumb:surface}}) the way a user does and capture evidence. Use to verify changes, reproduce bugs, or prove a feature works before commit or PR."
---

# Verify {{plumb:app}}

Drive the real app on the real user path and keep the proof. Follow the sections in order: Launch, Doctor, Drive, Evidence, Cleanup. The feature map in `features/` says what to drive; `features/README.md` is its index.

Run every `plumb` command on its own, exactly as written (no `;`, `&&`, or pipes).

## Launch

<!-- plumb:managed:start launch -->
{{plumb:launch}}
<!-- plumb:managed:end launch -->

{{fill: The exact launch command for this app, as a fenced sh block: `plumb verify --launch` plus one `--env 'NAME=value'` per variable that must follow another run target's port or the run id (use {port:<target>} and {runId}), or the bare command when nothing needs wiring. Then any data isolation this run needs (a disposable database name via {runId}, a temp data dir), or one sentence saying why isolation is impossible here and that you must never drive an instance this run didn't start.}}

## Doctor

<!-- plumb:managed:start doctor -->
Run Doctor before the first drive, after any failed drive, and whenever anything looks off:

```sh
.plumb/bin/doctor <run-id>
```

It is read-only. It checks that every run target's process group is alive, that its port is held by this run and not by something else, that its readiness probe passes, and that every service answers, then runs the app-specific checks below. Exit 0 means the instance is worth driving. Anything else: read its output, then relaunch rather than drive a broken instance.
<!-- plumb:managed:end doctor -->

{{fill: The app-specific checks .plumb/bin/doctor runs after Plumb's (expected build or version, auth working, seeded data present), one bullet each with the exact command and what a pass looks like. These checks must also be appended to .plumb/bin/doctor below its managed block.}}

## Drive

{{plumb:drive}}

## Evidence

<!-- plumb:managed:start evidence -->
Write everything for a run under `.plumb/evidence/<run-id>/<feature-id>/`, where `<run-id>` is the id `plumb verify --launch` printed.

- UI proof: an ARIA snapshot and a screenshot with the app's identity visible, plus the console errors seen during the drive.
- API proof: the request, the response status, and the response body.
- CLI proof: the command, stdout, stderr, and the exit code.
- Mutation proof: a second, read-only view of the stored value (re-fetch, re-open, or a database read).

When the drive is done, write two files in the run directory:

- `report.md`: what was driven, through which entry point, what was observed, and each artifact path.
- `report.json`, which Plumb checks before it accepts the run:

```json
{
  "schemaVersion": 1,
  "runId": "<run-id>",
  "tree": "<the tree plumb verify --launch printed>",
  "features": [
    {
      "id": "<feature-id>",
      "subFeatures": [
        {
          "id": "<sub-feature-id>",
          "status": "verified",
          "entryPoint": "<the user entry point you drove>",
          "artifacts": ["<feature-id>/<file>"],
          "observed": "<what the evidence shows>"
        }
      ]
    }
  ]
}
```

`status` is `verified` (driven on the real user path, with artifacts), `failed` (driven, and the behavior was wrong), or `verified-unreachable` (could not be reached: add `"prerequisite"` naming what was missing). A sub-feature you skipped is never reported as verified through a different path.
<!-- plumb:managed:end evidence -->

## Cleanup

<!-- plumb:managed:start cleanup -->
Always clean up, after a failed drive too. First remove any scratch state the run created (listed below), then tear down what the launch started:

```sh
plumb verify --cleanup <run-id>
```

It stops exactly the process groups and services the launch recorded, never anything by process name, and then confirms that every artifact listed in `report.json` still exists. Evidence is never removed. Exit 1 means something survived teardown or the evidence is gone: report it, don't hide it.
<!-- plumb:managed:end cleanup -->

{{fill: Scratch state this app's drives create and the exact command that removes each (temp databases, data dirs, fixtures, verification scaffolding), or "None: drives only create evidence." when there is none.}}

## Helpers

<!-- plumb:managed:start helpers -->
- `.plumb/bin/doctor <run-id>`: the Doctor check above. Executable; app-specific checks go below its managed block.
- `plumb verify --launch`, `--doctor <run-id>`, `--cleanup <run-id>`: start, check, and tear down a run (Plumb's CLI).
- `plumb verify --plan`: which features the staged changes touch, and their recipe files.
<!-- plumb:managed:end helpers -->

## Proof standards

<!-- plumb:managed:start proof-standards -->
- Exercise the real user path, not internal setters or test-only endpoints.
- Capture the action and the resulting state, not just the final screen.
- Verify side effects (rows written, files created, messages sent) alongside what is visible.
- Use mocks only where a production boundary already isolates the external system.
- Don't trust dry-run or test-mode flags. Observe what they actually skip (files, network, git refs).
- An unreachable entry point is reported as `verified-unreachable` with the attempted route and the unmet prerequisite.
- Never drive an instance that hasn't passed Doctor since it last did something surprising.
<!-- plumb:managed:end proof-standards -->
