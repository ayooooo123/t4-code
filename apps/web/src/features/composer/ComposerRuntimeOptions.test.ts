import { describe, expect, it } from "vite-plus/test";

import type { ComposerControlsSnapshot } from "../session-runtime/session-controls.ts";
import { modelControlTriggerDisabled } from "./ComposerRuntimeOptions.tsx";

function controls(overrides: Partial<ComposerControlsSnapshot> = {}): ComposerControlsSnapshot {
  return {
    modelSupported: true,
    modelUnsupportedReason: null,
    modelLabel: "openai-codex/gpt-5.5",
    modelSelectedId: "model:openai-codex/gpt-5.5",
    modelChoices: [
      {
        id: "model:openai-codex/gpt-5.5",
        kind: "model",
        label: "GPT-5.5",
        detail: "openai-codex/gpt-5.5",
        selector: "openai-codex/gpt-5.5",
        role: null,
      },
    ],
    thinkingSupported: false,
    thinkingUnsupportedReason: null,
    thinking: null,
    thinkingEffective: null,
    thinkingResolved: null,
    thinkingLevels: [],
    thinkingOffFloored: false,
    fastSupported: false,
    fastUnsupportedReason: null,
    fastAvailable: false,
    fast: false,
    fastActive: false,
    modeSupported: false,
    mode: null,
    attachmentsSupported: false,
    attachmentsUnsupportedReason: null,
    pendingControl: null,
    controlError: null,
    ...overrides,
  };
}

describe("model runtime option trigger", () => {
  it("stays enabled when an idle session has choices but no reported current model", () => {
    expect(modelControlTriggerDisabled(controls({ modelLabel: null, modelSelectedId: null }), false)).toBe(false);
  });

  it("stays disabled when the composer is disabled or no choices exist", () => {
    expect(modelControlTriggerDisabled(controls(), true)).toBe(true);
    expect(modelControlTriggerDisabled(controls({ modelChoices: [] }), false)).toBe(true);
  });
});
