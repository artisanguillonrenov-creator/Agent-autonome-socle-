import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../persistence/db.js";
import { WorkspaceStore } from "./workspaceStore.js";

export type ArtifactKind = "FILE" | "TEXT" | "REPORT" | "DATA" | "LINK";
export interface Artifact { id:string; workspaceId:string; planRunId?:string; operationTaskId?:string; dedupeKey?:string; kind:ArtifactKind; name:string; mimeType?:string; relativePath?:string; externalUrl?:string; sizeBytes?:number; sha256?:string; metadata?:Record<string,unknown>; createdAt:number; contentStatus?:"AVAILABLE"|"MISSING_CONTENT"|"CORRUPT" }
export type ArtifactInput = { workspaceId:string; planRunId?:string; operationTaskId?:string; dedupeKey?:string; kind:ArtifactKind; name:string; mimeType?:string; content?:Buffer; url?:string; metadata?:Record<string,unknown>; workingPath?:string };
const kinds = new Set<ArtifactKind>(["FILE","TEXT","REPORT","DATA","LINK"]);
const record = (value:unknown):value is Record<string,unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safeName = (name:string) => name.replace(/[^a-zA-Z0-9._-]/g,"_") || "artifact";

export class ArtifactStore {
  constructor(readonly files=new WorkspaceStore()) {}
  private validate(input:ArtifactInput):void { if(!this.files.get(input.workspaceId)||!kinds.has(input.kind)||typeof input.name!=="string"||!input.name.trim()||!record(input.metadata??{})||(input.mimeType!==undefined&&typeof input.mimeType!=="string"))throw new Error("INVALID_ARTIFACT");if(input.kind==="LINK"){let url:URL;try{url=new URL(input.url??"");}catch{throw new Error("INVALID_ARTIFACT_URL");}if(!["http:","https:"].includes(url.protocol))throw new Error("INVALID_ARTIFACT_URL");}else if(!Buffer.isBuffer(input.content))throw new Error("INVALID_ARTIFACT_CONTENT"); }
  createBatch(inputs:ArtifactInput[]):Artifact[] { if(!Array.isArray(inputs)||inputs.length===0)throw new Error("INVALID_ARTIFACT_BATCH");for(const input of inputs)this.validate(input);const createdPaths:string[]=[];const backups=new Map<string,Buffer>();const db=getDb();try{return db.transaction(()=>inputs.map(input=>{const id=randomUUID(),createdAt=Date.now();let relativePath:string|undefined,sizeBytes:number|undefined,sha256:string|undefined,externalUrl:string|undefined;if(input.kind==="LINK")externalUrl=new URL(input.url!).href;else{if(input.workingPath){const key=`${input.workspaceId}\0${input.workingPath}`;if(this.files.exists(input.workspaceId,input.workingPath))backups.set(key,this.files.readFile(input.workspaceId,input.workingPath));this.files.writeFile(input.workspaceId,input.workingPath,input.content!);createdPaths.push(key);}relativePath=`artifacts/${id}/${safeName(input.name)}`;this.files.writeFile(input.workspaceId,relativePath,input.content!);createdPaths.push(`${input.workspaceId}\0${relativePath}`);sizeBytes=input.content!.length;sha256=createHash("sha256").update(input.content!).digest("hex");}db.prepare("INSERT INTO artifacts(id,workspace_id,plan_run_id,operation_task_id,dedupe_key,kind,name,mime_type,relative_path,external_url,size_bytes,sha256,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,input.workspaceId,input.planRunId??null,input.operationTaskId??null,input.dedupeKey??null,input.kind,input.name.trim(),input.mimeType??null,relativePath??null,externalUrl??null,sizeBytes??null,sha256??null,JSON.stringify(input.metadata??{}),createdAt);return{id,workspaceId:input.workspaceId,planRunId:input.planRunId,operationTaskId:input.operationTaskId,kind:input.kind,name:input.name.trim(),mimeType:input.mimeType,relativePath,externalUrl,sizeBytes,sha256,metadata:input.metadata??{},createdAt};}))();}catch(error){for(const item of createdPaths){const [workspaceId,path]=item.split("\0");try{const backup=backups.get(item);if(backup)this.files.writeFile(workspaceId,path,backup);else this.files.deleteFile(workspaceId,path);}catch{}}throw error;} }
  createFileArtifact(input:{workspaceId:string;planRunId?:string;operationTaskId?:string;dedupeKey?:string;kind?:ArtifactKind;name:string;mimeType?:string;content:Buffer;metadata?:Record<string,unknown>}):Artifact{return this.createBatch([{...input,kind:input.kind??"FILE"}])[0];}
  createTextArtifact(input:{workspaceId:string;planRunId?:string;operationTaskId?:string;dedupeKey?:string;kind?:ArtifactKind;name:string;mimeType?:string;content:string;metadata?:Record<string,unknown>}):Artifact{return this.createFileArtifact({...input,kind:input.kind??"TEXT",mimeType:input.mimeType??"text/plain; charset=utf-8",content:Buffer.from(input.content)});}
  createLinkArtifact(input:{workspaceId:string;planRunId?:string;operationTaskId?:string;name:string;url:string;metadata?:Record<string,unknown>}):Artifact{return this.createBatch([{...input,kind:"LINK"}])[0];}
  private map(row:any):Artifact { const artifact:Artifact={id:row.id,workspaceId:row.workspace_id,planRunId:row.plan_run_id??undefined,operationTaskId:row.operation_task_id??undefined,kind:row.kind,name:row.name,mimeType:row.mime_type??undefined,relativePath:row.relative_path??undefined,externalUrl:row.external_url??undefined,sizeBytes:row.size_bytes??undefined,sha256:row.sha256??undefined,metadata:JSON.parse(row.metadata_json||"{}"),createdAt:row.created_at};if(artifact.relativePath){if(!this.files.exists(artifact.workspaceId,artifact.relativePath))artifact.contentStatus="MISSING_CONTENT";else if(artifact.sha256&&createHash("sha256").update(this.files.readFile(artifact.workspaceId,artifact.relativePath)).digest("hex")!==artifact.sha256)artifact.contentStatus="CORRUPT";else artifact.contentStatus="AVAILABLE";}return artifact; }
  get(id:string):Artifact|null { const row=getDb().prepare("SELECT * FROM artifacts WHERE id=?").get(id);return row?this.map(row):null; }
  /**
   * Co-édition humaine : réécrit le contenu d'un artefact FILE/TEXT existant depuis l'IHM
   * Web (édition directe), en conservant son identité (id, chemin, métadonnées) mais en
   * recalculant taille/empreinte. Un artefact LINK n'a pas de contenu binaire propre et
   * n'est donc pas éditable par ce chemin.
   */
  updateContent(id:string, content:Buffer):Artifact {
    const artifact = this.get(id);
    if (!artifact) throw new Error("ARTIFACT_NOT_FOUND");
    if (artifact.kind === "LINK" || !artifact.relativePath) throw new Error("ARTIFACT_NOT_EDITABLE");
    this.files.writeFile(artifact.workspaceId, artifact.relativePath, content);
    const sizeBytes = content.length;
    const sha256 = createHash("sha256").update(content).digest("hex");
    getDb().prepare("UPDATE artifacts SET size_bytes=?,sha256=? WHERE id=?").run(sizeBytes, sha256, id);
    return this.get(id)!;
  }
  listByWorkspace(id:string):Artifact[] { return(getDb().prepare("SELECT * FROM artifacts WHERE workspace_id=? ORDER BY created_at").all(id) as any[]).map(row=>this.map(row)); }
  listByOperation(id:string):Artifact[] { return(getDb().prepare("SELECT * FROM artifacts WHERE operation_task_id=? ORDER BY created_at").all(id) as any[]).map(row=>this.map(row)); }
}
