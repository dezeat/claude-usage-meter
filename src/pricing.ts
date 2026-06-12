import { type ModelUsage, type UsageByModel } from "./aggregate.js";

export interface ModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheCreationPerMTok: number;
}

export interface PricingTable {
  asOf: string;
  rates: Record<string, ModelRates>;
}

export interface ModelCost {
  model: string;
  costUsd: number;
  known: boolean;
}

export interface CostByModel {
  perModel: ModelCost[];
  totalUsd: number;
  hasUnknownModels: boolean;
}

// Hand-maintained (epic constraint: zero network). Cache write = 1.25x input,
// cache read = 0.1x input (Anthropic's standard 5-minute-TTL cache pricing).
// Update asOf and rates by hand; staleness policy is E01-S03.
export const DEFAULT_PRICING: PricingTable = {
  asOf: "2026-06-12",
  rates: {
    "claude-opus-4-8": opus(),
    "claude-opus-4-7": opus(),
    "claude-opus-4-6": opus(),
    "claude-sonnet-4-6": sonnet(),
    "claude-sonnet-4-5": sonnet(),
    "claude-haiku-4-5": {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheCreationPerMTok: 1.25,
    },
    "claude-fable-5": {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheReadPerMTok: 1,
      cacheCreationPerMTok: 12.5,
    },
  },
};

function opus(): ModelRates {
  return {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheCreationPerMTok: 6.25,
  };
}

function sonnet(): ModelRates {
  return {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheCreationPerMTok: 3.75,
  };
}

function costForModel(usage: ModelUsage, rates: ModelRates): number {
  const perMillion =
    usage.inputTokens * rates.inputPerMTok +
    usage.outputTokens * rates.outputPerMTok +
    usage.cacheReadTokens * rates.cacheReadPerMTok +
    usage.cacheCreationTokens * rates.cacheCreationPerMTok;
  return perMillion / 1_000_000;
}

// Unknown model ids cost 0 and are flagged (known: false) rather than guessed,
// and are excluded from the total — so an unpriced model never silently
// understates or fabricates the figure compared to the ccusage oracle.
export function cost(usage: UsageByModel, table: PricingTable): CostByModel {
  const perModel: ModelCost[] = [];
  let totalUsd = 0;
  let hasUnknownModels = false;

  for (const [model, modelUsage] of Object.entries(usage.models)) {
    const rates = table.rates[model];
    if (rates === undefined) {
      hasUnknownModels = true;
      perModel.push({ model, costUsd: 0, known: false });
      continue;
    }
    const modelCost = costForModel(modelUsage, rates);
    totalUsd += modelCost;
    perModel.push({ model, costUsd: modelCost, known: true });
  }

  return { perModel, totalUsd, hasUnknownModels };
}
