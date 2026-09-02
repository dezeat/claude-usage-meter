import { type ModelUsage, type UsageByModel } from "./aggregate.js";
import { GENERATED_PRICING } from "./generated/pricing-register.js";

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

export const DEFAULT_PRICING: PricingTable = GENERATED_PRICING;

// Pre-4.6 model ids carry a -YYYYMMDD snapshot suffix in transcripts (the 4.6
// generation switched to dateless ids). Strip it so a single dateless rate entry
// prices both the alias and the dated snapshot.
export function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

export function registeredModelClass(model: string): string | undefined {
  const id = normalizeModelId(model);
  return GENERATED_PRICING.classes[
    id as keyof typeof GENERATED_PRICING.classes
  ];
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
    const rates = table.rates[normalizeModelId(model)];
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
