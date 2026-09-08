import type { ServiceOrchestrator } from "../orchestration/serviceOrchestrator.js";
import { NotificationStore } from "./notificationStore.js";

export class BackgroundRunner {
  private timer?: NodeJS.Timeout; private running=false; private stopped=true;
  constructor(private orchestrator: ServiceOrchestrator, private notifications=new NotificationStore(), private intervalMs=500) {}
  recover(): number { const interrupted=this.orchestrator.store.recoverInterrupted(); for(const op of interrupted)this.notifications.create({type:"RECOVERY_REQUIRED",severity:"error",title:"Exécution interrompue",message:"L’état de l’effet externe est inconnu; aucun rejeu automatique.",operationTaskId:op.taskId},`recovery:${op.taskId}`); return interrupted.length; }
  async tick(): Promise<boolean> { if(this.running)return false; this.running=true; try { const claim=this.orchestrator.store.claimNextBackground(); if(!claim)return false; const op=await this.orchestrator.executeClaimed(claim.request); if(op.status==="COMPLETED")this.notifications.create({type:"BACKGROUND_COMPLETED",severity:"info",title:"Opération terminée",message:op.objective,operationTaskId:op.taskId,taskId:op.scheduleTaskId},`completed:${op.taskId}`); else if(op.status==="FAILED"||op.status==="REJECTED")this.notifications.create({type:"BACKGROUND_FAILED",severity:"error",title:"Opération échouée",message:op.error??op.objective,operationTaskId:op.taskId,taskId:op.scheduleTaskId},`failed:${op.taskId}`); return true; } finally {this.running=false;} }
  start(): void { if(!this.stopped)return; this.stopped=false; this.recover(); const loop=async()=>{if(this.stopped)return; await this.tick(); if(!this.stopped)this.timer=setTimeout(loop,this.intervalMs);}; this.timer=setTimeout(loop,0); }
  stop(): void {this.stopped=true;if(this.timer)clearTimeout(this.timer);}
}
