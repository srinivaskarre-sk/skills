import { execFile } from "node:child_process";

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 50;
const MAX_OUTPUT_BYTES = 200_000;
const TIMEOUT_MS = 30_000;

const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SEVERITIES = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"] as const;
export type Severity = (typeof SEVERITIES)[number];
export { SEVERITIES };

export interface LogQuery {
  project: string;
  minSeverity?: Severity;
  resourceType?: string;
  namespace?: string;
  container?: string;
  pod?: string;
  textSearch?: string;
  startTime?: string;
  endTime?: string;
  filter?: string;
  freshness?: string;
  limit?: number;
}

// Escape a value for use inside a double-quoted Cloud Logging filter string.
const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function assertIso(label: string, v: string) {
  if (Number.isNaN(Date.parse(v))) throw new Error(`${label} must be an ISO-8601 timestamp, got: ${v}`);
}

export function validateProject(project: string, allowed = parseAllowlist()) {
  if (!PROJECT_RE.test(project)) throw new Error(`Invalid GCP project id: ${project}`);
  if (allowed && !allowed.includes(project)) {
    throw new Error(`Project ${project} is not in ALLOWED_PROJECTS`);
  }
}

function parseAllowlist(): string[] | undefined {
  const raw = process.env.ALLOWED_PROJECTS?.trim();
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

/** Build the Cloud Logging filter expression from structured params. */
export function buildFilter(p: LogQuery): string {
  const parts: string[] = [];
  if (p.minSeverity) parts.push(`severity>=${p.minSeverity}`);
  if (p.resourceType) parts.push(`resource.type=${q(p.resourceType)}`);
  if (p.namespace) parts.push(`resource.labels.namespace_name=${q(p.namespace)}`);
  if (p.container) parts.push(`resource.labels.container_name=${q(p.container)}`);
  if (p.pod) parts.push(`resource.labels.pod_name=${q(p.pod)}`);
  if (p.startTime) {
    assertIso("startTime", p.startTime);
    parts.push(`timestamp>=${q(p.startTime)}`);
  }
  if (p.endTime) {
    assertIso("endTime", p.endTime);
    parts.push(`timestamp<=${q(p.endTime)}`);
  }
  if (p.textSearch) parts.push(q(p.textSearch));
  if (p.filter) parts.push(`(${p.filter})`);
  return parts.join(" AND ");
}

/** Build the gcloud argv. Only `logging read` is ever invoked: read-only by construction. */
export function buildArgs(p: LogQuery): string[] {
  validateProject(p.project);
  const limit = Math.min(Math.max(Math.trunc(p.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  if (p.freshness && !/^P(T?\d+[SMHD])+$|^\d+[smhd]$/i.test(p.freshness)) {
    throw new Error(`freshness must look like 1h, 30m, 2d or an ISO-8601 duration, got: ${p.freshness}`);
  }
  // Default to the last hour when no time bound is given so we never scan everything.
  const freshness = p.freshness ?? (p.startTime ? undefined : "1h");
  const args = ["logging", "read"];
  const filter = buildFilter(p);
  // Positional filter goes last, after `--`, so it can never be parsed as a flag.
  args.push(`--project=${p.project}`, "--format=json", `--limit=${limit}`, "--order=desc");
  if (freshness) args.push(`--freshness=${freshness}`);
  args.push("--quiet", "--", filter);
  return args;
}

export interface LogResult {
  entries: unknown[];
  truncated: boolean;
  command: string;
}

export function readLogs(p: LogQuery): Promise<LogResult> {
  const args = buildArgs(p);
  const command = `gcloud ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
  return new Promise((resolve, reject) => {
    execFile(
      "gcloud",
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`gcloud failed: ${stderr?.trim() || err.message}`));
        let entries: unknown[];
        try {
          entries = JSON.parse(stdout || "[]");
        } catch {
          return reject(new Error("gcloud returned non-JSON output"));
        }
        // Trim the result to a byte budget so one call can't flood the client context.
        let truncated = false;
        let size = 0;
        const kept: unknown[] = [];
        for (const e of entries) {
          size += JSON.stringify(e).length;
          if (size > MAX_OUTPUT_BYTES) {
            truncated = true;
            break;
          }
          kept.push(e);
        }
        resolve({ entries: kept, truncated, command });
      },
    );
  });
}
