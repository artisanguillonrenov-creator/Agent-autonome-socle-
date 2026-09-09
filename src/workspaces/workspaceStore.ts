import { randomUUID } from "node:crypto";
import { mkdirSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getDb } from "../persistence/db.js";
import { config } from "../config.js";

export type WorkspaceOwnerType = "PLAN_RUN" | "ADHOC";
export interface Workspace { id:string; name:string; ownerType:WorkspaceOwnerType; ownerId:string; status:string; createdAt:number; updatedAt:number }
export interface WorkspaceFile { path:string; size:number; updatedAt:number }
const row=(r:any):Workspace=>({id:r.id,name:r.name,ownerType:r.owner_type,ownerId:r.owner_id,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at});

export class WorkspaceStore {
  readonly root:string;
  private customMaxFileBytes?: number;
  private customMaxTotalBytes?: number;

  constructor(root=config.workspace.root, maxFileBytes?: number, maxTotalBytes?: number){
    this.root=resolve(root);
    mkdirSync(this.root,{recursive:true});
    this.customMaxFileBytes = maxFileBytes;
    this.customMaxTotalBytes = maxTotalBytes;
  }

  get maxFileBytes(): number {
    return this.customMaxFileBytes ?? config.workspace.maxFileBytes;
  }

  get maxTotalBytes(): number {
    return this.customMaxTotalBytes ?? config.workspace.maxTotalBytes;
  }
  create(input:{name:string;ownerType:WorkspaceOwnerType;ownerId:string}):Workspace {if(!input.name.trim()||!input.ownerId.trim()||!["PLAN_RUN","ADHOC"].includes(input.ownerType))throw new Error("INVALID_WORKSPACE");const existing=this.getByOwner(input.ownerType,input.ownerId);if(existing)return existing;const now=Date.now(),id=randomUUID();getDb().prepare("INSERT INTO workspaces(id,name,owner_type,owner_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id,input.name.trim(),input.ownerType,input.ownerId,"ACTIVE",now,now);mkdirSync(resolve(this.root,id),{recursive:false});return this.get(id)!;}
  get(id:string):Workspace|null {const r=getDb().prepare("SELECT * FROM workspaces WHERE id=?").get(id);return r?row(r):null;}
  getByOwner(type:WorkspaceOwnerType,id:string):Workspace|null {const r=getDb().prepare("SELECT * FROM workspaces WHERE owner_type=? AND owner_id=?").get(type,id);return r?row(r):null;}
  list():Workspace[]{return (getDb().prepare("SELECT * FROM workspaces ORDER BY created_at DESC").all() as any[]).map(row);}
  private base(id:string):string {if(!this.get(id))throw new Error("WORKSPACE_NOT_FOUND");const base=resolve(this.root,id);mkdirSync(base,{recursive:true});return base;}
  private target(id:string,path:string,allowMissing=true):string {if(typeof path!=="string"||!path||path.includes("\0")||isAbsolute(path))throw new Error("INVALID_WORKSPACE_PATH");const base=this.base(id),target=resolve(base,path);const rel=relative(base,target);if(!rel||rel===".."||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error("INVALID_WORKSPACE_PATH");let cursor=base;for(const part of rel.split(sep)){cursor=resolve(cursor,part);try{if(lstatSync(cursor).isSymbolicLink())throw new Error("SYMLINK_FORBIDDEN");}catch(e:any){if(e?.code==="ENOENT"&&allowMissing)break;throw e;}}return target;}
  listFiles(id:string):WorkspaceFile[]{const base=this.base(id),out:WorkspaceFile[]=[],queue=[base];while(queue.length){const dir=queue.shift()!;for(const entry of readdirSync(dir,{withFileTypes:true})){const full=resolve(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){queue.push(full);continue;}if(entry.isFile()){const s=statSync(full);out.push({path:relative(base,full).split(sep).join("/"),size:s.size,updatedAt:s.mtimeMs});}if(out.length>10000)throw new Error("WORKSPACE_LIST_LIMIT");}}return out.sort((a,b)=>a.path.localeCompare(b.path));}
  readFile(id:string,path:string):Buffer {const target=this.target(id,path,false),s=statSync(target);if(!s.isFile()||s.size>this.maxFileBytes)throw new Error("INVALID_WORKSPACE_FILE");return readFileSync(target);}
  exists(id:string,path:string):boolean {try{const t=this.target(id,path,false);return statSync(t).isFile();}catch{return false;}}
  writeFile(id:string,path:string,content:Buffer|string):WorkspaceFile {const data=Buffer.isBuffer(content)?content:Buffer.from(content,"utf8");if(data.length>this.maxFileBytes)throw new Error("WORKSPACE_FILE_TOO_LARGE");const target=this.target(id,path);const old=this.exists(id,path)?statSync(target).size:0;const total=this.listFiles(id).reduce((n,f)=>n+f.size,0);if(total-old+data.length>this.maxTotalBytes)throw new Error("WORKSPACE_TOTAL_LIMIT");mkdirSync(dirname(target),{recursive:true});this.target(id,path);const temp=`${target}.tmp-${randomUUID()}`;try{writeFileSync(temp,data,{flag:"wx",mode:0o600});renameSync(temp,target);}catch(e){rmSync(temp,{force:true});throw e;}const s=statSync(target);return{path:relative(this.base(id),target).split(sep).join("/"),size:s.size,updatedAt:s.mtimeMs};}
  deleteFile(id:string,path:string):boolean {const target=this.target(id,path,false);if(!statSync(target).isFile())throw new Error("INVALID_WORKSPACE_FILE");rmSync(target);return true;}
}
