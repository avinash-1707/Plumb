import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Loc } from "../map/types.ts";

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function isCodeFile(file: string): boolean {
  return CODE_EXTENSIONS.some((ext) => file.endsWith(ext)) && !/\.d\.[cm]?ts$/.test(file);
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Parses each project file at most once per build; every AST extractor shares it. */
export class SourceCache {
  readonly #root: string;
  readonly #parsed = new Map<string, ts.SourceFile>();

  constructor(root: string) {
    this.#root = root;
  }

  get(file: string): ts.SourceFile {
    let sf = this.#parsed.get(file);
    if (sf === undefined) {
      const text = readFileSync(path.join(this.#root, file), "utf8");
      sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
      this.#parsed.set(file, sf);
    }
    return sf;
  }

  text(file: string): string {
    return readFileSync(path.join(this.#root, file), "utf8");
  }
}

export function locOf(sf: ts.SourceFile, node: ts.Node): Loc {
  return { file: sf.fileName, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 };
}

/** Value of a string literal or a template literal without substitutions. */
export function stringValue(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

export function forEachDescendant(node: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (n: ts.Node): void => {
    visit(n);
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
}

export interface ImportBinding {
  module: string;
  /** "default", "*" for a namespace import, or the exported name. */
  imported: string;
}

/** Local name -> where it was imported from, for ES imports and top-level `const x = require("m")`. */
export function importBindings(sf: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name !== undefined) bindings.set(clause.name.text, { module, imported: "default" });
      const named = clause?.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named)) bindings.set(named.name.text, { module, imported: "*" });
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const el of named.elements) bindings.set(el.name.text, { module, imported: (el.propertyName ?? el.name).text });
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const init = decl.initializer;
        if (
          init !== undefined &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "require" &&
          stringValue(init.arguments[0]) !== undefined &&
          ts.isIdentifier(decl.name)
        ) {
          bindings.set(decl.name.text, { module: stringValue(init.arguments[0]) ?? "", imported: "default" });
        }
      }
    }
  }
  return bindings;
}

/** Lines in `sf` that import `specifier`: import/export-from declarations, import(), require(), import = require(). */
export function importSiteLocs(sf: ts.SourceFile, specifier: string): Loc[] {
  const locs: Loc[] = [];
  forEachDescendant(sf, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && stringValue(node.moduleSpecifier) === specifier) {
      locs.push(locOf(sf, node));
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      stringValue(node.arguments[0]) === specifier
    ) {
      locs.push(locOf(sf, node));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) && node.argument.literal.text === specifier) {
      locs.push(locOf(sf, node));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      stringValue(node.moduleReference.expression) === specifier
    ) {
      locs.push(locOf(sf, node));
    }
  });
  return locs;
}

/** `process.env` (property or element access chains end here). */
export function isProcessEnv(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === "env" && ts.isIdentifier(node.expression) && node.expression.text === "process";
}
