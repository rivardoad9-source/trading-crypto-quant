# Product Requirement Document (PRD) — Module 5: Functional Core Agents

- **Component Focus**: Module 5.1 (Macro Researcher Agent) & Module 5.2 (Meteora DLMM Screener & Paper Trader)
- **Target Files**:
  - `src/agents/researcherAgent.ts`
  - `src/agents/dlmmTraderAgent.ts`
  - `src/services/meteora.ts`
  - `src/services/marketData.ts`
  - `src/services/deepseek.ts`
  - `src/services/telegram.ts`

---

## 1. Module 5.1: Macro & Market Researcher Agent

### 1.1 Objective
Mengumpulkan metrik makro TradFi, ETF institutional flows, dan sentimen on-chain harian, memprosesnya melalui DeepSeek LLM, menyimpan riwayatnya ke SQLite, serta mengirimkannya via Telegram.

### 1.2 Execution Schedule & Trigger
- Cron: Setiap hari pukul 07:00 WIB (`0 0 * * *` UTC).
- Manual trigger support via function export: `runMacroResearcher(): Promise<void>`.

### 1.3 Data Pipeline & Ingestion (`src/services/marketData.ts`)
1. **Fear & Greed Index**:
   - Endpoint: `https://api.alternative.me/fng/?limit=1`
   - Data points: `value`, `value_classification`.
2. **Trending DEX Data**:
   - Endpoint: DEXScreener API (`https://api.dexscreener.com/token-boosts/top/v1` atau `https://api.dexscreener.com/latest/dex/tokens/solana`)
   - Data points: Top 5 trending volume chains & tokens.
3. **Macro Context Payload**:
   - JSON structure untuk data input makro (DXY, US Treasury yields, S&P 500, BTC/ETH Spot ETF flow metrics).

### 1.4 LLM Processing (`src/services/deepseek.ts`)
- **System Prompt**: Senior Crypto Macro & On-Chain Quantitative Analyst.
- **Rules**: Tanpa basa-basi pembuka/penutup, gaya bahasa analitis profesional, padat, maksimal 300 kata.
- **Output Schema**:
  1. `Macro & Geopolitics` (Ringkasan DXY, pasar global, high-impact US economic events).
  2. `Institutional & On-Chain Flows` (BTC/ETH Spot ETF net flow, Smart Money/Exchange reserves).
  3. `Hottest Chain & Narrative` (Chain teraktif, DEX dominan, rotasi likuiditas).
  4. `Market Verdict & Actionable Bias` (Risk-On / Risk-Off / Sideways + implikasi untuk LPing).

### 1.5 Storage & Dispatching
- Insert raw data & Markdown output ke SQLite table: `daily_research_logs`.
- Kirim pesan Markdown ke Telegram channel/chat via `src/services/telegram.ts`.

---

## 2. Module 5.2: Meteora DLMM Screener & Paper Trading Engine

### 2.1 Objective
Menjalankan screener kuantitatif berkala untuk mencari pool DLMM Meteora terbaik di Solana, mengevaluasi parameter bin melalui DeepSeek, dan mengelola *state machine* simulasi posisi likuiditas ($0 capital) dengan tracking Fee vs Impermanent Loss.

### 2.2 Execution Schedule & Trigger
- Loop interval: Berjalan setiap 10 menit (`*/10 * * * *`).
- Function export: `runDlmmTradingCycle(): Promise<void>`.

### 2.3 Stage 1: Rule-Based Pool Screening (`src/services/meteora.ts`)
1. Fetch live pairs: `GET https://dlmm-api.meteora.ag/pair/all_by_groups`
2. **Hardcoded Quantitative Filters**:
   - `24h_volume >= 10000` (USD)
   - `fee_tvl_ratio >= 0.008` (Fee/TVL minimal 0.8% per 24h)
   - `tvl >= 5000` (USD)
   - Filter token scam/dead: Hanya izinkan pair yang memiliki volume organik dan base token terverifikasi.
3. **Sorting**: Sortir berdasarkan ranking kombinasi `(Fee / TVL) * Volume` dan ambil **Top 3 Candidate Pools**.

### 2.4 Stage 2: DeepSeek Strategy Evaluator
Kirim 3 kandidat pool ke DeepSeek menggunakan *structured JSON output* yang divalidasi dengan Zod:

```typescript
// src/agents/dlmmTraderAgent.ts
import { z } from "zod";

export const DLMMPoolDecisionSchema = z.object({
  selectedPool: z.string().describe("Alamat pool address yang dipilih atau 'NONE'"),
  pairName: z.string(),
  action: z.enum(["ENTER", "SKIP"]),
  strategy: z.enum(["SPOT", "BID_ASK", "CURVE"]),
  binRangeDownsideCoverPct: z.number().min(0).max(100),
  binRangeUpsideCoverPct: z.number().min(0).max(100),
  confidenceScore: z.number().min(0).max(100),
  thesis: z.string().max(200)
});