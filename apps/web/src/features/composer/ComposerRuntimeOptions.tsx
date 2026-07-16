import { cn, Tooltip, TooltipPopup, TooltipTrigger } from "@t4-code/ui";
import { Brain, Hammer, Zap } from "lucide-react";

import { isSessionMode, isThinkingLevel, type SessionIntent } from "../session-runtime/intents.ts";
import {
  thinkingLabel,
  thinkingValueLabel,
  type ComposerControlsSnapshot,
} from "../session-runtime/session-controls.ts";
import { ControlMenu } from "./ComposerControls.tsx";

const MODE_LABEL: Record<string, string> = {
  build: "Build",
  plan: "Plan first",
  readOnly: "Read only",
};

const MODE_DETAIL: Record<string, string | null> = {
  build: "Make changes directly",
  plan: "Propose a plan before touching anything",
  readOnly: "Inspect only; no writes, no commands",
};
const SESSION_MODES = ["build", "plan", "readOnly"] as const;

export interface FastModeDisplayState {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
}

export function fastModeTooltip(state: FastModeDisplayState): string {
  if (state.active && !state.enabled) {
    return "Provider priority is active through this model's provider settings; reasoning effort is unchanged";
  }
  if (state.enabled && state.active) {
    return "Provider priority is active for this model; reasoning effort is unchanged";
  }
  if (state.enabled) {
    return "Fast mode is enabled, but this route is not applying provider priority; reasoning effort is unchanged";
  }
  if (state.available) {
    return "Enable provider priority processing for this model; reasoning effort is unchanged";
  }
  return "Provider priority is unavailable for this model; reasoning effort is unchanged";
}

function fastModeAriaLabel(state: FastModeDisplayState): string {
  if (state.active && !state.enabled) {
    return "Provider priority active through provider settings";
  }
  if (state.enabled && state.active) return "Fast mode on; provider priority active";
  if (state.enabled) return "Fast mode on; provider priority inactive on this route";
  return "Fast mode off";
}

function thinkingChoiceDetail(
  level: string,
  controls: ComposerControlsSnapshot,
): string | null {
  if (level === "auto") {
    if (controls.thinking !== "auto") return "Chooses a level for each prompt";
    return controls.thinkingResolved === null
      ? "Chooses per prompt; this turn is not classified yet"
      : `This turn: ${thinkingLabel(controls.thinkingResolved)}`;
  }
  if (level === "off") {
    return controls.thinkingOffFloored
      ? "Uses this provider's minimum reasoning level"
      : "Disables reasoning when the provider supports it";
  }
  if (
    level === controls.thinking &&
    controls.thinkingEffective !== null &&
    controls.thinkingEffective !== level
  ) {
    return `Effective: ${thinkingLabel(controls.thinkingEffective)}`;
  }
  return null;
}

export function RuntimeOptions({
  controls,
  disabled,
  onIntent,
  compact,
}: {
  readonly controls: ComposerControlsSnapshot;
  readonly disabled: boolean;
  readonly onIntent: (intent: SessionIntent) => void;
  readonly compact: boolean;
}) {
  const controlClassName = compact
    ? "h-11 w-full max-w-none justify-start px-2 text-sm"
    : undefined;

  return (
    <>
      <ControlMenu
        busy={controls.pendingControl === "model"}
        choices={controls.modelChoices.map((choice) => ({
          id: choice.id,
          label: choice.label,
          detail: choice.kind === "role" ? `Role · ${choice.detail ?? "Inherited"}` : choice.detail,
          disabledReason: controls.modelSupported ? null : controls.modelUnsupportedReason,
        }))}
        className={controlClassName}
        disabled={disabled || controls.modelLabel === null}
        icon={null}
        label="Model — this session"
        note={controls.modelSupported ? null : controls.modelUnsupportedReason}
        onSelect={(id) => {
          const choice = controls.modelChoices.find((entry) => entry.id === id);
          if (choice === undefined || (choice.selector === null && choice.role === null)) return;
          onIntent({ kind: "setModel", selector: choice.selector, role: choice.role });
        }}
        value={controls.modelSelectedId ?? ""}
        valueLabel={controls.modelLabel ?? "Model —"}
      />
      <ControlMenu
        busy={controls.pendingControl === "thinking"}
        choices={controls.thinkingLevels.map((level) => ({
          id: level,
          label: thinkingLabel(level),
          detail: thinkingChoiceDetail(level, controls),
          disabledReason: controls.thinkingSupported ? null : controls.thinkingUnsupportedReason,
        }))}
        className={controlClassName}
        disabled={disabled}
        icon={<Brain aria-hidden="true" className="size-3.5 shrink-0" />}
        label="Thinking — this session"
        note={controls.thinkingSupported ? null : controls.thinkingUnsupportedReason}
        onSelect={(id) => {
          if (isThinkingLevel(id)) onIntent({ kind: "setThinking", level: id });
        }}
        value={controls.thinking ?? ""}
        valueLabel={thinkingValueLabel(controls)}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-busy={controls.pendingControl === "fast" || undefined}
              aria-disabled={!controls.fastSupported || undefined}
              aria-label={fastModeAriaLabel({
                available: controls.fastAvailable,
                enabled: controls.fast,
                active: controls.fastActive,
              })}
              aria-pressed={controls.fast}
              className={cn(
                "flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64",
                controls.fast &&
                  !controls.fastActive &&
                  "text-warning-foreground hover:text-warning-foreground",
                controls.fastActive && "text-accent-text hover:text-accent-text",
                !controls.fastSupported &&
                  "cursor-default opacity-64 hover:bg-transparent hover:text-muted-foreground",
                controls.pendingControl === "fast" && "animate-pulse motion-reduce:animate-none",
                compact && "h-11 w-full justify-start px-2 text-sm",
              )}
              disabled={disabled || controls.pendingControl === "fast"}
              onClick={() => {
                if (controls.fastSupported) {
                  onIntent({ kind: "setFast", enabled: !controls.fast });
                }
              }}
              type="button"
            >
              <Zap aria-hidden="true" className="size-3.5" />
              Fast
            </button>
          }
        />
        <TooltipPopup side="top">
          {!controls.fastSupported
            ? (controls.fastUnsupportedReason ?? "Not offered by this host")
            : fastModeTooltip({
                available: controls.fastAvailable,
                enabled: controls.fast,
                active: controls.fastActive,
              })}
        </TooltipPopup>
      </Tooltip>
      {controls.modeSupported && controls.mode !== null && (
        <ControlMenu
          choices={SESSION_MODES.map((mode) => ({
            id: mode,
            label: MODE_LABEL[mode] ?? mode,
            detail: MODE_DETAIL[mode] ?? null,
          }))}
          className={controlClassName}
          disabled={disabled}
          icon={<Hammer aria-hidden="true" className="size-3.5 shrink-0" />}
          label="Mode"
          onSelect={(id) => {
            if (isSessionMode(id)) onIntent({ kind: "setMode", mode: id });
          }}
          value={controls.mode}
          valueLabel={MODE_LABEL[controls.mode] ?? controls.mode}
        />
      )}
    </>
  );
}
