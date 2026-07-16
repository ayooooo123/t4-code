// Header controls for explicit host selection and the active host's
// account-broker status. Both stay inside the existing quiet vocabulary:
// the selector is the same field every other control uses, the status is
// one plain sentence with the app's standard tones — no cards, no new
// colors. The shell owns what a selection means.
import { Badge, Button, cn } from "@t4-code/ui";
import { RotateCcw } from "lucide-react";

import { brokerStatusCopy, type BrokerStatusView } from "./broker-status.ts";
import { FIELD_CLASS } from "./controls.tsx";
import type { HostChoice } from "./live-screen-model.ts";

export interface HostSelection {
  readonly choices: readonly HostChoice[];
  /** The target the screen is currently about, if any. */
  readonly activeTargetId: string | null;
  readonly onSelect: (targetId: string) => void;
}

/**
 * One accessible select over the connected hosts. With one or zero real
 * choices it falls back to the quiet label badge (or nothing when the
 * caller passes no fallback) — a menu of one is noise, not a choice.
 */
export function HostSelector({
  selection,
  fallbackLabel,
}: {
  readonly selection?: HostSelection | undefined;
  readonly fallbackLabel: string | null;
}) {
  if (selection === undefined || selection.choices.length <= 1) {
    return fallbackLabel === null ? null : <Badge variant="outline">{fallbackLabel}</Badge>;
  }
  const known = selection.choices.some((choice) => choice.targetId === selection.activeTargetId);
  return (
    <select
      aria-label="Settings host"
      className={cn(FIELD_CLASS, "h-7")}
      onChange={(event) => selection.onSelect(event.target.value)}
      value={known && selection.activeTargetId !== null ? selection.activeTargetId : ""}
    >
      {(!known || selection.activeTargetId === null) && (
        <option disabled value="">
          Choose a host
        </option>
      )}
      {selection.choices.map((choice) => (
        <option key={choice.targetId} value={choice.targetId}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

export interface BrokerStatusAction {
  readonly view: BrokerStatusView;
  /** Deliberate re-query; omitted when the surface offers no refresh. */
  readonly onRefresh?: () => void;
}

/** One truthful sentence about where the active host's accounts come from. */
export function BrokerStatusLine({ view, onRefresh }: BrokerStatusAction) {
  const copy = brokerStatusCopy(view);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-border border-b px-4 py-1.5">
      <p
        aria-live="polite"
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          copy.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
        )}
        role="status"
      >
        {copy.text}
      </p>
      {onRefresh !== undefined && view.kind !== "unsupported" && (
        <Button disabled={view.kind === "loading"} onClick={onRefresh} size="xs" variant="ghost">
          <RotateCcw />
          Refresh
        </Button>
      )}
    </div>
  );
}
