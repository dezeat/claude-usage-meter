export interface RateWindow {
  usedPercentage: number;
  resetsAt: number;
}

export interface ParsedPayload {
  modelId?: string;
  modelName?: string;
  contextPercentage?: number;
  costUsd?: number;
  durationMs?: number;
  fiveHour?: RateWindow;
  sevenDay?: RateWindow;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseWindow(value: unknown): RateWindow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const usedPercentage = asNumber(record.used_percentage);
  const resetsAt = asNumber(record.resets_at);
  if (usedPercentage === undefined || resetsAt === undefined) return undefined;
  return { usedPercentage, resetsAt };
}

export function parsePayload(value: unknown): ParsedPayload {
  const root = asRecord(value) ?? {};
  const model = asRecord(root.model);
  const cost = asRecord(root.cost);
  const context = asRecord(root.context_window);
  const limits = asRecord(root.rate_limits);
  const workspace = asRecord(root.workspace);
  return {
    modelId: model ? asString(model.id) : undefined,
    modelName: model ? asString(model.display_name) : undefined,
    contextPercentage: context ? asNumber(context.used_percentage) : undefined,
    // Payload cost source (ADR-0004): authoritative ONLY for the live, not-yet-
    // indexed session — the `ses` fallback in render/fleet-render. Everything
    // persisted is priced from tokens in index-store, not this field.
    costUsd: cost ? asNumber(cost.total_cost_usd) : undefined,
    durationMs: cost ? asNumber(cost.total_duration_ms) : undefined,
    fiveHour: limits ? parseWindow(limits.five_hour) : undefined,
    sevenDay: limits ? parseWindow(limits.seven_day) : undefined,
    sessionId: asString(root.session_id),
    transcriptPath: asString(root.transcript_path),
    // The session's working dir, used to resolve the repo/branch at the edge.
    // Claude Code nests it under workspace.current_dir; the top-level cwd is the
    // older/fallback spelling.
    cwd:
      (workspace ? asString(workspace.current_dir) : undefined) ??
      asString(root.cwd),
  };
}
