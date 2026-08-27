flowmetrix-ai-agent/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── PRD.md
├── src/
│   ├── config/
│   │   ├── env.ts                 # Validasi Zod schema untuk .env
│   │   └── constants.ts
│   ├── database/
│   │   ├── db.ts                  # Inisialisasi SQLite & migrations
│   │   └── schema.sql
│   ├── services/
│   │   ├── deepseek.ts            # Wrapper DeepSeek client + prompt parser
│   │   ├── meteora.ts             # Meteora DLMM API fetcher & pool calculator
│   │   ├── marketData.ts          # Farside ETF, Fear&Greed, & DEX data fetcher
│   │   └── telegram.ts            # Telegram bot notification dispatcher
│   ├── agents/
│   │   ├── researcherAgent.ts     # Pipeline Macro & On-Chain summary
│   │   └── dlmmTraderAgent.ts     # Screener, LLM Strategy, & Paper Trading Loop
│   ├── api/
│   │   └── server.ts              # Lightweight API server (Fastify/Express) untuk Dashboard
│   └── index.ts                   # Main entry point & orchestrator scheduler
└── dashboard/                     # Next.js Web Dashboard
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx           # Command Center Main Page
    │   │   └── layout.tsx
    │   ├── components/
    │   │   ├── KpiCards.tsx       # Balance, Floating PnL, Winrate
    │   │   ├── TradeHistory.tsx   # Executed Trades Table
    │   │   ├── PnlCalendar.tsx    # Monthly PnL Heatmap Grid
    │   │   └── StatusHeader.tsx   # Server status, session, dry-run indicator
    │   └── lib/
    │       └── api.ts             # API client to fetch SQLite data
    ├── tailwind.config.js
    └── package.json