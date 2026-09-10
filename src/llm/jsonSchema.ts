/** Refuse malformed array schemas before they reach an LLM provider. */
export function validateArraySchemaItems(schema: unknown, path = "$", seen = new Set<object>()): void {
  if (!schema || typeof schema !== "object") return;
  if (seen.has(schema as object)) return;
  seen.add(schema as object);
  const value = schema as Record<string, unknown>;
  if (value.type === "array" && !("items" in value)) throw new Error(`ARRAY_SCHEMA_ITEMS_REQUIRED: ${path}`);
  if (value.items) validateArraySchemaItems(value.items, `${path}.items`, seen);
  if (value.properties && typeof value.properties === "object") for (const [key, child] of Object.entries(value.properties)) validateArraySchemaItems(child, `${path}.properties.${key}`, seen);
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]){const list=value[key];if(Array.isArray(list))list.forEach((child,index)=>validateArraySchemaItems(child,`${path}.${key}[${index}]`,seen));}
  if (value.additionalProperties && typeof value.additionalProperties === "object") validateArraySchemaItems(value.additionalProperties, `${path}.additionalProperties`, seen);
}

