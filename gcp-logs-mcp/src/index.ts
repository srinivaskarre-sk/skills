import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT, SEVERITIES, readLogs } from "./gcloud.js";

// A fresh key on every start, rotated every KEY_TTL_MINUTES; never read from disk or env.
// The previous key stops working the moment a new one is issued.
const PORT = Number(process.env.PORT ?? 8765);
const KEY_TTL_MINUTES = Number(process.env.KEY_TTL_MINUTES ?? 10);
let apiKey = randomBytes(32).toString("hex");

function rotateKey() {
  apiKey = randomBytes(32).toString("hex");
  printKey();
}

function printKey() {
  const expires = new Date(Date.now() + KEY_TTL_MINUTES * 60_000).toISOString();
  console.log(`[${new Date().toISOString()}] API key (valid until ${expires}): ${apiKey}`);
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "gcp-logs-mcp", version: "0.1.0" });
  server.registerTool(
    "read_gcp_logs",
    {
      title: "Read GCP logs",
      description:
        "Read-only query of Google Cloud Logging via `gcloud logging read`. Returns newest entries first. " +
        "Defaults to the last 1h if no time bound is given.",
      inputSchema: {
        project: z.string().describe("GCP project id, e.g. my-project-prod"),
        minSeverity: z.enum(SEVERITIES).optional().describe("Minimum severity"),
        resourceType: z.string().optional().describe("e.g. k8s_container"),
        namespace: z.string().optional().describe("Kubernetes namespace"),
        container: z.string().optional().describe("Container name"),
        pod: z.string().optional().describe("Pod name"),
        textSearch: z.string().optional().describe("Free-text match across the entry"),
        startTime: z.string().optional().describe("ISO-8601 start, e.g. 2026-10-15T10:00:00Z"),
        endTime: z.string().optional().describe("ISO-8601 end"),
        freshness: z.string().optional().describe("Relative window, e.g. 30m, 2h, 1d"),
        filter: z.string().optional().describe("Extra raw Cloud Logging filter, ANDed with the rest"),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max entries (default ${DEFAULT_LIMIT})`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const res = await readLogs(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: res.entries.length, truncated: res.truncated, command: res.command, entries: res.entries }),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
      }
    },
  );
  return server;
}

function authorized(req: IncomingMessage): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  const presented = m?.[1] ?? (req.headers["x-api-key"] as string | undefined) ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : undefined;
}

function reject(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
}

const http = createServer(async (req, res) => {
  if (!req.url?.startsWith("/mcp")) return reject(res, 404, "not found");
  if (!authorized(req)) return reject(res, 401, "unauthorized");
  if (req.method !== "POST") return reject(res, 405, "method not allowed");
  try {
    const body = await readBody(req);
    // Stateless: a new server+transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) reject(res, 400, (e as Error).message);
  }
});

// Localhost only: ngrok is the single way in.
http.listen(PORT, "127.0.0.1", () => {
  console.log(`gcp-logs-mcp listening on http://127.0.0.1:${PORT}/mcp (read-only)`);
  printKey();
  console.log(`Key rotates every ${KEY_TTL_MINUTES} min; the old key is revoked immediately.`);
  console.log(`\nngrok http ${PORT}\n`);
  console.log(`claude mcp add --transport http gcp-logs https://<ngrok-host>/mcp --header "Authorization: Bearer <key>"`);
});
setInterval(rotateKey, KEY_TTL_MINUTES * 60_000);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
