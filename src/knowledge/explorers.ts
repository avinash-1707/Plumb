export const EXPLORERS = ["structure", "runtime", "tests", "frontend", "risk"] as const;
export type ExplorerName = (typeof EXPLORERS)[number];

export const KNOWLEDGE_DIR = ".plumb/knowledge";

export function isExplorer(name: string): name is ExplorerName {
  return (EXPLORERS as readonly string[]).includes(name);
}
