---
name: plumb-status
description: Show what Plumb has set up in this repository and what it last proved: map freshness, profile, verify skill, gate, last deep verification, bypasses, hooks, and managed-region conflicts. Use when the user runs /plumb-status or asks about Plumb's state.
disable-model-invocation: true
allowed-tools: Bash(plumb *)
---

Run `plumb status`, then render its output for the user as a short list. Point out anything that needs action, with the command that fixes it:

- a stale map: `plumb map --update`, then commit `.plumb/map`
- missing hooks: `plumb hooks install`
- conflicts (`*.plumb-new` files): merge each into the file next to it, then delete it
- recent bypasses: which commits skipped the gate
- never deep-verified: `/plumb-verify`

Don't run anything else and don't change any file.
