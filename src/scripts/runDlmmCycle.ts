import { initDatabase, closeDatabase } from "../database/db.js";
import { runDlmmTradingCycle } from "../agents/dlmmTraderAgent.js";

initDatabase();
const result = await runDlmmTradingCycle();
console.log(JSON.stringify(result, null, 2));
closeDatabase();
