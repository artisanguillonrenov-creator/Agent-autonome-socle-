import type { SkillDefinition } from "../types.js";
import { config } from "../config.js";
import { SkillRegistry } from "./registry.js";

const boosts:Array<[RegExp,string[]]> = [
  [/\b(recherch|actualit|nouvelle|prix|web|news)\w*/i,["web_search","deep_research"]],
  [/\b(dépôt|depot|repository|github|code|fichier|fonction|timeline|audit|inspect|paramètre|settings|améliore|corrige)\w*/i,["knowledge_search"]],
  [/\b(code|application|github|modifi|développ|améliore|corrige)\w*/i,["software_development"]],
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
    const boosted:string[]=[]; for(const [pattern,ids] of boosts)if(pattern.test(userInput))boosted.push(...ids);
    const ordered=[...boosted.map(id=>this.registry.get(id)),...semantic].filter((s):s is SkillDefinition=>!!s&&candidates.includes(s));
    const unique=new Map<string,SkillDefinition>(); for(const skill of ordered)if(!unique.has(skill.name))unique.set(skill.name,skill);
    return [...unique.values()].slice(0,this.max);
  }
}
