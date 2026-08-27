import { initDatabase, closeDatabase } from "../database/db.js";
import { runMacroResearcher } from "../agents/researcherAgent.js";

initDatabase();
const result = await runMacroResearcher();
if (result) console.log(`\n${result.markdown}\n`);
closeDatabase();
