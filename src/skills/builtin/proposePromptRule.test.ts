import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config.js";
import { proposePromptRuleSkill } from "./proposePromptRule.js";

function withTempRulesPath<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "propose-prompt-rule-"));
  const rulesPath = join(dir, "dynamic_rules.json");
  const previousEnabled = config.promptEvolution.enabled;
  const previousPath = config.promptEvolution.rulesPath;
  config.promptEvolution.enabled = true;
  config.promptEvolution.rulesPath = rulesPath;
  return Promise.resolve(fn()).finally(() => {
    config.promptEvolution.enabled = previousEnabled;
    config.promptEvolution.rulesPath = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("propose_prompt_rule ajoute une règle nouvelle", async () => {
  await withTempRulesPath(async () => {
    const result = await proposePromptRuleSkill.handler!({ rule: "Toujours vérifier le format avant de répondre." }, {} as any);
    assert.match(result, /Règle ajoutée/);
    const rules = JSON.parse(readFileSync(config.promptEvolution.rulesPath, "utf-8")) as string[];
    assert.deepEqual(rules, ["Toujours vérifier le format avant de répondre."]);
  });
});

test("propose_prompt_rule ignore un doublon insensible à la casse", async () => {
  await withTempRulesPath(async () => {
    await proposePromptRuleSkill.handler!({ rule: "Toujours vérifier le format." }, {} as any);
    const second = await proposePromptRuleSkill.handler!({ rule: "toujours vérifier le format." }, {} as any);
    assert.match(second, /non ajoutée/);
    const rules = JSON.parse(readFileSync(config.promptEvolution.rulesPath, "utf-8")) as string[];
    assert.equal(rules.length, 1);
  });
});

test("propose_prompt_rule refuse silencieusement quand l'évolution de prompt est désactivée", async () => {
  const previousEnabled = config.promptEvolution.enabled;
  config.promptEvolution.enabled = false;
  try {
    const result = await proposePromptRuleSkill.handler!({ rule: "Une règle quelconque." }, {} as any);
    assert.match(result, /désactivée/);
  } finally {
    config.promptEvolution.enabled = previousEnabled;
  }
});

test("propose_prompt_rule rejette une entrée vide", async () => {
  await withTempRulesPath(async () => {
    const result = await proposePromptRuleSkill.handler!({ rule: "   " }, {} as any);
    assert.match(result, /Erreur/);
  });
});
