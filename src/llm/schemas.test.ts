import test from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments, planStepsArraySchema } from "./schemas.js";
import type { SkillParameterSchema } from "../types.js";

// Vague 6B : guardrails structurés Zod — rejet immédiat des arguments d'outil hors-schéma.
test("validateToolArguments accepte des arguments conformes", () => {
  const schema: SkillParameterSchema = {
    type: "object",
    properties: { path: { type: "string" }, maxResults: { type: "integer" } },
    required: ["path"],
    additionalProperties: false,
  };
  const result = validateToolArguments(schema, { path: "a.txt", maxResults: 5 });
  assert.equal(result.success, true);
  assert.deepEqual(result.data, { path: "a.txt", maxResults: 5 });
});

test("validateToolArguments rejette un type incorrect", () => {
  const schema: SkillParameterSchema = { type: "object", properties: { maxResults: { type: "integer" } }, additionalProperties: true };
  const result = validateToolArguments(schema, { maxResults: "not-a-number" });
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("INVALID_TOOL_ARGUMENTS") || result.error);
});

test("validateToolArguments rejette une propriété inconnue quand additionalProperties=false", () => {
  const schema: SkillParameterSchema = { type: "object", properties: { path: { type: "string" } }, additionalProperties: false };
  const result = validateToolArguments(schema, { path: "a.txt", extra: "nope" });
  assert.equal(result.success, false);
});

test("validateToolArguments accepte tout objet quand aucun schéma n'est déclaré", () => {
  const result = validateToolArguments(undefined, { anything: true });
  assert.equal(result.success, true);
});

test("validateToolArguments applique les valeurs enum strictement", () => {
  const schema: SkillParameterSchema = { type: "object", properties: { action: { type: "string", enum: ["A", "B"] } }, required: ["action"] };
  assert.equal(validateToolArguments(schema, { action: "A" }).success, true);
  assert.equal(validateToolArguments(schema, { action: "C" }).success, false);
});

test("planStepsArraySchema rejette un tableau vide ou trop long", () => {
  assert.equal(planStepsArraySchema(2).safeParse([]).success, false);
  const step = { local_id: "a", title: "a", capability: "cap", objective: "do a", context: {}, constraints: [], priority: "medium", depends_on: [] };
  assert.equal(planStepsArraySchema(2).safeParse([step, step, step]).success, false);
  assert.equal(planStepsArraySchema(2).safeParse([step]).success, true);
});
