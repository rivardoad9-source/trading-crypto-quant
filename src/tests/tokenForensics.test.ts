/**
 * Forensics checks run against captured responses for CATE-USDC (22 Sep 2026), not against
 * the network: the fixtures are the real Jupiter and RugCheck payloads, so the assertions
 * below are statements about numbers those services actually returned.
 *
 * The number that matters most is organicShare24h. The pool's headline was "26x TVL daily
 * volume" and the card was quoting ~$6.2/day of fees. Jupiter's own split says the real-user
 * slice is ~11% of that volume, which is what the card now has to say out loud.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assessForensics,
  describeForensics,
  gmgnLpLockedPct,
  organicFee,
  organicShare,
  type GmgnSecurityReport,
  type JupiterToken,
  type RugCheckReport,
} from "../services/tokenForensics.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as T;

const jupCate = fixture<JupiterToken>("jupiter-cate.json");
const rcCate = fixture<RugCheckReport>("rugcheck-cate.json");
/** The live GMGN reply for the same token, captured 22 Sep 2026 22:2x WIB. */
const gmgnCate = fixture<{ data: GmgnSecurityReport }>("gmgn-security-cate.json").data;
const CATE = "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump";
const cate = assessForensics(CATE, jupCate, rcCate);
/** Same token, but with the GMGN half present — what a scan sees on a good night. */
const cateFull = assessForensics(CATE, jupCate, rcCate, gmgnCate);

describe("organic volume share", () => {
  it("splits Jupiter's 24h window into organic and total", () => {
    const share = organicShare(jupCate.stats24h);
    assert.ok(share !== null);
    // (722_365 + 587_113) / (5_716_354 + 5_764_186)
    assert.ok(Math.abs(share! - 0.1141) < 0.001, `expected ~0.114, got ${share}`);
    assert.equal(cate.organicShare24h, share);
  });

  it("is null when the window has no volume rather than 0 or 100%", () => {
    assert.equal(organicShare(undefined), null);
    assert.equal(organicShare({ buyVolume: 0, sellVolume: 0, buyOrganicVolume: 0, sellOrganicVolume: 0 }), null);
  });

  it("restates the fee estimate on the organic slice only", () => {
    const organic = organicFee(6.22, cate);
    assert.ok(organic !== null);
    // ~11.4% of $6.22
    assert.ok(Math.abs(organic! - 0.71) < 0.02, `expected ~0.71, got ${organic}`);
    assert.equal(organicFee(null, cate), null);
    assert.equal(organicFee(6.22, null), null);
  });
});

describe("rug surface", () => {
  it("reads the LP lock off RugCheck's market block", () => {
    assert.ok(cate.lpLockedPct !== null);
    assert.ok(Math.abs(cate.lpLockedPct! - 99.88) < 0.05);
  });

  it("does not invent authority state it did not receive", () => {
    assert.equal(cate.mintAuthorityOff, true);
    assert.equal(cate.freezeAuthorityOff, true);
    assert.equal(cate.mintAuthorityOff, jupCate.audit?.mintAuthorityDisabled);
  });

  it("counts the dev wallet's history and the insider networks", () => {
    assert.equal(cate.devMints, 20559);
    assert.equal(cate.devMigrations, 405);
    assert.equal(cate.insiderNetworks, 9);
  });
});

describe("flags", () => {
  it("flags what is really wrong with this token", () => {
    assert.ok(cate.flags.includes("mostly-inorganic-volume"), cate.flags.join(","));
    assert.ok(cate.flags.includes("serial-launcher"), cate.flags.join(","));
    assert.ok(cate.flags.includes("insider-networks"), cate.flags.join(","));
  });

  it("does not flag what is actually fine", () => {
    assert.ok(!cate.flags.includes("rugged"));
    assert.ok(!cate.flags.includes("lp-not-locked"));
    assert.ok(!cate.flags.includes("mint-authority-live"));
    assert.ok(!cate.flags.includes("freeze-authority-live"));
    assert.ok(!cate.flags.includes("holders-concentrated"));
    assert.ok(!cate.flags.includes("inorganic-volume"), "11% is under the quarter bar but above the tenth");
  });

  it("says so instead of going quiet when a source is missing", () => {
    const blind = assessForensics(CATE, null, null);
    assert.equal(blind.organicShare24h, null);
    assert.ok(blind.flags.includes("lp-lock-unknown"));
    assert.ok(!blind.flags.includes("lp-not-locked"));
  });

  it("reads a count as well as an array for the insider networks", () => {
    const fromCount = assessForensics(CATE, jupCate, { ...rcCate, insiderNetworks: 3 });
    assert.equal(fromCount.insiderNetworks, 3);
    const fromArray = assessForensics(CATE, jupCate, { ...rcCate, insiderNetworks: [{}, {}] });
    assert.equal(fromArray.insiderNetworks, 2);
    const fromGraph = assessForensics(CATE, jupCate, {
      ...rcCate,
      insiderNetworks: undefined,
      graphInsidersDetected: 4,
    });
    assert.equal(fromGraph.insiderNetworks, 4);
  });
});

describe("card lines", () => {
  it("states the organic share before anything else the card might brag about", () => {
    const lines = describeForensics(cate);
    assert.match(lines[0]!, /^Volume asli \(organik\) 24 jam: 11,4% — \$1\.309\.478 dari \$11\.480\.540$/);
    assert.ok(lines.some((l) => /Likuiditas pool terkunci: 99,9%/.test(l)));
    assert.ok(lines.some((l) => /pemegang/.test(l)));
    assert.ok(lines.some((l) => /Dompet pembuat: 20\.559 token pernah dibuat, 405 migrasi/.test(l)));
    assert.ok(lines.some((l) => /Jaringan insider terdeteksi: 9/.test(l)));
    assert.ok(lines.some((l) => /tidak ada \(skor 1\)/.test(l)));
  });

  it("returns nothing rather than empty strings when everything is missing", () => {
    assert.deepEqual(describeForensics(assessForensics(CATE, null, null)), []);
  });
});

describe("GMGN: can you actually sell it", () => {
  it("reads the captured CATE reply: sellable, zero tax, LP burned", () => {
    assert.equal(cateFull.gmgnChecked, true);
    assert.equal(cateFull.honeypot, false);
    assert.equal(cateFull.canNotSell, false);
    assert.equal(cateFull.buyTaxPct, 0);
    assert.equal(cateFull.sellTaxPct, 0);
    assert.equal(cateFull.lpBurned, true);
    assert.ok(cateFull.flags.includes("sellable"));
    assert.ok(!cateFull.flags.includes("honeypot"));
    assert.ok(!cateFull.flags.includes("sell-tax"));
    // Bought as 0/1 numbers and "0.1505" strings; both have to survive parsing.
    assert.ok(Math.abs((cateFull.gmgnTop10Pct ?? 0) - 15.05) < 0.01);
  });

  it("treats a burned LP as fully locked, not as unknown", () => {
    assert.equal(cateFull.lpLockedPct, 100);
    assert.ok(!cateFull.flags.includes("lp-lock-unknown"));
    assert.ok(!cateFull.flags.includes("lp-not-locked"));
  });

  it("flags honeypot, sell tax, live mint authority and a whale from a bad reply", () => {
    const bad: GmgnSecurityReport = {
      honeypot: 1,
      can_not_sell: 1,
      buy_tax: "5",
      sell_tax: "12",
      burn_status: "unburned",
      renounced_mint: false,
      renounced_freeze_account: false,
      top_10_holder_rate: "0.55",
      flags: ["blacklist"],
      lock_summary: { is_locked: true, lock_detail: [{ percent: "0.1" }] },
    };
    const f = assessForensics(CATE, jupCate, rcCate, bad);
    for (const flag of ["honeypot", "sell-tax", "high-tax", "mint-authority-live", "freeze-authority-live", "holders-concentrated", "lp-not-locked"]) {
      assert.ok(f.flags.includes(flag), `harus ada bendera ${flag}`);
    }
    assert.ok(!f.flags.includes("sellable"));
    assert.ok(Math.abs((f.lpLockedPct ?? 0) - 10) < 0.001);
  });

  it("says an LP lock out loud from lock_detail and left_lock_percent too", () => {
    assert.equal(gmgnLpLockedPct({ burn_status: "burn" }), 100);
    assert.equal(gmgnLpLockedPct({ lock_summary: { lock_detail: [{ percent: "0.95" }, { percent: "0.4" }] } }), 95);
    assert.equal(gmgnLpLockedPct({ lock_summary: { left_lock_percent: "0.4" } }), 40);
    assert.equal(gmgnLpLockedPct({ lock_summary: { left_lock_percent: 62 } }), 62);
    assert.equal(gmgnLpLockedPct(null), null);
  });

  it("admits when GMGN was not reached instead of looking clean", () => {
    assert.ok(cate.flags.includes("gmgn-unavailable"));
    const lines = describeForensics(cate);
    assert.ok(lines.some((l) => /Jual-beli: belum diperiksa/.test(l)));
    // …and prints the real verdict once it has one.
    assert.ok(describeForensics(cateFull).some((l) => /^Jual-beli: bisa dijual · pajak jual 0,0% · LP dibakar 100%$/.test(l)));
  });

  it("backs off when the free tier bans the IP, instead of retrying into it", async () => {
    const { fetchGmgnSecurity } = await import("../services/tokenForensics.js");
    const realFetch = globalThis.fetch;
    let calls = 0;
    const resetAt = Math.floor(Date.now() / 1000) + 300;
    process.env.GMGN_API_KEY = "test-key";
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: 429, msg: "RATE_LIMIT_BANNED", reset_at: resetAt }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      assert.equal(await fetchGmgnSecurity(CATE), null);
      assert.equal(calls, 1);
      // Second call inside the ban window must not touch the network at all.
      assert.equal(await fetchGmgnSecurity(CATE), null);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GMGN_API_KEY;
    }
  });
});
