import type { EmbeddingProvider } from "../llm/embeddings.js";
import { cosineSimilarity } from "../llm/embeddings.js";
import type { SkillContext, SkillDefinition } from "../types.js";
import { SkillPreferenceStore } from "./preferences.js";
import type { ServiceRegistry } from "../orchestration/serviceRegistry.js";

const kinds=new Set(["SKILL","WORKFLOW","INTERNAL","FUTURE","SYSTEM","LEGACY"]), availability=new Set(["AVAILABLE","UNAVAILABLE","DISABLED"]), exposures=new Set(["ALWAYS","DYNAMIC","NEVER"]), risks=new Set(["LOW","MEDIUM","HIGH","CRITICAL"]), targets=new Set(["LOCAL_HANDLER","SERVICE_CAPABILITY","WORKFLOW","INTERNAL"]);
function normalized(skill:SkillDefinition):SkillDefinition {
  const legacy=!skill.id;
  const value:SkillDefinition={id:skill.id??skill.name,displayName:skill.displayName??skill.name,category:skill.category??"Contrôle",kind:skill.kind??"LEGACY",availability:skill.availability??(skill.name==="execute_code"?"DISABLED":"AVAILABLE"),exposure:skill.exposure??(skill.name==="execute_code"||["create_task","list_tasks","complete_task"].includes(skill.name)?"NEVER":"DYNAMIC"),risk:skill.risk??"LOW",executionTarget:skill.executionTarget??"LOCAL_HANDLER",aliases:skill.aliases??[],tags:skill.tags??[],requiresWorkspace:skill.requiresWorkspace??false,requiresConnector:skill.requiresConnector??false,defaultEnabled:skill.defaultEnabled??skill.name!=="execute_code",...skill};
  if(!value.id?.trim()||!value.name.trim()||!value.displayName?.trim()||!value.description.trim()||!kinds.has(value.kind!)||!availability.has(value.availability!)||!exposures.has(value.exposure!)||!risks.has(value.risk!)||!targets.has(value.executionTarget!)||!Array.isArray(value.aliases)||!value.aliases.every(x=>typeof x==="string"&&!!x.trim()))throw new Error(`INVALID_SKILL_DEFINITION: ${skill.name||"unknown"}`);
  if(!legacy&&value.kind==="FUTURE"&&value.availability!=="UNAVAILABLE")throw new Error(`INVALID_FUTURE_SKILL: ${value.id}`);
  return value;
}
function validateInput(schema:SkillDefinition["parameters"],input:Record<string,unknown>):void{if(!schema)return;for(const key of schema.required??[])if(input[key]===undefined||input[key]===null||input[key]==="")throw new Error(`INVALID_SKILL_INPUT: missing ${key}`);if(schema.additionalProperties===false)for(const key of Object.keys(input))if(!(key in schema.properties))throw new Error(`INVALID_SKILL_INPUT: unknown ${key}`);for(const [key,value] of Object.entries(input)){const rule=schema.properties[key] as {type?:string;enum?:unknown[]}|undefined;if(value===undefined||!rule)continue;const valid=rule.type==="array"?Array.isArray(value):rule.type==="integer"?Number.isInteger(value):rule.type==="object"?!!value&&typeof value==="object"&&!Array.isArray(value):!rule.type||typeof value===rule.type;if(!valid||rule.enum&&!rule.enum.includes(value))throw new Error(`INVALID_SKILL_INPUT: ${key}`);}}

/**
 * Brique 5 : bibliothèque de compétences. Les skills sont indexées par leur
 * description (embeddée) et rappelées par pertinence plutôt qu'injectées en
 * dur en intégralité à chaque appel — ça permet d'ajouter des dizaines de
 * compétences sans faire exploser le budget de contexte (brique 7).
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly descriptionEmbeddings = new Map<string, number[]>();
  private readonly preferences=new SkillPreferenceStore();

  constructor(private readonly embeddings: EmbeddingProvider) {}

  register(skill: SkillDefinition): void {
    const value=normalized(skill); const id=value.id!;
    for(const existing of this.skills.values()){
      if(existing.id===id||existing.name===value.name){
        // Historical tests and extensions replace legacy handlers by name; canonical metadata remains strict.
        if(!skill.id){this.skills.set(value.name,value);return;}
        throw new Error(`DUPLICATE_SKILL: ${id}`);
      }
      const existingNames=new Set([existing.name,...(existing.aliases??[])]);for(const alias of [value.name,...(value.aliases??[])])if(existingNames.has(alias))throw new Error(`SKILL_ALIAS_COLLISION: ${alias}`);
    }
    this.skills.set(value.name, value);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  isEnabled(skill:SkillDefinition):boolean{return this.preferences.isEnabled(skill.id!,skill.defaultEnabled!==false);}
  setEnabled(id:string,enabled:boolean):void{const s=this.list().find(x=>x.id===id);if(!s)throw new Error("SKILL_NOT_FOUND");if(s.kind==="FUTURE"||s.kind==="INTERNAL"||s.kind==="SYSTEM")throw new Error("SKILL_NOT_MANAGEABLE");this.preferences.setEnabled(id,enabled);}
  selectable():SkillDefinition[]{return this.list().filter(s=>s.availability==="AVAILABLE"&&s.exposure==="DYNAMIC"&&s.kind!=="INTERNAL"&&s.kind!=="FUTURE"&&this.isEnabled(s)&&!!s.handler);}
  alwaysExposed():SkillDefinition[]{return this.list().filter(s=>s.availability==="AVAILABLE"&&s.exposure==="ALWAYS"&&this.isEnabled(s)&&!!s.handler);}
  /** Recompute service exposure without discarding handlers, metadata or preferences. */
  refreshServiceAvailability(services:ServiceRegistry):void{for(const skill of this.skills.values()){if(!skill.serviceCapability)continue;const available=Boolean(services.findServiceForCapability(skill.serviceCapability));skill.availability=available?"AVAILABLE":"UNAVAILABLE";skill.unavailableReason=available?undefined:`Service unavailable: ${skill.serviceCapability}`;}}

  async findRelevant(query: string, topK = 3, source=this.selectable()): Promise<SkillDefinition[]> {
    if (source.length === 0) return [];
    const queryEmbedding = await this.embeddings.embed(query);

    const scored = await Promise.all(
      source.map(async (skill) => {
        let embedding = this.descriptionEmbeddings.get(skill.name);
        if (!embedding) {
          embedding = await this.embeddings.embed(`${skill.name}: ${skill.description}`);
          this.descriptionEmbeddings.set(skill.name, embedding);
        }
        return { skill, score: cosineSimilarity(queryEmbedding, embedding) };
      }),
    );

    return scored
      .sort((a, b) => b.score - a.score)
      .sort((a,b)=>b.score-a.score||a.skill.name.localeCompare(b.skill.name))
      .slice(0, topK)
      .map((s) => s.skill);
  }

  async execute(name: string, input: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Erreur: compétence "${name}" introuvable.`;
    }
    try {
      if(skill.kind==="INTERNAL"||skill.kind==="FUTURE"||skill.availability!=="AVAILABLE"||!this.isEnabled(skill)||!skill.handler)throw new Error("SKILL_NOT_EXECUTABLE");
      validateInput(skill.parameters,input);
      return await skill.handler(input, ctx);
    } catch (err) {
      return `Erreur lors de l'exécution de "${name}": ${(err as Error).message}`;
    }
  }
}
