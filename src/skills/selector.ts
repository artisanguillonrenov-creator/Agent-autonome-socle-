import type { SkillDefinition } from "../types.js";
import { config } from "../config.js";
import { SkillRegistry } from "./registry.js";

function normalizeIntentText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Détecte une intention de modification du logiciel Jarvis sans confondre les
 * demandes éditoriales ordinaires ("améliore mon texte", "ajoute un rappel")
 * avec une mission de développement.
 */
export function detectSoftwareModificationIntent(userInput: string): boolean {
  const text = normalizeIntentText(userInput);
  const hasAction = /(corrig|repar|amelior|modifi|develop|ajout|\bfix\b|\bpatch\b)/.test(text);
  if (!hasAction) return false;

  const hasSoftwareContext =
    /(jarvis|logiciel|\bcode\b|depot|repository|\brepo\b|github|\bbug\b|application|backend|frontend|\bapi\b|service|software factory|typescript|javascript|\bnode\b|src\/|fichier source|persistance|persistence)/.test(text) ||
    /\b(ta|ton|tes|votre|son)\s+memoire\b/.test(text) ||
    /\bmemoire\s+(de|du)\s+jarvis\b/.test(text) ||
    /\bsysteme\s+de\s+memoire\b/.test(text);

  return hasSoftwareContext;
}

const boosts:Array<[RegExp,string[]]> = [
  [/\b(recherch|actualit|nouvelle|prix|web|news|internet)\w*/i,["web_search","deep_research"]],
  [/\b(code|application|github|modifi|développ)\w*/i,["software_development"]],
  [/\b(dépôts?|repository|repo\b|pull[ -]?request|\bpr\b|commits?|diffs?|arboresc\w*)/i,["knowledge_search"]],
  [/\b(fichier|workspace|dossier)\w*/i,["file_management"]],
  [/\b(rappel|programm|planifi)\w*/i,["schedule_task"]],
  [/\b(surveill|prévenir quand|alerte)\w*/i,["monitor_condition","monitor_web"]],
  [/\b(workflow|procédure|routine)\w*/i,["execute_workflow"]],
  [/\b(heure|date|temps actuel)\w*/i,["get_current_time"]],
  [/\b(mémor|souviens|remember)\w*/i,["remember_fact"]],
];
export class SkillSelector {
  readonly max:number;
  constructor(private readonly registry:SkillRegistry,max=config.skills.selectorMax){this.max=Math.min(Math.max(max,3),12);}
  async select(userInput:string):Promise<SkillDefinition[]> {
    const candidates=this.registry.selectable();
    const semantic=await this.registry.findRelevant(userInput,Math.max(this.max*2,12),candidates);
    const modificationIntent=detectSoftwareModificationIntent(userInput);
    const boosted:string[]=[];
    if(modificationIntent)boosted.push("knowledge_search","software_development");
    for(const [pattern,ids] of boosts)if(pattern.test(userInput))boosted.push(...ids);
    const ordered=[...boosted.map(id=>this.registry.get(id)),...semantic].filter((s):s is SkillDefinition=>!!s&&candidates.includes(s));
    const unique=new Map<string,SkillDefinition>(); for(const skill of ordered)if(!unique.has(skill.name))unique.set(skill.name,skill);
    const selected=[...unique.values()].slice(0,this.max);
    console.log(`[JARVIS-FLOW] MODIFICATION_INTENT=${modificationIntent}`);
    console.log(`[JARVIS-FLOW] SKILLS=${selected.map(s=>s.name).join(",")}`);
    return selected;
  }
}
