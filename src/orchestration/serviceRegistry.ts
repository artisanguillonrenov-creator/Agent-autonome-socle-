import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ServiceDefinition {
  id: string;
  name: string;
  enabled: boolean;
  endpoint: string;
  capabilities: string[];
  priority: number;
}

export class ServiceRegistry {
  private services: ServiceDefinition[] = [];

  constructor(configPath?: string) {
    const targetPath = configPath || join(process.cwd(), "config", "services.json");
    if (existsSync(targetPath)) {
      try {
        const raw = readFileSync(targetPath, "utf-8");
        this.services = JSON.parse(raw);
      } catch (err) {
        console.warn(`[ServiceRegistry] Failed to parse ${targetPath}:`, err);
      }
    }
  }

  register(service: ServiceDefinition): void {
    this.services = this.services.filter((s) => s.id !== service.id);
    this.services.push(service);
  }

  findServiceForCapability(capability: string): ServiceDefinition | null {
    const matching = this.services.filter((s) => s.enabled && s.capabilities.includes(capability));

    if (matching.length === 0) return null;

    // Static priority selection (higher priority number first)
    matching.sort((a, b) => b.priority - a.priority);
    return matching[0];
  }

  getServiceById(id: string): ServiceDefinition | null {
    return this.services.find((s) => s.id === id) || null;
  }

  listServices(): ServiceDefinition[] {
    return [...this.services];
  }
}
