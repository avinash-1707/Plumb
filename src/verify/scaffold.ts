import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CouldNotCompleteError } from "../errors.ts";
import { type Feature, FEATURES_PATH, type FeatureIndex } from "../features.ts";
import { matchGlob } from "../glob.ts";
import { KNOWLEDGE_DIR } from "../knowledge/explorers.ts";
import { checkKnowledge } from "../knowledge/validate.ts";
import type { RepoMap } from "../map/types.ts";
import type { Profile, ReadinessProbe } from "../profile/types.ts";
import { withHashes } from "../managed/regions.ts";
import { render } from "../template.ts";
import { DOCTOR_HELPER, draftDir, skillDir } from "./paths.ts";

const TEMPLATES = new URL("../../templates/verify/", import.meta.url);
/** Seeded features (doc 5: "the top 3 to 5"). */
const MAX_SEEDED = 5;

function template(name: string): string {
  return readFileSync(new URL(name, TEMPLATES), "utf8");
}

interface RiskFeature {
  id: string;
  title: string;
  why: string;
  rank: number;
  entryPoints: string[];
  paths: string[];
}

function loadRiskFeatures(root: string): RiskFeature[] | null {
  const file = path.join(root, KNOWLEDGE_DIR, "risk.json");
  if (!existsSync(file)) return null;
  const check = checkKnowledge(root, "risk");
  if (check.issues.length > 0) throw new CouldNotCompleteError(`${KNOWLEDGE_DIR}/risk.json is invalid; run plumb knowledge validate risk`);
  return (JSON.parse(readFileSync(file, "utf8")) as { features: RiskFeature[] }).features;
}

/**
 * features.json drafted from explorer-risk's ranking and the map (doc 5): entry points the map knows, the files that
 * implement them plus the explorer's globs as `paths`, and the components owning either. Every seeded feature is
 * `deep`: they were picked as the features most worth a live drive. The agent refines it afterwards.
 */
export function draftFeatures(map: RepoMap, risk: readonly RiskFeature[]): { index: FeatureIndex; dropped: string[] } {
  const owners = new Map<string, { component: string; file: string }[]>();
  for (const c of map.components) {
    for (const e of c.entryPoints) owners.set(e.id, [...(owners.get(e.id) ?? []), { component: c.id, file: e.location.file }]);
  }
  const dropped: string[] = [];
  const features: Feature[] = [...risk]
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .slice(0, MAX_SEEDED)
    .map((r) => {
      const entryPoints = r.entryPoints.filter((e) => {
        if (owners.has(e)) return true;
        dropped.push(`${r.id}: ${e} is not in the map`);
        return false;
      });
      const entryFiles = entryPoints.flatMap((e) => (owners.get(e) ?? []).map((o) => o.file));
      const paths = [...new Set([...r.paths, ...entryFiles])].sort();
      const components = new Set(entryPoints.flatMap((e) => (owners.get(e) ?? []).map((o) => o.component)));
      for (const c of map.components) {
        if (Object.keys(c.files).some((f) => paths.some((p) => matchGlob(f, p)))) components.add(c.id);
      }
      return { id: r.id, file: `features/${r.id}.md`, paths, components: [...components].sort(), entryPoints: [...entryPoints].sort(), tier: "deep" as const };
    });
  return { index: { features }, dropped };
}

function probeText(probe: ReadinessProbe): string {
  if (probe.kind === "http") return `HTTP ${String(probe.expectStatus)} from \`${probe.url}\``;
  if (probe.kind === "port") return `port ${String(probe.port)} accepts connections`;
  return `log line matching \`/${probe.pattern}/\``;
}

/** The managed Launch block: every run target and service from the profile, and how a run starts. */
export function launchSection(profile: Profile): string {
  const lines: string[] = [];
  if (profile.services.length > 0) {
    lines.push("Services (started only if they aren't already running; one that was already running is used but never stopped):", "");
    for (const s of profile.services) {
      const start = s.start === null ? "no start command (must already be running)" : `\`${s.start.cmd}\` in \`${s.start.cwd}\``;
      lines.push(`- **${s.name}** (${s.source}): ${start}; ready when ${s.ready === null ? "its start command exits 0" : probeText(s.ready)}; stopped with ${s.stop === null ? "nothing (left running)" : `\`${s.stop.cmd}\``}.`);
    }
    lines.push("");
  }
  if (profile.run.length > 0) {
    lines.push("Run targets, started in this order, each in its own process group:", "", "| Target | Start | Ready when | Port | Timeout |", "|---|---|---|---|---|");
    for (const t of profile.run) {
      const port = t.portEnv === null ? (t.port === null ? "none" : `${String(t.port)} (fixed: a run is refused while it is taken)`) : `free port per run via \`${t.portEnv}\``;
      lines.push(`| ${t.name} | \`${t.start.cmd}\` in \`${t.start.cwd}\` | ${probeText(t.ready)} | ${port} | ${String(t.start.timeoutSec)}s |`);
    }
    lines.push("");
  }
  lines.push(
    "Start a run with `plumb verify --launch`. It prints the run id, the staged tree it drives, and each target's URL on this run's own port, and writes them to `.plumb/evidence/<run-id>/`. Loopback URLs in the environment that pointed at a target's default port are moved to the run's port automatically. If the launch fails it has already torn down what it started; read the step, reason, and log tail it printed.",
    "",
    "Never drive the app on its default ports or an instance this run didn't start: the user's own dev server may be there.",
  );
  return lines.join("\n");
}

function surface(profile: Profile): string {
  if (profile.ui.present) return profile.run.length > 1 ? "web UI and HTTP API" : "web UI";
  if (profile.run.length > 0) return "HTTP API";
  return "command line";
}

function browserLine(profile: Profile): string {
  if (!profile.ui.present) return "this app has no UI; drive it over HTTP.";
  if (profile.ui.harness === "existing-playwright") {
    return "this repo already has Playwright (`@playwright/test`). Write each drive as a Node script in the feature's evidence folder that loads Playwright with `createRequire` from the package that depends on it, launches Chromium headless, and saves `page.locator(\"body\").ariaSnapshot()`, a full-page screenshot, and every console error. It takes the base URL (and any other value) as command-line arguments. Run it with `node <script> <base-url>`.";
  }
  if (profile.ui.harness === "existing-cypress") {
    return "this repo already has Cypress. Write each drive as a spec in the feature's evidence folder and run it with `cypress run --spec <file>` from the package that has Cypress, with screenshots and the DOM snapshot saved to the evidence folder.";
  }
  return "use the Playwright MCP tools (`browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot` for the ARIA snapshot, `browser_take_screenshot`, `browser_console_messages`), saving each output into the feature's evidence folder.";
}

function entryLine(id: string): string {
  const http = /^entry:http:([A-Z]+) (.+)$/.exec(id);
  if (http?.[1] !== undefined && http[2] !== undefined) return `- Endpoint \`${http[1]} ${http[2]}\``;
  const ui = /^entry:ui:(.+)$/.exec(id);
  if (ui?.[1] !== undefined) return `- Page \`${ui[1]}\``;
  return `- \`${id.replace(/^entry:/, "")}\``;
}

/** Whether Plumb adds a Playwright MCP entry: a UI and no usable browser harness in the repo (doc 5). */
export function needsPlaywrightMcp(profile: Profile): boolean {
  return profile.ui.present && (profile.ui.harness === "playwright-mcp" || profile.ui.harness === null);
}

/** Adds the playwright server to .mcp.json unless an entry by that name exists; other entries are never touched. */
function ensurePlaywrightMcp(root: string): boolean {
  const file = path.join(root, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8")) as typeof config;
    } catch (err) {
      throw new CouldNotCompleteError(`.mcp.json is not valid JSON, so Plumb won't edit it: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const servers = config.mcpServers ?? {};
  if (Object.hasOwn(servers, "playwright")) return false;
  servers["playwright"] = { command: "npx", args: ["@playwright/mcp@latest", "--isolated", "--headless"] };
  writeFileSync(file, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`);
  return true;
}

/** SKILL.md as Plumb generates it: managed regions filled from the profile, `{{fill: ...}}` tokens elsewhere. */
export function renderSkill(profile: Profile): string {
  const drive = render(template(profile.run.length > 0 ? "drive-web-app.md" : "drive-library-cli.md"), { browser: browserLine(profile) }).trimEnd();
  return withHashes(render(template("SKILL.md"), { slug: profile.app.slug, app: profile.app.name, surface: surface(profile), launch: launchSection(profile), drive }));
}

/** features/README.md; its index lists every feature in features.json by title. */
export function renderFeaturesReadme(profile: Profile, index: FeatureIndex, titleOf: (f: Feature) => string): string {
  const lines = index.features.map((f) => `- [${titleOf(f)}](${path.posix.basename(f.file)}) (tier: ${f.tier})`);
  return withHashes(render(template("features-README.md"), { app: profile.app.name, index: lines.join("\n") }));
}

export function renderDoctor(profile: Profile): string {
  return withHashes(render(template("doctor.sh"), { slug: profile.app.slug, app: profile.app.name }));
}

/** A feature's title: the H1 of its feature file in `dir`, when the file exists. */
export function featureTitle(root: string, dir: string, f: Feature): string | null {
  const file = path.join(root, dir, f.file);
  if (!existsSync(file)) return null;
  const h1 = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("# "));
  return h1 === undefined ? null : h1.slice(2).trim();
}

export interface ScaffoldResult {
  /** Where the skill files are: the draft directory for a new skill, the published one when it already exists. */
  skillDir: string;
  draft: boolean;
  written: string[];
  kept: string[];
  /** Entry points explorer-risk named that the map doesn't have; left out of features.json. */
  dropped: string[];
}

/**
 * Writes the verify skill skeleton (doc 5) with every deterministic part filled from the profile and map, leaving
 * `{{fill: ...}}` tokens for the agent. A new skill goes to the draft directory (see draftDir). Existing files are
 * kept as they are, so a second run changes nothing.
 */
export function scaffold(root: string, profile: Profile, map: RepoMap): ScaffoldResult {
  const published = existsSync(path.join(root, skillDir(profile.app.slug), "SKILL.md"));
  const dir = published ? skillDir(profile.app.slug) : draftDir(profile.app.slug);
  const written: string[] = [];
  const kept: string[] = [];
  const put = (rel: string, content: string, mode?: number): void => {
    const abs = path.join(root, rel);
    if (existsSync(abs)) {
      kept.push(rel);
      return;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    if (mode !== undefined) chmodSync(abs, mode);
    written.push(rel);
  };

  let dropped: string[] = [];
  let index: FeatureIndex;
  const risk = loadRiskFeatures(root);
  const featuresFile = path.join(root, FEATURES_PATH);
  if (existsSync(featuresFile)) {
    index = JSON.parse(readFileSync(featuresFile, "utf8")) as FeatureIndex;
  } else {
    if (risk === null) throw new CouldNotCompleteError(`${FEATURES_PATH} doesn't exist and there is no ${KNOWLEDGE_DIR}/risk.json to draft it from; run the explorers first (/plumb-init)`);
    const draft = draftFeatures(map, risk);
    index = draft.index;
    dropped = draft.dropped;
    put(FEATURES_PATH, `${JSON.stringify(index, null, 2)}\n`);
  }
  const riskTitles = new Map((risk ?? []).map((r) => [r.id, r.title]));
  const titleOf = (f: Feature): string => featureTitle(root, dir, f) ?? riskTitles.get(f.id) ?? f.id;

  put(`${dir}/SKILL.md`, renderSkill(profile));
  put(`${dir}/features/README.md`, renderFeaturesReadme(profile, index, titleOf));
  for (const f of index.features) {
    const entries = f.entryPoints.length === 0 ? "Entry points the map found: none." : `Entry points the map found:\n\n${f.entryPoints.map(entryLine).join("\n")}`;
    put(`${dir}/${f.file}`, render(template("feature.md"), { title: titleOf(f), "entry-points": entries }));
  }
  put(DOCTOR_HELPER, renderDoctor(profile), 0o755);
  if (needsPlaywrightMcp(profile) && ensurePlaywrightMcp(root)) written.push(".mcp.json");
  return { skillDir: dir, draft: !published, written, kept, dropped };
}
