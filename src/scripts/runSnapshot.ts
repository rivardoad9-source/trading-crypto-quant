import { initDatabase, closeDatabase } from "../database/db.js";
import { runDailySnapshot } from "../agents/snapshotJob.js";

initDatabase();
await runDailySnapshot();
closeDatabase();
