Drive each feature through the recipe in its feature file (`features/<feature-id>.md`). Prefer stable handles: subcommands, flags, prompt strings, and documented examples. Never rely on terminal coordinates.

<!-- plumb:managed:start drive -->
Build once, then run every drive in its own scratch directory so runs never share state:

- **CLI**: run the command as a user would, from a temp directory under the run's evidence folder. Save the command, stdout, stderr, and the exit code to the feature's evidence folder.
- **Interactive (TUI or prompts)**: drive it in a PTY (`script -q <log> <command>` or a tmux session the run creates and kills), sending input the way a user types it, and save the transcript.
- **Library**: import it from a scratch script the way the README's examples do, and save the script and its output.
- **Side effects**: list the files, network calls, or git refs the command changed, and save that listing too. Don't trust dry-run flags; observe what they skip.
<!-- plumb:managed:end drive -->

{{fill: The repo-specific recipe: the exact build command, how to invoke the built binary or library from a scratch directory, and one worked example drive using a real subcommand or documented example, as a fenced block that can be run as written.}}
