# Product Requirement Document (PRD): Modular AI Crypto Research, Meteora DLMM Agent & Quant Dashboard

- **Project Name**: FlowMetrix / Meteora AI Engine
- **Target Runtime**: Node.js 20+ (TypeScript, ESM)
- **Primary AI Provider**: DeepSeek API (`deepseek-chat` / `deepseek-reasoner`) via OpenAI-compatible SDK
- **Blockchain Target**: Solana (Meteora DLMM Protocol)
- **Default Execution Mode**: `DRY_RUN=true` (Zero-capital Paper Trading)

---

## 1. Executive Summary & Objective
Membangun sistem AI Agent *full-stack* modular untuk:
1. **Macro & Market Researcher**: Mengumpulkan data makroekonomi TradFi, ETF flow, dan sentimen on-chain harian, lalu merangkumnya menjadi laporan terstruktur via DeepSeek API.
2. **Meteora DLMM Paper Trading Engine**: Menyeleksi pool likuiditas aktif di Solana Meteora DLMM dengan filter kuantitatif ketat, menentukan rentang bin via reasoning LLM, dan menjalankan simulasi penempatan posisi likuiditas (melacak *fee yield vs impermanent loss*).
3. **Quantitative Web Command Center**: Web dashboard lokal modern (Dark Theme) untuk memantau metrik portofolio secara real-time, log eksekusi trading, serta visualisasi kalender *daily PnL heatmap*.

---

## 2. System Architecture & Tech Stack

```text
[ External Data / APIs ]
  ├─ CoinGecko / Farside ETF / Fear&Greed API
  └─ Meteora DLMM API & Helius Solana RPC
                │
                ▼
[ Backend Core Engine (Node.js/TypeScript) ]
  ├─ Cron Scheduler (node-cron)
  ├─ DeepSeek LLM Reasoning Client
  ├─ DLMM Screener & Paper Trading State Machine
  └─ SQLite Database (better-sqlite3)
          │                       │
          ▼                       ▼
[ Telegram Alerts ]    [ REST / WebSocket API ]
                                  │
                                  ▼
                    [ Web Dashboard (Next.js/Tailwind) ]
                      ├─ Portfolio KPI Cards
                      ├─ Live Floating & Executed Trades Table
                      └─ Monthly PnL Heatmap Calendar