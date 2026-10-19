Drive each feature through the recipe in its feature file (`features/<feature-id>.md`). Prefer handles in this order: ARIA roles and accessible names, `data-testid`, route paths, visible text. Never coordinates or tab order.

<!-- plumb:managed:start drive -->
Harness order: the repo's own harness first, then a generic one.

- **Browser** (pages and forms): {{plumb:browser}}
- **HTTP** (endpoints): `curl -sS -i <url>` against the run's own port. Save the request line, status, headers, and body to the feature's evidence folder.
- **Mutations**: after the action, read the stored value back through a second, read-only path (re-fetch the resource, reload the page) and save that too.

Use the URLs `plumb verify --launch` printed, never the profile's default ports: another copy of the app may be running there.

Run drives as `node <script> <base-url> ...` or `curl ...`, with every value as an argument. Never prefix a command with `NAME=value`: agent sessions often allow `node` and `curl` but refuse anything else.
<!-- plumb:managed:end drive -->

{{fill: The repo-specific driving recipe: how a session signs in (exact credentials source or seeded user, never a secret value), the base URLs by run target, and one worked example of a browser drive and one of an HTTP drive using this repo's real routes and selectors, each as a fenced block that can be run as written.}}
