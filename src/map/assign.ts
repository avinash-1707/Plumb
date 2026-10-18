import { matchesAny } from "../glob.ts";

export interface Assignable {
  id: string;
  root: string;
  include: readonly string[];
}

/**
 * Maps each file to the component whose include globs match it; when components nest, the deepest root wins
 * so packages inside an app's folder still own their files.
 */
export function assignFiles(files: readonly string[], components: readonly Assignable[]): { byComponent: Map<string, string[]>; unassigned: string[] } {
  const byDepth = [...components].sort((a, b) => b.root.length - a.root.length);
  const byComponent = new Map<string, string[]>(components.map((c) => [c.id, []]));
  const unassigned: string[] = [];
  for (const file of files) {
    const owner = byDepth.find((c) => matchesAny(file, c.include));
    if (owner === undefined) unassigned.push(file);
    else byComponent.get(owner.id)?.push(file);
  }
  return { byComponent, unassigned };
}
