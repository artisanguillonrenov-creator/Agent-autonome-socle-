import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TaskRequest, ServiceEvent } from "../orchestration/contract.js";

export type MockBehavior = "SUCCESS" | "FAILURE" | "REJECT" | "TIMEOUT" | "WAITING_INPUT" | "WAITING_PERMISSION";

export class MockServiceServer {
  private server: ReturnType<typeof createServer> | null = null;
  private processedKeys = new Map<string, ServiceEvent[]>();
  public currentBehavior: MockBehavior = "SUCCESS";

  constructor(public readonly port: number = 4000) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(async (req, res) => {
        if (req.method === "POST" && req.url === "/tasks") {
          const bodyStr = await this.readBody(req);
          let taskReq: TaskRequest;
          try {
            taskReq = JSON.parse(bodyStr);
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }

          // Check behavior
          if (this.currentBehavior === "TIMEOUT") {
            // Do not respond, simulate network timeout
            return;
          }

          // Check idempotency key: double envoi -> une seule exécution logique
          if (this.processedKeys.has(taskReq.idempotency_key)) {
            const cachedEvents = this.processedKeys.get(taskReq.idempotency_key)!;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ events: cachedEvents }));
            return;
          }

          const events = this.generateEventsForTask(taskReq);
          this.processedKeys.set(taskReq.idempotency_key, events);

          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ events }));
          return;
        }

        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }

        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });

      this.server.listen(this.port, () => {
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private generateEventsForTask(taskReq: TaskRequest): ServiceEvent[] {
    const serviceName = "mock_software_factory";

    if (this.currentBehavior === "REJECT") {
      return [
        {
          schema_version: "1.0",
          event_id: `evt-${taskReq.task_id}-reject`,
          task_id: taskReq.task_id,
          trace_id: taskReq.trace_id,
          service: serviceName,
          sequence: 1,
          type: "TASK_REJECTED",
          timestamp: Date.now(),
          payload: { reason: "Capacité indisponible ou contraintes non respectées" },
        },
      ];
    }

    if (this.currentBehavior === "FAILURE") {
      return [
        {
          schema_version: "1.0",
          event_id: `evt-${taskReq.task_id}-1`,
          task_id: taskReq.task_id,
          trace_id: taskReq.trace_id,
          service: serviceName,
          sequence: 1,
          type: "TASK_ACCEPTED",
          timestamp: Date.now(),
          payload: { message: "Tâche acceptée par Mock Factory" },
        },
        {
          schema_version: "1.0",
          event_id: `evt-${taskReq.task_id}-2`,
          task_id: taskReq.task_id,
          trace_id: taskReq.trace_id,
          service: serviceName,
          sequence: 2,
          type: "TASK_PROGRESS",
          timestamp: Date.now(),
          payload: { progress: 50, message: "Génération en cours..." },
        },
        {
          schema_version: "1.0",
          event_id: `evt-${taskReq.task_id}-3`,
          task_id: taskReq.task_id,
          trace_id: taskReq.trace_id,
          service: serviceName,
          sequence: 3,
          type: "TASK_FAILED",
          timestamp: Date.now(),
          payload: { error: "Échec de compilation dans Mock Factory" },
        },
      ];
    }

    if (this.currentBehavior === "WAITING_INPUT") {
      return [
        {
          schema_version: "1.0",
          event_id: `evt-${taskReq.task_id}-1`,
          task_id: taskReq.task_id,
          trace_id: taskReq.trace_id,
          service: serviceName,
          sequence: 1,
          type: "TASK_ACCEPTED",
          timestamp: Date.now(),
          payload: { message: "Tâche acceptée" },
        },
        {
          schema_version: "1.0",
          event_id: `evt-${taskReq.task_id}-2`,
          task_id: taskReq.task_id,
          trace_id: taskReq.trace_id,
          service: serviceName,
          sequence: 2,
          type: "NEEDS_INPUT",
          timestamp: Date.now(),
          payload: { prompt: "Veuillez préciser le framework frontend souhaité" },
        },
      ];
    }

    // Default SUCCESS
    return [
      {
        schema_version: "1.0",
        event_id: `evt-${taskReq.task_id}-1`,
        task_id: taskReq.task_id,
        trace_id: taskReq.trace_id,
        service: serviceName,
        sequence: 1,
        type: "TASK_ACCEPTED",
        timestamp: Date.now(),
        payload: { message: "Tâche acceptée" },
      },
      {
        schema_version: "1.0",
        event_id: `evt-${taskReq.task_id}-2`,
        task_id: taskReq.task_id,
        trace_id: taskReq.trace_id,
        service: serviceName,
        sequence: 2,
        type: "TASK_PROGRESS",
        timestamp: Date.now(),
        payload: { progress: 80, message: "Création des fichiers de l'application de prise de notes" },
      },
      {
        schema_version: "1.0",
        event_id: `evt-${taskReq.task_id}-3`,
        task_id: taskReq.task_id,
        trace_id: taskReq.trace_id,
        service: serviceName,
        sequence: 3,
        type: "TASK_COMPLETED",
        timestamp: Date.now(),
        payload: {
          app_name: "NotesApp",
          status: "ready",
          summary: "Application de prise de notes créée avec succès.",
        },
      },
    ];
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf-8");
  }
}

// Standalone runner when executed directly
if (process.argv[1]?.endsWith("mockService.ts") || process.argv[1]?.endsWith("mockService.js")) {
  const mockServer = new MockServiceServer(4000);
  mockServer.start().then(() => {
    console.log("Mock Service standalone HTTP démarré sur http://localhost:4000");
  });
}
