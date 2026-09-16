import { config } from "../../config.js";
import type { SkillDefinition } from "../../types.js";
const STEP_PROPERTIES={local_id:{type:"string"},title:{type:"string"},capability:{type:"string"},objective:{type:"string"},context:{type:"object"},constraints:{type:"array",items:{type:"string"}},priority:{type:"string",enum:["low","medium","high","urgent"]},depends_on:{type:"array",items:{type:"string"}}} as const;
const STEP_REQUIRED=["local_id","title","capability","objective","context","constraints","priority","depends_on"];
export const executeMissionSkill:SkillDefinition={
 name:"execute_mission",
 description:"Crée et lance de façon asynchrone un plan d'exécution multi-étapes validé. Une étape trop large peut être décomposée en sous-étapes via sub_steps (jusqu'à 3 niveaux) : une étape porteuse de sub_steps n'est jamais exécutée elle-même, elle sert uniquement de regroupement lisible — toute autre étape qui en dépendait dépendra automatiquement de l'achèvement de toute sa sous-arborescence.",
 argsHint:'{"objective":string,"steps":PlanStepSpec[]} — chaque step peut porter "sub_steps": PlanStepSpec[] (décomposition hiérarchique optionnelle)',
 parameters:{type:"object",properties:{objective:{type:"string"},steps:{type:"array",minItems:1,maxItems:50,items:{type:"object",properties:{...STEP_PROPERTIES,sub_steps:{type:"array",items:{type:"object",properties:{...STEP_PROPERTIES,sub_steps:{type:"array",items:{type:"object",additionalProperties:true}}},required:STEP_REQUIRED,additionalProperties:false}}},required:STEP_REQUIRED,additionalProperties:false}}},required:["objective","steps"],additionalProperties:false},
 handler:async(input,ctx)=>{if(!ctx.planner||!ctx.serviceOrchestrator)return"Erreur: moteur de planification non configuré.";try{const run=ctx.planner.createExecutionPlan(String(input.objective??""),input.steps,ctx.serviceOrchestrator.registry,2,config.planning.maxParallel);return JSON.stringify({planRunId:run.id,workspaceId:run.workspaceId,status:run.status,objective:run.objective});}catch(e){return `Erreur: ${(e as Error).message}`;}}
};
