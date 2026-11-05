import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["src", "docs", "README.md", "AGENTS.md"];
const found: string[] = [];

function walk(path: string): void {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry));
    return;
  }
  if (!/\.(ts|md)$/.test(path)) return;
  if (/VIBE\d{4}/.test(readFileSync(path, "utf8"))) found.push(path);
}

for (const root of roots) walk(root);
if (found.length > 0) {
  process.stderr.write(`Reserved vibe.js codes found:\n${found.join("\n")}\n`);
  process.exit(1);
}
