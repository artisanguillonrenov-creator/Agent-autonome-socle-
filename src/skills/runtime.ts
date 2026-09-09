import { randomUUID } from "node:crypto";
import type { SkillDefinition, SkillContext } from "../types.js";
import type { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import type { Planner } from "../planning/planner.js";
import type { PlanRunner } from "../planning/planRunner.js";
import { TaskStore } from "../tasks/taskStore.js";
import { WorkflowRegistry } from "../workflows/workflowRegistry.js";
import { canonicalSkillCatalog } from "./catalog.js";
import { config } from "../config.js";
import type { GitHubRepositoryReader, RepositoryTarget } from "../services/githubRepositoryReader.js";
import { KnowledgeSearchService } from "../services/knowledgeSearchService.js";

const schema=(properties:Record<string,unknown>,required:string[]=[]):SkillDefinition["parameters"]=>({type:"object",properties,required,additionalProperties:false});
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const strings=(v:unknown):string[]=>Array.isArray(v)&&v.every(x=>typeof x==="string")?v:[];
const nonEmpty=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0;
const validTime=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number.isFinite(value)&&(value as number)>=0;
function validateRepeat(value:unknown):void {if(value!==undefined&&(!Number.isSafeInteger(value)||(value as number)<=0))throw new Error("INVALID_SCHEDULE");}
export function createRuntimeSkills(orchestrator:ServiceOrchestrator,planner:Planner,planRunner:PlanRunner,workflows:WorkflowRegistry,repositoryReader?:GitHubRepositoryReader|null):SkillDefinition[]{
  const tasks=new TaskStore();const base=new Map(canonicalSkillCatalog.map(s=>[s.id!,{...s}]));
  const define=(id:string,parameters:SkillDefinition["parameters"],handler:NonNullable<SkillDefinition["handler"]>)=>Object.assign(base.get(id)!,{parameters,handler});
  const dispatch=(capability:string,input:Record<string,unknown>,context:Record<string,unknown>,workspaceId?:string)=>orchestrator.dispatchCapability({action:"DISPATCH_CAPABILITY",capability,objective:String(input.objective??"").trim(),context,constraints:strings(input.constraints)},{executionMode:input.executionMode==="background"?"background":"foreground",workspaceId});

  const stringArray={type:"array",items:{type:"string"}};
  const knowledge=repositoryReader?new KnowledgeSearchService(repositoryReader):null;
  define("software_development",schema({objective:{type:"string"},filePath:{type:"string"},repository:{type:"object",properties:{url:{type:"string"},owner:{type:"string"},repo:{type:"string"},ref:{type:"string"}},additionalProperties:false},instructions:{type:"string"},exactContent:{type:"string"},targetBranch:{type:"string"},targetPr:{type:"integer"},constraints:stringArray,executionMode:{type:"string",enum:["foreground","background"]}},["objective"]),async i=>{
    let filePath=typeof i.filePath==="string"?i.filePath.trim():"";const repository=object(i.repository);let resolvedTargets:Array<{path:string;reason:string;confidence:string}>=[];
    if(!filePath){if(!knowledge)throw new Error("REPOSITORY_SEARCH_NO_RESULT: repository reader unavailable");const target=repositoryTarget(repository);const found=await knowledge.search({query:String(i.objective),repository:target,maxResults:5});resolvedTargets=found.recommendedFiles;if(!resolvedTargets.length)throw new Error("REPOSITORY_SEARCH_NO_RESULT");filePath=resolvedTargets[0].path;}
    const directives=[typeof i.targetBranch==="string"?`TARGET_BRANCH=${i.targetBranch}`:null,Number.isInteger(i.targetPr)?`TARGET_PR=${i.targetPr}`:null,typeof i.instructions==="string"?i.instructions:null].filter(Boolean).join("\n");
    const result=await dispatch("software_development",i,{filePath,instructions:directives,exactContent:i.exactContent,repoUrl:repositoryUrl(repository),resolvedTargets,neverAutoMerge:true});return JSON.stringify({...result,filePath,resolvedTargets});
  });
  define("deep_research",schema({objective:{type:"string"},queries:stringArray,maxResultsPerQuery:{type:"integer"},constraints:stringArray,workspaceId:{type:"string"}},["objective"]),async i=>{
    const workspaceId=typeof i.workspaceId==="string"?i.workspaceId:orchestrator.workspaces.create({name:"Recherche",ownerType:"ADHOC",ownerId:`research-${randomUUID()}`}).id;
    const result=await dispatch("deep_research",i,{queries:i.queries,maxResultsPerQuery:i.maxResultsPerQuery},workspaceId);
    return JSON.stringify({...result,workspaceId,artifacts:orchestrator.artifacts.listByOperation(result.taskId)});
  });
  define("file_management",schema({action:{type:"string",enum:["LIST","READ","WRITE","DELETE"]},workspaceId:{type:"string"},path:{type:"string"},content:{type:"string"},encoding:{type:"string"}},["action","workspaceId"]),async i=>{
    const result=await dispatch("file_management",{...i,objective:`${i.action} workspace file`},{action:i.action,path:i.path,...(i.encoding==="base64"?{contentBase64:i.content}:{text:i.content})},String(i.workspaceId));
    return JSON.stringify({...result,workspaceId:i.workspaceId,artifacts:orchestrator.artifacts.listByOperation(result.taskId)});
  });
  define("inspect_task",schema({id:{type:"string"},type:{type:"string",enum:["operation","plan","schedule"]}},["id"]),async i=>{const id=String(i.id),type=i.type;const found=[!type||type==="operation"?orchestrator.store.getOperation(id):null,!type||type==="plan"?planner.getRun(id):null,!type||type==="schedule"?tasks.get(id):null].filter(Boolean);if(found.length>1)return"AMBIGUOUS_TASK_ID";if(!found.length)return"TASK_NOT_FOUND";return JSON.stringify(found[0]);});
  define("cancel_task",schema({id:{type:"string"},type:{type:"string",enum:["operation","plan","schedule"]}},["id"]),async i=>{const id=String(i.id);if(i.type==="plan"||(!i.type&&planner.getRun(id))){const r=planRunner.cancel(id);return r?JSON.stringify({id,status:r.status,result:r.status==="CANCELLED"?"cancelled":"cancellation_requested"}):"TASK_NOT_FOUND";}if(i.type==="schedule"||(!i.type&&tasks.get(id)))return JSON.stringify({id,result:tasks.setEnabled(id,false)?"cancelled":"TASK_NOT_FOUND"});const r=orchestrator.store.cancel(id);return r?JSON.stringify({id,result:r.cancelled?"cancelled":r.requested?"cancellation_requested":"not_cancelled",status:r.operation.status}):"TASK_NOT_FOUND";});
  const schedule=async(i:Record<string,unknown>,watch=false)=>{if(!nonEmpty(i.title)||!validTime(i.nextRunAt)||!nonEmpty(i.capability)||!nonEmpty(i.objective))throw new Error("INVALID_SCHEDULE");validateRepeat(i.repeatIntervalMs);if(!orchestrator.registry.findServiceForCapability(i.capability))return"UNKNOWN_CAPABILITY";return JSON.stringify(tasks.createSchedule({title:i.title.trim(),taskType:watch?"WATCH":"DISPATCH",nextRunAt:i.nextRunAt,repeatIntervalMs:i.repeatIntervalMs as number|undefined,payload:{action:"DISPATCH_CAPABILITY",capability:i.capability,objective:i.objective.trim(),context:object(i.context),constraints:strings(i.constraints)}}));};
  define("schedule_task",schema({action:{type:"string",enum:["CREATE_REMINDER","CREATE_DISPATCH","LIST","ENABLE","DISABLE","COMPLETE"]},id:{type:"string"},title:{type:"string"},nextRunAt:{type:"integer"},capability:{type:"string"},objective:{type:"string"},context:{type:"object"},constraints:stringArray,repeatIntervalMs:{type:"integer"}},["action"]),async i=>{switch(i.action){case"LIST":return JSON.stringify(tasks.listSchedules());case"ENABLE":case"DISABLE":case"COMPLETE":if(!nonEmpty(i.id))throw new Error("INVALID_SCHEDULE");return JSON.stringify({ok:i.action==="COMPLETE"?tasks.complete(i.id):tasks.setEnabled(i.id,i.action==="ENABLE")});case"CREATE_REMINDER":if(!nonEmpty(i.title)||!validTime(i.nextRunAt))throw new Error("INVALID_SCHEDULE");validateRepeat(i.repeatIntervalMs);return JSON.stringify(tasks.createSchedule({title:i.title.trim(),taskType:"REMINDER",nextRunAt:i.nextRunAt,repeatIntervalMs:i.repeatIntervalMs as number|undefined}));case"CREATE_DISPATCH":return schedule(i);default:throw new Error("INVALID_SCHEDULE_ACTION");}});
  define("monitor_condition",schema({title:{type:"string"},objective:{type:"string"},nextRunAt:{type:"integer"},repeatIntervalMs:{type:"integer"},capability:{type:"string"},context:{type:"object"},constraints:stringArray},["title","objective","nextRunAt","capability"]),async i=>schedule(i,true));
  define("execute_workflow",schema({workflowId:{type:"string"},workflowName:{type:"string"},inputs:{type:"object"}},["inputs"]),async(i,ctx)=>{
    const key=String(i.workflowId??i.workflowName??""),workflow=workflows.get(key);if(!workflow||workflow.status!=="ACTIVE")throw new Error("WORKFLOW_NOT_ACTIVE");
    if(workflow.name==="monitor_web"){
      const input=object(i.inputs),compiled=workflows.compile(workflow,input);
      if(!nonEmpty(input.title)||!nonEmpty(input.objective)||!validTime(input.firstRunAt))throw new Error("WORKFLOW_INPUT_INVALID");
      validateRepeat(input.repeatIntervalMs);
      const title=input.title.trim(),firstRunAt=input.firstRunAt,repeatIntervalMs=input.repeatIntervalMs as number;
      const created=workflows.executeSchedule(key,input,orchestrator.registry,ctx.toolCallId??"",id=>tasks.get(id),()=>tasks.createSchedule({title,taskType:"WATCH",nextRunAt:firstRunAt,repeatIntervalMs,payload:{action:"DISPATCH_CAPABILITY",capability:"deep_research",objective:compiled.objective,context:{queries:input.queries},constraints:[]}}));
      return JSON.stringify({workflowId:workflow.id,workflowVersion:workflow.version,scheduleId:created.id,nextRunAt:created.nextRunAt,enabled:created.enabled});
    }
    const run=workflows.execute(key,object(i.inputs),planner,orchestrator.registry,ctx.toolCallId??"");return JSON.stringify({workflowId:workflow.id,workflowVersion:workflow.version,planRunId:run.id,workspaceId:run.workspaceId,status:run.status});
  });
  define("manage_skill",schema({action:{type:"string"},skillId:{type:"string"},workflowId:{type:"string"},planRunId:{type:"string"}},["action"]),async(i,ctx:SkillContext)=>{const registry=ctx.skillRegistry;switch(i.action){case"LIST":return JSON.stringify(registry.list().map((s:SkillDefinition)=>({id:s.id,enabled:registry.isEnabled(s)})));case"ENABLE":case"DISABLE":registry.setEnabled(String(i.skillId),i.action==="ENABLE");return JSON.stringify({ok:true});case"LIST_WORKFLOWS":return JSON.stringify(workflows.list());case"LEARN_WORKFLOW_FROM_PLAN":return JSON.stringify(workflows.learnFromPlan(String(i.planRunId),planner));case"APPROVE_WORKFLOW":return JSON.stringify({ok:workflows.setStatus(String(i.workflowId),"ACTIVE",orchestrator.registry)});case"DISABLE_WORKFLOW":return JSON.stringify({ok:workflows.setStatus(String(i.workflowId),"DISABLED",orchestrator.registry)});case"ARCHIVE_WORKFLOW":return JSON.stringify({ok:workflows.setStatus(String(i.workflowId),"ARCHIVED",orchestrator.registry)});default:return"INVALID_MANAGE_ACTION";}});
  if(knowledge){const skill=define("knowledge_search",schema({query:{type:"string"},source:{type:"string",enum:["REPOSITORY","WORKSPACE","AUTO"]},operation:{type:"string",enum:["SEARCH","AUDIT"]},repository:{type:"object",properties:{url:{type:"string"},owner:{type:"string"},repo:{type:"string"},ref:{type:"string"}},additionalProperties:false},pathHints:stringArray,fileTypes:stringArray,maxResults:{type:"integer"}},["query","repository"]),async i=>{const repository=object(i.repository),target=repositoryTarget(repository);if(i.source&&i.source!=="REPOSITORY"&&i.source!=="AUTO")throw new Error("KNOWLEDGE_SOURCE_UNAVAILABLE");return JSON.stringify(i.operation==="AUDIT"||/\baudit/i.test(String(i.query))?await knowledge.audit(target):await knowledge.search({query:String(i.query),repository:target,pathHints:strings(i.pathHints),fileTypes:strings(i.fileTypes),maxResults:Number.isInteger(i.maxResults)?Number(i.maxResults):undefined}));});skill.availability="AVAILABLE";skill.unavailableReason=undefined;}
  else {const skill=base.get("knowledge_search")!;skill.availability="UNAVAILABLE";skill.unavailableReason="Repository reader is not configured";delete skill.handler;}
  if(config.webSearch.provider==="none"){const web=base.get("web_search")!;web.availability="UNAVAILABLE";web.unavailableReason="Web provider is not configured";delete web.handler;}
  for(const s of base.values())if(s.serviceCapability&&!orchestrator.registry.findServiceForCapability(s.serviceCapability)){s.availability="UNAVAILABLE";s.unavailableReason=`Service unavailable: ${s.serviceCapability}`;delete s.handler;}
  return [...base.values()];
}

function repositoryTarget(value:Record<string,unknown>):RepositoryTarget{if(typeof value.url==="string")return value.ref?{...parseTarget(value.url),ref:String(value.ref)}:parseTarget(value.url);if(typeof value.owner==="string"&&typeof value.repo==="string")return{owner:value.owner,repo:value.repo,ref:typeof value.ref==="string"?value.ref:undefined};throw new Error("REPOSITORY_INVALID");}
function parseTarget(value:string):RepositoryTarget{const clean=value.trim().replace(/\.git$/i,"");const match=clean.match(/github\.com\/([^/]+)\/([^/]+)/i)??clean.match(/^([^/]+)\/([^/]+)$/);if(!match)throw new Error("REPOSITORY_INVALID");return{owner:match[1],repo:match[2]};}
function repositoryUrl(value:Record<string,unknown>):string|undefined{return typeof value.url==="string"?value.url:typeof value.owner==="string"&&typeof value.repo==="string"?`${value.owner}/${value.repo}`:undefined;}
