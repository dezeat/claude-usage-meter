export interface RateWindow {
  usedPercentage: number;
  resetsAt: number;
}

export interface ParsedPayload {
  modelId?: string;
  modelName?: string;
  contextPercentage?: number;
  costUsd?: number;
  fiveHour?: RateWindow;
  sevenDay?: RateWindow;
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
  return {
    modelId: model ? asString(model.id) : undefined,
    modelName: model ? asString(model.display_name) : undefined,
    contextPercentage: context ? asNumber(context.used_percentage) : undefined,
    costUsd: cost ? asNumber(cost.total_cost_usd) : undefined,
    fiveHour: limits ? parseWindow(limits.five_hour) : undefined,
    sevenDay: limits ? parseWindow(limits.seven_day) : undefined,
  };
}
