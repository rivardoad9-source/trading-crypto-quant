// Copies non-TS runtime assets into dist/ after tsc.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const assets = [["src/database/schema.sql", "dist/database/schema.sql"]];

for (const [from, to] of assets) {
  const dest = resolve(process.cwd(), to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(resolve(process.cwd(), from), dest);
  console.log(`[build] copied ${from} -> ${to}`);
}
