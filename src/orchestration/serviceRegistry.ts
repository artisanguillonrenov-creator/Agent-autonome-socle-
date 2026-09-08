import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RiskLevel } from "./contract.js";

export interface ServiceDefinition {
  id: string;
  name: string;
  enabled: boolean;
  endpoint: string;
  capabilities: string[];
  priority: number;
  riskByCapability?: Record<string, RiskLevel>;
}

const RISK_LEVELS = new Set<RiskLevel>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export function riskForCapability(service: ServiceDefinition, capability: string): RiskLevel | null {
  const configured = service.riskByCapability?.[capability];
  if (configured === undefined) return "LOW";
  return RISK_LEVELS.has(configured) ? configured : null;
}

export function resolveServiceEndpoint(service: ServiceDefinition): ServiceDefinition {
  let endpoint = service.endpoint;

  if (service.id === "software_factory") {
    if (process.env.SOFTWARE_FACTORY_URL) {
      endpoint = process.env.SOFTWARE_FACTORY_URL;
    } else if (process.env.PORT || process.env.API_PORT) {
      const activePort = process.env.PORT || process.env.API_PORT;
      if (endpoint === "http://localhost:4000") {
        endpoint = `http://localhost:${activePort}`;
      }
    }
  }

  if (process.env.PORT) {
    endpoint = endpoint.replace("${PORT}", process.env.PORT);
  }

  return { ...service, endpoint };
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

    matching.sort((a, b) => b.priority - a.priority);
    return resolveServiceEndpoint(matching[0]);
  }

  getServiceById(id: string): ServiceDefinition | null {
    const s = this.services.find((svc) => svc.id === id);
    return s ? resolveServiceEndpoint(s) : null;
  }

  listServices(): ServiceDefinition[] {
    return this.services.map(resolveServiceEndpoint);
  }
}
