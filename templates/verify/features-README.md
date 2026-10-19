# Feature map

What to drive when verifying {{plumb:app}}. Each feature file names the user paths, stable handles, required state, commands, and observable proof. Implementation details stay out of it.

## Baseline preconditions

<!-- plumb:managed:start baseline -->
- Launched with `plumb verify --launch` (see `../SKILL.md`, Launch), and `.plumb/bin/doctor <run-id>` passes.
- Evidence goes to `.plumb/evidence/<run-id>/<feature-id>/`.
<!-- plumb:managed:end baseline -->

{{fill: The state every drive starts from: seeded data (which accounts and records exist), whether a session is signed in, and anything that must be reset between drives.}}

## Driving conventions

{{fill: Conventions shared by every feature: how to reach the app (base URLs come from the launch output), which handles to prefer in this app, and how to name evidence files.}}

## Proof and skip reporting

<!-- plumb:managed:start reporting -->
- A feature is verified only when every sub-feature you drove has artifacts in its evidence folder.
- A proof that drives one convenient entry point is incomplete when the feature lists others.
- A sub-feature you couldn't reach is `verified-unreachable` with the attempted route and the unmet prerequisite, never verified through a different path.
<!-- plumb:managed:end reporting -->

## Features

<!-- plumb:managed:start index -->
{{plumb:index}}
<!-- plumb:managed:end index -->
