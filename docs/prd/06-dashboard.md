# Product Requirement Document (PRD) — Module 6: Web Dashboard & Quantitative Command Center

- **Component Focus**: FlowMetrix Web Command Center (Next.js Dashboard, REST API Endpoints, & Real-time Visualization)
- **Target Directories**:
  - `src/api/` (Backend REST API)
  - `dashboard/` (Next.js Frontend Application)

---

## 1. Objective & Design Philosophy
Membangun web dashboard visual modern berbasis Next.js (App Router) dengan tema **Dark Slate / Cyberpunk Quant Aesthetic** yang terhubung ke SQLite database lokal untuk memantau performa agent, open positions, riwayat trade, dan kalender PnL harian secara real-time.

---

## 2. Backend REST API Layer (`src/api/server.ts`)

Gunakan Fastify atau Express (disarankan Fastify untuk performa ringan) yang berjalan di `PORT=4000`.

### 2.1 API Endpoints Specification

1. **`GET /api/overview`**
   - **Tujuan**: Menyediakan data metrik ringkasan untuk Top KPI Cards.
   - **Response Payload**:
     ```json
     {
       "currentBalanceUSD": 1520.40,
       "currentEquityUSD": 1558.74,
       "liveFloatingPnLUSD": 38.34,
       "liveFloatingPnLPct": 2.52,
       "todayRealizedPnLUSD": 14.50,
       "todayClosedTrades": 5,
       "totalSimulatedTrades": 64,
       "winRatePct": 74.07,
       "activePositionsCount": 2,
       "serverStatus": "ONLINE",
       "isDryRun": true
     }