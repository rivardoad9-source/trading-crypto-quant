/**
 * `scripts/rehearseExitEconomics.ts` is run by hand against REAL signatures, so its safety
 * has to be structural: it must never open ./data/flowmetrix.db and never be able to spend.
 * Offline — nothing here touches the network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = join(root, "scripts", "rehearseExitEconomics.ts");
const src = readFileSync(scriptPath, "utf8");

describe("rehearseExitEconomics — structural safety", () => {
  it("imports nothing from src/ statically: DATABASE_PATH is set before env/db can load", () => {
    const staticImports = src.match(/^import\s[^;]*from\s+["'][^"']+["'];?/gm) ?? [];
    for (const line of staticImports) {
      assert.equal(/from\s+["']\.\.\/src\//.test(line), false, `static src import: ${line}`);
    }
    const setAt = src.indexOf("process.env.DATABASE_PATH = dbPath;");
    const guardAt = src.indexOf("if (!isInsideDir(dbPath, tmpdir()))");
    const firstDynamic = src.indexOf('await import("../src/');
    assert.ok(guardAt > 0 && setAt > guardAt, "the temp-dir guard runs before DATABASE_PATH is set");
    assert.ok(firstDynamic > setAt, "a src module is imported before DATABASE_PATH is set");
    // The env-resolved path is re-checked before db.ts (which opens the file on import) loads.
    assert.ok(src.indexOf("env resolved DATABASE_PATH") < src.indexOf('await import("../src/database/db.js")'));
  });

  it("cannot sign or send: no executor, no bridge, no send/sign calls", () => {
    assert.equal(/onchainExecutor|liveExecution/.test(src), false);
    // The key's env name is assembled, so this file does not itself trip liveConfig's key-reference scan.
    const keyName = ["SOLANA", "PRIVATE", "KEY"].join("_");
    assert.equal(/sendAndConfirm|sendTransaction|sendRawTransaction|\.sign\(|Keypair/.test(src), false);
    assert.equal(src.includes(keyName), false);
  });

  it("writes no signature literal of its own (they are read from exports/trades.csv at runtime)", () => {
    assert.equal(/['"`][1-9A-HJ-NP-Za-km-z]{80,90}['"`]/.test(src), false);
    assert.match(src, /readFileSync\("exports\/trades\.csv"/);
  });

  it("REFUSES a scratch DB outside the OS temp dir, before touching anything", () => {
    const target = join(root, "data", "rehearsal-must-refuse.db");
    const run = spawnSync(process.execPath, ["--import", "tsx", scriptPath, `--scratch-db=${target}`], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(run.status, 2, `expected exit 2, got ${run.status}: ${run.stderr}`);
    assert.match(run.stderr, /REFUSED: scratch DB .* is not inside the OS temp dir/);
    assert.equal(existsSync(target), false, "the refused path was created");
    assert.equal(/\[db\] ready/.test(run.stdout), false, "a database was initialised");
  });
});
