import { db, initDatabase, closeDatabase } from "../database/db.js";

initDatabase();
db.exec(`
  DELETE FROM simulated_positions;
  DELETE FROM daily_pnl_snapshots;
  DELETE FROM daily_research_logs;
  DELETE FROM sqlite_sequence;
`);
console.log("[db] all tables cleared");
closeDatabase();
