import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { officeLlm, parseJsonObject } from "./bureauContract.js";

test("officeLlm : utilise le modèle spécialisé Chantier 8 (ex. researchModel) quand il est configuré", () => {
  const originalProvider = config.llm.provider;
  const originalModel = config.llm.model;
  const originalResearchModel = config.llm.researchModel;
  try {
    config.llm.provider = "anthropic";
    config.llm.model = "claude-main";
    config.llm.researchModel = "claude-research-special";
    const llm = officeLlm("research");
    assert.equal(llm.model, "claude-research-special");
  } finally {
    config.llm.provider = originalProvider;
    config.llm.model = originalModel;
    config.llm.researchModel = originalResearchModel;
  }
});

test("officeLlm : retombe sur le modèle principal Jarvis quand aucun modèle spécialisé n'est configuré (aucun bureau ne doit cesser de fonctionner)", () => {
  const originalProvider = config.llm.provider;
  const originalModel = config.llm.model;
  const originalResearchModel = config.llm.researchModel;
  const originalUtilityModel = config.llm.utilityModel;
  try {
    config.llm.provider = "anthropic";
    config.llm.model = "claude-main";
    config.llm.researchModel = "";
    config.llm.utilityModel = "";
    assert.equal(officeLlm("research").model, "claude-main");
    assert.equal(officeLlm("utility").model, "claude-main");
    assert.equal(officeLlm().model, "claude-main");
  } finally {
    config.llm.provider = originalProvider;
    config.llm.model = originalModel;
    config.llm.researchModel = originalResearchModel;
    config.llm.utilityModel = originalUtilityModel;
  }
});

test("parseJsonObject : extrait un objet JSON entouré de texte ou d'un bloc ```json, échoue explicitement sinon", () => {
  assert.deepEqual(parseJsonObject('Voici : ```json\n{"a":1}\n``` merci'), { a: 1 });
  assert.deepEqual(parseJsonObject('blabla {"a":1} blabla'), { a: 1 });
  assert.throws(() => parseJsonObject("pas de json ici"), /LLM_OUTPUT_NOT_JSON/);
});
