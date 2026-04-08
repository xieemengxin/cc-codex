import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let mockedModelType: "codex-oauth" | undefined;
let mockedCodexConfiguredModel: string | undefined;
let mockedCodexDefaultModel = "gpt-5.4";

mock.module("../../../bootstrap/state.js", () => ({
  getMainLoopModelOverride: () => undefined,
}));

mock.module("../antModels.js", () => ({
  resolveAntModel: (model: string) => model,
  getAntModelOverrideConfig: () => null,
}));

mock.module("../../auth.js", () => ({
  getSubscriptionType: () => "",
  isClaudeAISubscriber: () => false,
  isMaxSubscriber: () => false,
  isProSubscriber: () => false,
  isTeamPremiumSubscriber: () => false,
}));

mock.module("../../context.js", () => ({
  has1mContext: (model: string) => /\[1m\]$/i.test(model),
  is1mContextDisabled: () => false,
  modelSupports1M: () => false,
}));

mock.module("../modelStrings.js", () => ({
  getModelStrings: () => ({
    opus40: "claude-opus-4-20250514",
    opus41: "claude-opus-4-1-20250805",
    opus45: "claude-opus-4-5-20251101",
    opus46: "claude-opus-4-6",
    sonnet35: "claude-3-5-sonnet-20241022",
    sonnet37: "claude-3-7-sonnet-20250219",
    sonnet40: "claude-sonnet-4-20250514",
    sonnet45: "claude-sonnet-4-5-20250929",
    sonnet46: "claude-sonnet-4-6",
    haiku35: "claude-3-5-haiku-20241022",
    haiku45: "claude-haiku-4-5-20251001",
  }),
  resolveOverriddenModel: (model: string) => model,
}));

mock.module("../../modelCost.js", () => ({
  formatModelPricing: () => "",
  getOpus46CostTier: () => "",
}));

const settingsMock = () => ({
  getInitialSettings: () =>
    mockedModelType ? { modelType: mockedModelType } : {},
  getSettings_DEPRECATED: () => ({}),
  getSettingsForSource: () => ({}),
});

mock.module("../../settings/settings.js", settingsMock);
mock.module("../../settings/settings.ts", settingsMock);

mock.module("../codexCatalog.js", () => ({
  getCodexDefaultModel: () => mockedCodexDefaultModel,
  getCodexModelDisplayName: (model: string) => model,
}));

mock.module("../../codex/config.js", () => ({
  getCodexProviderConfigValue: (key: string) =>
    key === "model" ? mockedCodexConfiguredModel : undefined,
}));

mock.module("../modelAllowlist.js", () => ({
  isModelAllowed: () => true,
}));

const { parseUserSpecifiedModel } = await import("../model");

describe("parseUserSpecifiedModel with codex provider", () => {
  beforeEach(() => {
    mockedModelType = "codex-oauth";
    mockedCodexConfiguredModel = undefined;
    mockedCodexDefaultModel = "gpt-5.4";
  });

  afterEach(() => {
    mockedModelType = undefined;
    mockedCodexConfiguredModel = undefined;
    mockedCodexDefaultModel = "gpt-5.4";
  });

  test("maps sonnet alias to configured Codex model", () => {
    mockedCodexConfiguredModel = "gpt-5.3-codex";
    expect(parseUserSpecifiedModel("sonnet")).toBe("gpt-5.3-codex");
  });

  test("maps opus alias to Codex default model when no configured model exists", () => {
    expect(parseUserSpecifiedModel("opus")).toBe("gpt-5.4");
  });

  test("maps haiku alias with [1m] suffix to Codex default model", () => {
    expect(parseUserSpecifiedModel("haiku[1m]")).toBe("gpt-5.4");
  });

  test("maps best alias to Codex default model", () => {
    expect(parseUserSpecifiedModel("best")).toBe("gpt-5.4");
  });

  test("passes through explicit Codex model ids unchanged", () => {
    expect(parseUserSpecifiedModel("gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });
});
