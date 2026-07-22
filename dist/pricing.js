import {} from "./aggregate.js";
// Hand-maintained (epic constraint: zero network). Cache write = 1.25x input,
// cache read = 0.1x input (Anthropic's standard 5-minute-TTL cache pricing).
// Verified against the published model pricing on the asOf date; update both by
// hand. Keys are dateless aliases — normalizeModelId() strips the -YYYYMMDD
// snapshot suffix that pre-4.6 transcripts carry, so one entry prices both forms.
export const DEFAULT_PRICING = {
    asOf: "2026-07-22",
    rates: {
        "claude-opus-4-8": opus(),
        "claude-opus-4-7": opus(),
        "claude-opus-4-6": opus(),
        "claude-opus-4-5": opus(),
        // Opus 4.1 and 4.0 predate the 4.6 price drop and still bill at $15/$75.
        "claude-opus-4-1": opusLegacy(),
        "claude-opus-4-0": opusLegacy(),
        // Sonnet 5 shares the $3/$15 Sonnet tier. Its $2/$10 launch promo (through
        // 2026-08-31) is a time-boxed discount this dateless sticker table doesn't
        // model — priced at the standard rate, as every other entry is.
        "claude-sonnet-5": sonnet(),
        "claude-sonnet-4-6": sonnet(),
        "claude-sonnet-4-5": sonnet(),
        "claude-sonnet-4-0": sonnet(),
        "claude-haiku-4-5": haiku(),
        "claude-fable-5": fable(),
        "claude-mythos-5": fable(),
    },
};
function opus() {
    return {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheCreationPerMTok: 6.25,
    };
}
function opusLegacy() {
    return {
        inputPerMTok: 15,
        outputPerMTok: 75,
        cacheReadPerMTok: 1.5,
        cacheCreationPerMTok: 18.75,
    };
}
function sonnet() {
    return {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheCreationPerMTok: 3.75,
    };
}
function haiku() {
    return {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.1,
        cacheCreationPerMTok: 1.25,
    };
}
function fable() {
    return {
        inputPerMTok: 10,
        outputPerMTok: 50,
        cacheReadPerMTok: 1,
        cacheCreationPerMTok: 12.5,
    };
}
// Pre-4.6 model ids carry a -YYYYMMDD snapshot suffix in transcripts (the 4.6
// generation switched to dateless ids). Strip it so a single dateless rate entry
// prices both the alias and the dated snapshot.
function normalizeModelId(model) {
    return model.replace(/-\d{8}$/, "");
}
function costForModel(usage, rates) {
    const perMillion = usage.inputTokens * rates.inputPerMTok +
        usage.outputTokens * rates.outputPerMTok +
        usage.cacheReadTokens * rates.cacheReadPerMTok +
        usage.cacheCreationTokens * rates.cacheCreationPerMTok;
    return perMillion / 1_000_000;
}
// Unknown model ids cost 0 and are flagged (known: false) rather than guessed,
// and are excluded from the total — so an unpriced model never silently
// understates or fabricates the figure compared to the ccusage oracle.
export function cost(usage, table) {
    const perModel = [];
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
