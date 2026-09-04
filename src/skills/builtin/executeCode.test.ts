import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AGENT_DB_PATH = ":memory:";
process.env.ENABLE_CODE_EXECUTION = "false";

const { executeCodeSkill } = await import("./executeCode.js");

test("l'exécution de code est désactivée par défaut", async () => {
  const result = await executeCodeSkill.handler({ code: "console.log('salut')" }, { rememberFact: () => {} });
  assert.match(result, /désactivée/);
});
