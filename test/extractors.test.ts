import { execFileSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { dbCandidates, drizzleAccesses, prismaAccesses } from "../src/extractors/db-access.ts";
import { envReads } from "../src/extractors/env.ts";
import { expressEntries, fileRoutes, joinRoutePath } from "../src/extractors/express-routes.ts";
import { matchRoute, urlPattern } from "../src/extractors/fetch-calls.ts";
import { fileNest } from "../src/extractors/nest-routes.ts";
import { appRoute, exportedHttpMethods, pagesRoute } from "../src/extractors/next-routes.ts";
import { parsePrismaModels } from "../src/extractors/prisma-schema.ts";
import { remixConfig, remixRoute, routeModuleExports } from "../src/extractors/remix-routes.ts";
import { moduleState } from "../src/extractors/shared-state.ts";
import { SourceCache } from "../src/extractors/source.ts";
import { matchGlob } from "../src/glob.ts";
import { buildMap } from "../src/map/build.ts";
import { makeProject } from "./helpers/project.ts";

function parse(text: string, file = "src/x.ts"): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function firstArg(code: string): ts.Expression | undefined {
  const statement = parse(code).statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error("not a call");
  return statement.expression.arguments[0];
}

describe("fetch URL patterns", () => {
  it.each([
    ['fetch("/api/orders?x=1")', ["api", "orders"], true],
    ["fetch(`/api/products?q=${q}`)", ["api", "products"], false],
    ["fetch(`${base}/api/orders/${id}`)", ["api", "orders", null], false],
  ])("%s", (code, segments, literal) => {
    expect(urlPattern(firstArg(code))).toEqual({ segments, literal });
  });

  it.each(['fetch("https://api.stripe.com/v1/charges")', 'fetch("orders")', "fetch(`https://${host}/x`)", "fetch(url)"])("ignores %s", (code) => {
    expect(urlPattern(firstArg(code))).toBeNull();
  });
});

describe("matchRoute", () => {
  it("scores literal segments and lets params and holes match anything", () => {
    expect(matchRoute(["api", "orders", "5"], "/api/orders/:id")).toBe(2);
    expect(matchRoute(["api", "orders", null], "/api/orders/:id")).toBe(2);
    expect(matchRoute(["api", "orders", "new"], "/api/orders/new")).toBe(3);
    expect(matchRoute(["api", "orders"], "/api/orders/:id")).toBeNull();
    expect(matchRoute(["api", "users"], "/api/orders")).toBeNull();
  });

  it("handles Next catch-all segments", () => {
    expect(matchRoute(["docs", "a", "b"], "/docs/[...slug]")).toBe(1);
    expect(matchRoute(["docs"], "/docs/[...slug]")).toBeNull();
    expect(matchRoute(["docs"], "/docs/[[...slug]]")).toBe(1);
  });
});

describe("Next.js routes", () => {
  it("drops route groups and slots, keeps dynamic segments, skips private folders", () => {
    expect(appRoute([])).toBe("/");
    expect(appRoute(["(shop)", "orders", "[id]"])).toBe("/orders/[id]");
    expect(appRoute(["@modal", "login"])).toBe("/login");
    expect(appRoute(["_components", "x"])).toBeNull();
  });

  it("finds route handler methods in every export form Next accepts", () => {
    const sf = parse(
      [
        "export async function GET() {}",
        "export const { POST, PUT } = handlers;",
        "export { handler as PATCH, other as helper };",
        'export { DELETE } from "./shared";',
        "export const config = {};",
      ].join("\n"),
    );
    expect(exportedHttpMethods(sf).map((m) => m.method)).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  });

  it("maps pages/ index files to their folder and skips _app", () => {
    expect(pagesRoute(["index"])).toBe("/");
    expect(pagesRoute(["blog", "index"])).toBe("/blog");
    expect(pagesRoute(["_app"])).toBeNull();
  });
});

describe("Express routes", () => {
  it("composes mount prefixes across relative imports and keeps unmounted routers as written", () => {
    const root = makeProject({
      "src/app.ts": [
        'import express from "express";',
        'import { ordersRouter } from "./orders.js";',
        'import admin from "./admin.ts";',
        "const app = express();",
        'app.get("/health", h);',
        'app.use("/api", ordersRouter);',
        'app.use("/admin/", admin);',
      ].join("\n"),
      "src/orders.ts": ['import { Router } from "express";', "export const ordersRouter = Router();", 'ordersRouter.post("/orders", h);', 'ordersRouter.get("/", h);'].join("\n"),
      "src/admin.ts": ['import express from "express";', "const r = express.Router();", 'r.delete("/users/:id", h);', "export default r;"].join("\n"),
      "src/loose.ts": ['import { Router } from "express";', "const loose = Router();", 'loose.get(path, h);', 'loose.patch("/loose", h);'].join("\n"),
    });
    const files = ["src/admin.ts", "src/app.ts", "src/loose.ts", "src/orders.ts"];
    const sources = new SourceCache(root);
    const scan = expressEntries(files, (f) => fileRoutes(sources.get(f)));
    expect(scan.unresolved).toEqual([]);
    const ids = scan.entries.map((e) => e.id).sort();
    expect(ids).toEqual([
      "entry:http:DELETE /admin/users/:id",
      "entry:http:GET /api",
      "entry:http:GET /health",
      "entry:http:PATCH /loose",
      "entry:http:POST /api/orders",
    ]);
  });

  it("reports prefixed mounts it can't trace instead of keeping wrong paths silently", () => {
    const root = makeProject({
      "src/app.ts": [
        'import express from "express";',
        'import cors from "cors";',
        'import { users } from "@/routes/users";',
        'import { makeRouter } from "./factory.ts";',
        'import legacy from "./legacy.js";',
        "const app = express();",
        "function auth(req, res, next) { next(); }",
        'app.use("/static", express.static("public"));',
        'app.use("/api", cors(), auth);',
        'app.use("/users", users);',
        'app.use("/v2", makeRouter());',
        'app.use("/old", legacy);',
        "app.use(makeRouter());",
        'app.listen(app.get("port"));',
      ].join("\n"),
      "src/legacy.js": 'const { Router } = require("express");\nconst r = Router();\nr.get("/x", h);\nmodule.exports = r;',
    });
    const sources = new SourceCache(root);
    const scan = expressEntries(["src/app.ts", "src/legacy.js"], (f) => fileRoutes(sources.get(f), new Set(["express", "cors"])));
    expect(scan.unresolved.map((u) => [u.loc.line, u.prefix, u.what])).toEqual([
      [10, "/users", "users"],
      [11, "/v2", "makeRouter()"],
      [12, "/old", 'default from "./legacy.js"'],
    ]);
    // app.get("port") reads a setting; it is not a route.
    expect(scan.entries.map((e) => e.id)).not.toContain("entry:http:GET /port");
  });

  it("composes prefixes through a mount cycle the same way whichever file comes first", () => {
    const files = {
      "src/app.ts": 'import express from "express";\nimport { a } from "./a.ts";\nconst app = express();\napp.use("/root", a);',
      "src/a.ts": 'import { Router } from "express";\nimport { b } from "./b.ts";\nexport const a = Router();\na.use("/b", b);\na.get("/ping", h);',
      "src/b.ts": 'import { Router } from "express";\nimport { a } from "./a.ts";\nexport const b = Router();\nb.use("/a", a);\nb.get("/pong", h);',
    };
    const root = makeProject(files);
    const sources = new SourceCache(root);
    const routesOf = (f: string): ReturnType<typeof fileRoutes> => fileRoutes(sources.get(f));
    const forward = expressEntries(["src/a.ts", "src/app.ts", "src/b.ts"], routesOf).entries.map((e) => e.id).sort();
    const backward = expressEntries(["src/b.ts", "src/app.ts", "src/a.ts"], routesOf).entries.map((e) => e.id).sort();
    expect(forward).toEqual(backward);
    expect(forward).toContain("entry:http:GET /root/b/pong");
  });

  it("joins paths without doubled or trailing slashes", () => {
    expect(joinRoutePath("/api/", "/")).toBe("/api");
    expect(joinRoutePath("", "/x/")).toBe("/x");
  });
});

describe("NestJS routes", () => {
  it("joins controller and method paths in every literal form, only for @nestjs/common decorators", () => {
    const sf = parse(
      [
        'import { Controller, Get, Post, Delete as Del } from "@nestjs/common";',
        'import { Get as OtherGet } from "./not-nest";',
        '@Controller("articles")',
        "export class ArticleController {",
        "  @Get() list() {}",
        '  @Get(":slug/comments") comments() {}',
        '  @Post(["a", "b"]) many() {}',
        '  @Del(":slug") remove() {}',
        '  @OtherGet("ignored") notNest() {}',
        "}",
        '@Controller({ path: "/tags/", host: "x" })',
        'export class TagController { @Get("/") all() {} }',
        "@Controller()",
        'export class AppController { @Get() root() {} }',
      ].join("\n"),
    );
    const facts = fileNest(sf);
    expect(facts.unresolved).toEqual([]);
    expect(facts.routes.map((r) => `${r.method} ${r.path} :${String(r.loc.line)}`)).toEqual([
      "GET /articles :5",
      "GET /articles/:slug/comments :6",
      "POST /articles/a :7",
      "POST /articles/b :7",
      "DELETE /articles/:slug :8",
      "GET /tags :12",
      "GET / :14",
    ]);
  });

  it("reports paths and settings it can't model instead of guessing", () => {
    const sf = parse(
      [
        'import { Controller, Get } from "@nestjs/common";',
        'import { RouterModule } from "@nestjs/core";',
        "@Controller(BASE)",
        "export class A { @Get(path) x() {} }",
        'app.setGlobalPrefix("api", { exclude: ["health"] });',
        "app.setGlobalPrefix(prefix);",
        "app.enableVersioning();",
        "RouterModule.register([]);",
      ].join("\n"),
    );
    const facts = fileNest(sf);
    expect(facts.unresolved.map((u) => u.loc.line)).toEqual([3, 4, 7, 8]);
    expect(facts.prefixes).toEqual([
      { value: "api", loc: { file: "src/x.ts", line: 5 }, options: true },
      { value: null, loc: { file: "src/x.ts", line: 6 }, options: false },
    ]);
  });

  it("reports inherited routes and composed route decorators", () => {
    const sf = parse(
      [
        'import { Controller, Get, applyDecorators } from "@nestjs/common";',
        '@Controller("users")',
        "export class UsersController extends CrudController {}",
        'export const ApiGet = (p: string) => applyDecorators(Get(p), ApiOkResponse());',
      ].join("\n"),
    );
    expect(fileNest(sf).unresolved.map((u) => [u.loc.line, u.what])).toEqual([
      [2, "a controller that extends another class, whose inherited routes aren't read"],
      [4, "a composed route decorator (applyDecorators), whose routes aren't read"],
    ]);
  });

  it("applies no prefix when the component boots more than one app", async () => {
    const root = makeProject({
      "package.json": JSON.stringify({ name: "mono", dependencies: { "@nestjs/core": "10", "@nestjs/common": "10" } }),
      "apps/api/main.ts": 'import { NestFactory } from "@nestjs/core";\nconst app = await NestFactory.create(A);\napp.setGlobalPrefix("api");',
      "apps/admin/main.ts": 'import { NestFactory } from "@nestjs/core";\nconst app = await NestFactory.create(B);',
      "apps/admin/x.controller.ts": 'import { Controller, Get } from "@nestjs/common";\n@Controller("x")\nexport class X { @Get() list() {} }',
    });
    const { map } = await buildMap({ root, cache: "off" });
    expect(map.components[0]?.entryPoints.map((e) => e.id)).toEqual(["entry:http:GET /x"]);
    expect(map.manifest.extractorFailures.filter((f) => f.extractor === "nest-routes").map((f) => f.reason)).toEqual([
      "a global prefix with more than one app (apps/admin/main.ts:2, apps/api/main.ts:2); routes use none",
    ]);
  });

  it("puts every route of a component under its global prefix", async () => {
    const root = makeProject({
      "package.json": JSON.stringify({ name: "api", dependencies: { "@nestjs/core": "10", "@nestjs/common": "10" } }),
      "src/main.ts": 'const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix("api");',
      "src/user.controller.ts": 'import { Controller, Put } from "@nestjs/common";\n@Controller()\nexport class U { @Put("user") update() {} }',
    });
    const { map } = await buildMap({ root, cache: "off" });
    expect(map.components[0]?.entryPoints.map((e) => e.id)).toEqual(["entry:http:PUT /api/user"]);
    expect(map.manifest.extractorFailures.filter((f) => f.extractor === "nest-routes")).toEqual([]);
  });
});

describe("Remix routes", () => {
  it("maps flat-route names to URLs", () => {
    expect(remixRoute("_index")).toEqual({ url: "/" });
    expect(remixRoute("notes._index")).toEqual({ url: "/notes" });
    expect(remixRoute("notes.$noteId")).toEqual({ url: "/notes/:noteId" });
    expect(remixRoute("_auth.login")).toEqual({ url: "/login" });
    expect(remixRoute("notes_.$id.edit")).toEqual({ url: "/notes/:id/edit" });
    expect(remixRoute("files.$")).toEqual({ url: "/files/[...splat]" });
    expect(remixRoute("[sitemap.xml]")).toEqual({ url: "/sitemap.xml" });
    expect(remixRoute("($lang).about")).toEqual({ optional: true });
  });

  it("gives a pathless layout no URL of its own", () => {
    expect(remixRoute("_auth")).toEqual({ layout: true });
    expect(remixRoute("notes._layout")).toEqual({ layout: true });
  });

  it("reads literal ignoredRouteFiles and flags manual routes", () => {
    const config = remixConfig(parse('export default {\n  ignoredRouteFiles: ["**/.*", "**/*.test.{ts,tsx}"],\n  routes(defineRoutes) { return {}; },\n};', "remix.config.js"));
    expect(config).toEqual({ ignored: ["**/.*", "**/*.test.{ts,tsx}"], unreadable: [{ line: 3, what: "manual routes()" }] });
    // A vite.config without the Remix plugin isn't Remix's to configure.
    expect(remixConfig(parse("export default { routes: [] };", "vite.config.ts"))).toEqual({ ignored: [], unreadable: [] });
  });

  it("finds the default export, loader, and action in every export form", () => {
    const page = routeModuleExports(parse(["export const loader = async () => {};", "export async function action() {}", "export default function Page() {}"].join("\n")));
    expect(page).toEqual({ component: true, loader: 1, action: 2 });
    const resource = routeModuleExports(parse(['export { handler as loader } from "./x";', "export const meta = {};"].join("\n")));
    expect(resource).toEqual({ component: false, loader: 1, action: null });
  });

  it("makes pages UI routes, resource loaders GET, actions POST, and skips colocated modules", async () => {
    const root = makeProject({
      "package.json": JSON.stringify({ name: "web", dependencies: { "@remix-run/react": "2" } }),
      "app/routes/_index.tsx": "export default function Home() {}",
      "app/routes/notes.$noteId.tsx": "export const loader = () => null;\nexport const action = () => null;\nexport default function Note() {}",
      "app/routes/healthcheck.tsx": "export const loader = () => new Response();",
      "app/routes/settings/route.tsx": "export default function Settings() {}",
      "app/routes/settings/form.tsx": "export default function Form() {}",
      "app/routes/billing/index.tsx": "export default function Billing() {}",
      "app/routes/_auth.tsx": "export const action = () => null;\nexport default function AuthLayout() {}",
      "app/routes/_auth.login.tsx": "export default function Login() {}",
      "app/routes/notes.test.tsx": "export default function NotARoute() {}",
      "app/routes/($lang).about.tsx": "export default function About() {}",
      "remix.config.js": 'export default { ignoredRouteFiles: ["**/*.test.{ts,tsx}"] };',
    });
    const { map } = await buildMap({ root, cache: "off" });
    expect(map.components[0]?.entryPoints.map((e) => e.id).sort()).toEqual([
      "entry:http:GET /healthcheck",
      "entry:http:POST /notes/:noteId",
      "entry:ui:/",
      "entry:ui:/billing",
      "entry:ui:/login",
      "entry:ui:/notes/:noteId",
      "entry:ui:/settings",
    ]);
    // The pathless layout sorts before _index but must not take over "/".
    expect(map.components[0]?.entryPoints.find((e) => e.id === "entry:ui:/")?.location.file).toBe("app/routes/_index.tsx");
    expect(map.manifest.extractorFailures.filter((f) => f.extractor === "remix-routes").map((f) => f.reason)).toEqual([
      "app/routes/($lang).about.tsx: optional segments aren't modelled; its route is not in the map",
    ]);
  });
});

describe("Remix route conventions", () => {
  it("reports Remix 1 and other conventions instead of mapping their files as flat routes", async () => {
    for (const deps of [{ "@remix-run/react": "1.19.3", "@remix-run/dev": "^1.19.3" }, { "@remix-run/react": "2", "remix-flat-routes": "0.6" }]) {
      const root = makeProject({ "package.json": JSON.stringify({ name: "web", dependencies: deps }), "app/routes/index.tsx": "export default function Home() {}" });
      const { map } = await buildMap({ root, cache: "off" });
      expect(map.components[0]?.entryPoints).toEqual([]);
      expect(map.manifest.extractorFailures.map((f) => f.extractor)).toContain("remix-routes");
    }
  });
});

describe("Prisma schema", () => {
  it("reads models, honours @@map, and ignores commented-out models", () => {
    const models = parsePrismaModels("schema.prisma", ["// model Ghost {", "model OrderItem {", "  id Int @id", '  @@map("order_items")', "}", "model User {", "}"].join("\n"));
    expect(models.map((m) => [m.model, m.accessor, m.table, m.line])).toEqual([
      ["OrderItem", "orderItem", "order_items", 2],
      ["User", "user", "User", 6],
    ]);
  });
});

describe("database access", () => {
  it("classifies Prisma operations on known models only, including inside transactions", () => {
    const sf = parse(
      [
        "await prisma.user.findMany();",
        "await prisma.$transaction(async (tx) => tx.orderItem.create({ data }));",
        "await prisma.ghost.findMany();",
        "await prisma.user.$count();",
      ].join("\n"),
    );
    const found = prismaAccesses("src/x.ts", dbCandidates(sf), new Map([["user", "User"], ["orderItem", "order_items"]])).map((a) => [a.kind, a.table, a.loc.line]);
    expect(found).toEqual([
      ["reads", "User", 1],
      ["writes", "order_items", 2],
    ]);
  });

  it("resolves Drizzle tables through local and imported bindings", () => {
    const sf = parse(
      [
        'import { orders as o } from "./schema";',
        'import { pgTable } from "drizzle-orm/pg-core";',
        'const users = pgTable("users", {});',
        "await db.select().from(users);",
        "await db.insert(o).values(v);",
        "await db.query.orders.findMany();",
        "cache.delete(key);",
        "Array.from(users);",
      ].join("\n"),
    );
    const found = drizzleAccesses("src/x.ts", dbCandidates(sf), new Map([["orders", "orders"]])).map((a) => [a.kind, a.table, a.loc.line]);
    expect(found).toEqual([
      ["reads", "users", 4],
      ["writes", "orders", 5],
      ["reads", "orders", 6],
    ]);
  });
});

describe("env reads", () => {
  it("finds property, element, import.meta, and destructured reads", () => {
    const sf = parse(['const a = process.env.API_URL;', 'const b = process.env["PORT"];', "const c = import.meta.env.VITE_KEY;", "const { DATABASE_URL, NODE_ENV: mode } = process.env;"].join("\n"));
    expect(envReads(sf).map((r) => [r.name, r.loc.line])).toEqual([
      ["API_URL", 1],
      ["PORT", 2],
      ["VITE_KEY", 3],
      ["DATABASE_URL", 4],
      ["NODE_ENV", 4],
    ]);
  });
});

describe("shared state", () => {
  it("finds module-scope caches, lets, timers, and listeners but not function-local state", () => {
    const sf = parse(
      [
        "const cache = new Map<string, number>();",
        "let hits = 0;",
        "export function hit(k: string) { hits++; cache.set(k, 1); const local = new Map(); local.set(k, 2); }",
        "cache.clear();",
        "setInterval(() => cache.clear(), 1000).unref();",
        'process.on("SIGTERM", stop);',
        "const tick = setTimeout(run, 5);",
        "function f() { setInterval(g, 1); }",
      ].join("\n"),
    );
    expect(moduleState(sf).map((s) => [s.id.replace("state:src/x.ts#", ""), s.kind, s.location.line, s.mutatedFrom.map((l) => l.line)])).toEqual([
      ["cache", "cache", 1, [3, 4, 5]],
      ["hits", "global-mutable", 2, [3]],
      ["setInterval@5", "timer", 5, []],
      ["process.on:SIGTERM", "listener", 6, []],
      ["tick", "timer", 7, []],
    ]);
  });
});

describe("matchGlob", () => {
  it("lets wildcards match dotfiles", () => {
    expect(matchGlob("apps/api/.env.example", "apps/api/**")).toBe(true);
    expect(matchGlob("apps/api/src/.cache/x.ts", "apps/api/**")).toBe(true);
    expect(matchGlob("apps/apiX/a.ts", "apps/api/**")).toBe(false);
  });
});

describe("component detection", () => {
  const pkg = (name: string, deps: Record<string, string> = {}): string => JSON.stringify({ name, dependencies: deps });

  it("uses conventional roots when there is no workspace file", async () => {
    const root = makeProject({
      "package.json": pkg("repo"),
      "apps/site/package.json": pkg("site", { next: "1" }),
      "apps/site/app/page.tsx": "export default function P() { return null; }",
      "services/billing/package.json": pkg("billing", { express: "1" }),
      "services/billing/index.ts": "",
      "packages/ui/package.json": pkg("ui"),
    });
    const { map } = await buildMap({ root, config: { schemaVersion: 1 } });
    expect(map.components.map((c) => [c.id, c.kind, c.root])).toEqual([
      ["component:billing", "service", "services/billing"],
      ["component:site", "app", "apps/site"],
      ["component:ui", "package", "packages/ui"],
    ]);
    expect(map.components.find((c) => c.id === "component:site")?.entryPoints.map((e) => e.id)).toEqual(["entry:ui:/"]);
  });

  it("treats a single-package repo as one root component", async () => {
    const root = makeProject({ "package.json": pkg("tool"), "src/index.ts": "export const x = 1;" });
    const { map } = await buildMap({ root, config: { schemaVersion: 1 } });
    expect(map.components.map((c) => [c.id, c.root, c.include])).toEqual([["component:root", ".", ["**"]]]);
    expect(map.manifest.unassignedFiles).toEqual([]);
  });

  it("lets config components override detection, with bare names", async () => {
    const root = makeProject({ "package.json": pkg("tool"), "src/server/a.ts": "", "src/client/b.ts": "" });
    const { map } = await buildMap({ root, config: { schemaVersion: 1, components: [{ id: "server", include: ["src/server/**"] }] } });
    expect(map.components.map((c) => [c.id, c.root, Object.keys(c.files)])).toEqual([["component:server", "src/server", ["src/server/a.ts"]]]);
    expect(map.manifest.unassignedFiles).toEqual(["package.json", "src/client/b.ts"]);
  });

  it("roots a multi-include config component at the folder all includes share", async () => {
    const root = makeProject({ "package.json": pkg("tool"), "src/server/a.ts": "", "src/shared/b.ts": "", "src/main.ts": "" });
    const { map } = await buildMap({
      root,
      config: { schemaVersion: 1, components: [{ id: "server", include: ["src/server/**", "src/shared/**"] }, { id: "entry", include: ["src/main.ts"] }] },
    });
    expect(map.components.map((c) => [c.id, c.root])).toEqual([["component:entry", "src"], ["component:server", "src"]]);
    expect(map.manifest.extractorFailures).toEqual([]);
  });

  it("rejects duplicate config component ids", async () => {
    const root = makeProject({ "package.json": pkg("tool") });
    await expect(
      buildMap({ root, config: { schemaVersion: 1, components: [{ id: "a", include: ["x/**"] }, { id: "a", include: ["y/**"] }] } }),
    ).rejects.toThrow('component id "a" appears more than once');
  });

  it("skips submodules instead of failing to hash them", async () => {
    const root = makeProject({ "package.json": pkg("tool"), "src/a.ts": "" });
    const sub = makeProject({ "README.md": "vendored" });
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/lib"], { cwd: root, stdio: "ignore" });
    const { map } = await buildMap({ root, config: { schemaVersion: 1 } });
    expect(Object.keys(map.components[0]?.files ?? {})).toEqual([".gitmodules", "package.json", "src/a.ts"]);
  });

  it("attributes a nested component's imports to it, not to the component around it", async () => {
    const root = makeProject({
      "package.json": pkg("tool"),
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", allowImportingTsExtensions: true, noEmit: true } }),
      "src/app.ts": 'import { x } from "./shared/x.ts";\nexport const y = x;',
      "src/shared/x.ts": 'import { db } from "../../db/index.ts";\nexport const x = db;',
      "db/index.ts": "export const db = 1;",
    });
    const { map } = await buildMap({
      root,
      config: {
        schemaVersion: 1,
        components: [{ id: "app", include: ["src/**"] }, { id: "shared", include: ["src/shared/**"] }, { id: "db", include: ["db/**"] }],
      },
    });
    const imports = (id: string): string[] => map.components.find((c) => c.id === id)?.edges.filter((e) => e.kind === "imports").map((e) => e.to) ?? [];
    expect(map.manifest.extractorFailures).toEqual([]);
    expect(imports("component:app")).toEqual(["component:shared"]);
    expect(imports("component:shared")).toEqual(["component:db"]);
  });

  it("disambiguates components that share a folder name", async () => {
    const root = makeProject({
      "package.json": JSON.stringify({ name: "r", workspaces: ["apps/*", "packages/*"] }),
      "apps/web/package.json": pkg("web-app"),
      "packages/web/package.json": pkg("web-lib"),
    });
    const { map } = await buildMap({ root, config: { schemaVersion: 1 } });
    expect(map.components.map((c) => c.id)).toEqual(["component:apps/web", "component:packages/web"]);
  });
});
