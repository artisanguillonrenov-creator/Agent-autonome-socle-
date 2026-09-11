import type { JarvisPersonalityState } from "./types.js";

export interface IPersonalityRepository {
  initialize(): Promise<void>;
  getState(conversationId: string): Promise<JarvisPersonalityState | null>;
  saveState(state: JarvisPersonalityState): Promise<void>;
}
