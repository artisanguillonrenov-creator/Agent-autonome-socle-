import type { SkillDefinition, SkillKind, SkillAvailability, SkillExposure, SkillCategory, SkillExecutionTarget } from "../types.js";

export const CANONICAL_SKILL_IDS = [
  "dispatch_capability","inspect_task","cancel_task","resume_task","approve_action","checkpoint_task","restore_task","schedule_task","monitor_condition","notify_user","delegate_specialist","execute_parallel","consolidate_results","web_search","deep_research","knowledge_search","compare_sources","monitor_web","browser_action","file_management","document_work","presentation_work","spreadsheet_work","data_analysis","database_query","report_generation","media_generation","email","calendar","contacts","meeting_assistant","messaging","phone_call","daily_briefing","software_development","system_operations","external_service","computer_use","execute_workflow","manage_skill",
] as const;

export type CanonicalSkillId = typeof CANONICAL_SKILL_IDS[number];
const internal = new Set(["dispatch_capability","approve_action","notify_user","delegate_specialist","execute_parallel","consolidate_results","external_service","checkpoint_task","restore_task"]);
const available = new Set(["inspect_task","cancel_task","schedule_task","monitor_condition","web_search","deep_research","knowledge_search","file_management","software_development","execute_workflow","manage_skill","checkpoint_task","restore_task"]);
const workflows = new Set(["compare_sources","monitor_web"]);
const categories: Record<string, SkillCategory> = {
  web_search:"Recherche",deep_research:"Recherche",knowledge_search:"Recherche",compare_sources:"Workflows",monitor_web:"Workflows",
  file_management:"Fichiers",document_work:"Fichiers",presentation_work:"Fichiers",spreadsheet_work:"Fichiers",data_analysis:"Technique",database_query:"Technique",report_generation:"Fichiers",media_generation:"Technique",
  email:"Communication",calendar:"Communication",contacts:"Communication",meeting_assistant:"Communication",messaging:"Communication",phone_call:"Communication",daily_briefing:"Communication",
  software_development:"Technique",system_operations:"Technique",computer_use:"Technique",execute_workflow:"Workflows",manage_skill:"Contrôle",
};
const descriptions: Partial<Record<CanonicalSkillId,string>> = {
  inspect_task:"Inspecte factuellement une opération, un plan ou une programmation.", cancel_task:"Annule une tâche ou demande son annulation sans exagérer le résultat.", schedule_task:"Crée et administre rappels et tâches programmées.", monitor_condition:"Surveille périodiquement une condition avec le moteur WATCH.",
  web_search:"Recherche des informations actuelles sur le Web.", deep_research:"Effectue une recherche approfondie et documentée.", knowledge_search:"Recherche ou audite en lecture seule un dépôt GitHub.", file_management:"Liste, lit, écrit ou supprime un fichier dans un workspace sécurisé.", software_development:"Délègue une modification logicielle à la Software Factory.", execute_workflow:"Exécute un workflow réutilisable actif.", manage_skill:"Administre les préférences de skills et le cycle de vie des workflows.", compare_sources:"Compare plusieurs sources sur un sujet.", monitor_web:"Surveille périodiquement une information Web.",
};

function metadata(id: CanonicalSkillId): SkillDefinition {
  const isInternal=internal.has(id), isWorkflow=workflows.has(id);
  const kind:SkillKind=isInternal?"INTERNAL":isWorkflow?"WORKFLOW":available.has(id)?"SKILL":"FUTURE";
  const availability:SkillAvailability=available.has(id)||isWorkflow?"AVAILABLE":"UNAVAILABLE";
  const exposure:SkillExposure=isInternal||kind==="FUTURE"?"NEVER":"DYNAMIC";
  const serviceCapability=["deep_research","file_management","software_development"].includes(id)?id:undefined;
  const executionTarget:SkillExecutionTarget=isInternal?"INTERNAL":isWorkflow||id==="execute_workflow"?"WORKFLOW":serviceCapability?"SERVICE_CAPABILITY":"LOCAL_HANDLER";
  return {id,name:id,displayName:id.split("_").map(x=>x[0].toUpperCase()+x.slice(1)).join(" "),description:descriptions[id]??`Capacité Jarvis ${id}.`,category:categories[id]??(kind==="FUTURE"?"Futur":isInternal?"Interne":"Contrôle"),kind,availability,exposure,risk:id==="software_development"||id==="file_management"?"MEDIUM":"LOW",executionTarget,serviceCapability,aliases:[],tags:id.split("_"),requiresWorkspace:id==="file_management",requiresConnector:false,unavailableReason:availability==="UNAVAILABLE"?"Capability planned for a future release":undefined,defaultEnabled:true,argsHint:"{}",parameters:{type:"object",properties:{},additionalProperties:false}};
}

/** The code-owned source of truth. Runtime availability may only narrow these declarations. */
export const canonicalSkillCatalog: readonly SkillDefinition[] = Object.freeze(CANONICAL_SKILL_IDS.map(metadata));
if(canonicalSkillCatalog.length!==40) throw new Error("INVALID_CANONICAL_SKILL_COUNT");

export const executeMissionMetadata:SkillDefinition={id:"execute_mission",name:"execute_mission",displayName:"Execute Mission",description:"Planifie une mission réellement multi-étapes.",category:"Contrôle",kind:"SYSTEM",availability:"AVAILABLE",exposure:"ALWAYS",risk:"MEDIUM",executionTarget:"LOCAL_HANDLER",aliases:[],tags:["mission","plan"],requiresWorkspace:false,requiresConnector:false,defaultEnabled:true,argsHint:"{}"};
