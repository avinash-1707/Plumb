# {{plumb:title}}

{{fill: One paragraph describing what the user sees and can do, in user terms.}}

## Sub-features

{{fill: One bullet per sub-feature: a short kebab-case id in backticks and one line, e.g. - `create-save` persists a title and body.}}

## How to get to it (user POV)

{{plumb:entry-points}}

{{fill: Every user entry point to this feature (buttons, links, keyboard shortcuts, routes, CLI commands, endpoints), one bullet each, in user terms. Keep or reword the entry points the map found above; add the ones it can't see.}}

## Driving it with {{fill: harness name, e.g. Playwright or curl}}

Preconditions: {{fill: the state this feature needs beyond the baseline (signed in as which seeded user, which records exist).}}

{{fill: Labeled bullets, one per sub-feature: the user action, the exact command or script step that performs it with real selectors or URLs, and the observable result that proves it worked, including the read-back for any write.}}

## Gotchas

{{fill: Traps that waste or invalidate a run (caches, eventual consistency, flaky waits, shared state between drives), or "None known yet."}}
