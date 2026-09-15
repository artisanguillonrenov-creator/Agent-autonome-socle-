import { z } from "zod";
import type { SkillParameterSchema } from "../types.js";

/**
 * Vague 6B (guardrails structurés) : Zod est la source de vérité pour la forme des
 * réponses structurées critiques du LLM (plan d'étapes, arguments d'outils). Un rejet
 * Zod est immédiat — avant toute exécution — et s'intègre à la logique de repli
 * existante (l'appelant traite l'échec de validation comme n'importe quelle erreur
 * d'outil/plan déjà prévue, sans jamais tenter de "réparer" le texte a posteriori).
 */

export const STEP_PRIORITY_VALUES = ["low", "medium", "high", "urgent"] as const;

/** Miroir structurel de PlanStepSpec (src/planning/planner.ts) — la validation sémantique
 * (capacité connue, dépendances résolues, absence de cycle) reste faite par l'appelant. */
export const planStepSpecSchema = z.object({
  local_id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  capability: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  context: z.record(z.string(), z.unknown()),
  constraints: z.array(z.string()),
  priority: z.enum(STEP_PRIORITY_VALUES),
  depends_on: z.array(z.string()),
});

export function planStepsArraySchema(maxSteps: number) {
  return z.array(planStepSpecSchema).min(1).max(maxSteps);
}

export type PlanStepZod = z.infer<typeof planStepSpecSchema>;

/**
 * Convertisseur minimal SkillParameterSchema (JSON-Schema-like, déjà utilisé pour décrire
 * les outils au LLM) -> schéma Zod. Couvre les formes réellement utilisées par les skills
 * du socle (string/number/integer/boolean/array/object, enum, required,
 * additionalProperties) — suffisant pour un rejet structurel immédiat des arguments
 * d'outil, sans réécrire tout JSON-Schema.
 */
function primitiveToZod(rule: { type?: string; enum?: unknown[] } | undefined): z.ZodTypeAny {
  if (!rule || !rule.type) return z.unknown();
  if (rule.enum && rule.enum.length > 0) {
    const allowed = rule.enum;
    return z.custom<unknown>((value) => allowed.includes(value), { message: "value must be one of the allowed enum values" });
  }
  switch (rule.type) {
    case "string": return z.string();
    case "number": return z.number();
    case "integer": return z.number().int();
    case "boolean": return z.boolean();
    case "array": return z.array(z.unknown());
    case "object": return z.record(z.string(), z.unknown());
    default: return z.unknown();
  }
}

export function toolArgumentsSchema(schema: SkillParameterSchema | undefined): z.ZodTypeAny {
  if (!schema || schema.type !== "object" || !schema.properties) return z.record(z.string(), z.unknown());
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, rule] of Object.entries(schema.properties)) {
    const base = primitiveToZod(rule as { type?: string; enum?: unknown[] } | undefined);
    shape[key] = required.has(key) ? base : base.optional();
  }
  const object = z.object(shape);
  return schema.additionalProperties === false ? object.strict() : object.passthrough();
}

export interface ToolArgumentsValidation {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Rejet immédiat, avant tout appel de handler : un échec ne consomme jamais l'outil. */
export function validateToolArguments(schema: SkillParameterSchema | undefined, input: unknown): ToolArgumentsValidation {
  const zodSchema = toolArgumentsSchema(schema);
  const result = zodSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data as Record<string, unknown> };
  const issue = result.error.issues[0];
  const path = issue?.path?.length ? issue.path.join(".") : "(root)";
  return { success: false, error: `INVALID_TOOL_ARGUMENTS: ${path}: ${issue?.message ?? "schema mismatch"}` };
}
