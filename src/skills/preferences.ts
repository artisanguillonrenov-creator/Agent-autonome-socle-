import { getDb } from "../persistence/db.js";
export class SkillPreferenceStore {
  isEnabled(skillId:string, fallback=true):boolean { const row=getDb().prepare("SELECT enabled FROM skill_preferences WHERE skill_id=?").get(skillId) as {enabled:number}|undefined; return row?row.enabled===1:fallback; }
  setEnabled(skillId:string,enabled:boolean):void { getDb().prepare("INSERT INTO skill_preferences(skill_id,enabled,updated_at) VALUES(?,?,?) ON CONFLICT(skill_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at").run(skillId,enabled?1:0,Date.now()); }
}
