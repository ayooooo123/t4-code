// Renderer-owned interaction state for the Usage screen. The snapshots inside
// it are decoded host projections; profile connectivity and support are always
// re-derived from DesktopRuntimeController rather than persisted here.
import { redactedMessage } from "@t4-code/client";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import {
  readUsage,
  resolveUsageTargets,
  usageTargetsEqual,
  type UsageAvailability,
  type UsageRuntimePort,
  type UsageTarget,
} from "./controller.ts";
import type { UsageSnapshot } from "./model.ts";

export interface UsageTargetState {
  readonly snapshot: UsageSnapshot | null;
  readonly receivedAt: number | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface UsageState {
  readonly availability: UsageAvailability;
  readonly targets: readonly UsageTarget[];
  readonly selectedTargetId: string | null;
  readonly byTarget: Readonly<Record<string, UsageTargetState>>;
  readonly announcement: string;
}

export interface UsageActions {
  syncTargets(): void;
  selectTarget(targetId: string): void;
  refresh(targetId?: string): Promise<void>;
}

export type UsageStoreApi = StoreApi<UsageState & UsageActions>;

const EMPTY_TARGET_STATE: UsageTargetState = Object.freeze({
  snapshot: null,
  receivedAt: null,
  loading: false,
  error: null,
});

function targetState(
  byTarget: Readonly<Record<string, UsageTargetState>>,
  targetId: string,
): UsageTargetState {
  return byTarget[targetId] ?? EMPTY_TARGET_STATE;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.length === 0) return "Account usage could not be refreshed.";
  const safe = redactedMessage(message, 320).trim();
  return safe.length === 0 ? "Account usage could not be refreshed." : safe;
}

export function selectedUsageState(state: UsageState): UsageTargetState {
  return state.selectedTargetId === null
    ? EMPTY_TARGET_STATE
    : targetState(state.byTarget, state.selectedTargetId);
}

export function createUsageStore(
  runtime: UsageRuntimePort,
  options: { readonly now?: () => number; readonly timeoutMs?: number } = {},
): UsageStoreApi {
  const now = options.now ?? Date.now;
  const initial = resolveUsageTargets(runtime.getSnapshot());
  const inFlight = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();

  return createStore<UsageState & UsageActions>()((set, get) => ({
    availability: initial.availability,
    targets: initial.targets,
    selectedTargetId: initial.targets[0]?.targetId ?? null,
    byTarget: {},
    announcement: "",

    syncTargets: () => {
      const resolution = resolveUsageTargets(runtime.getSnapshot());
      const current = get();
      const selectedStillExists = resolution.targets.some(
        (target) => target.targetId === current.selectedTargetId,
      );
      const selectedTargetId = selectedStillExists
        ? current.selectedTargetId
        : (resolution.targets[0]?.targetId ?? null);
      const nextByTarget: Record<string, UsageTargetState> = {};
      for (const target of resolution.targets) {
        const previousTarget = current.targets.find(
          (candidate) => candidate.targetId === target.targetId,
        );
        const existing = current.byTarget[target.targetId];
        // A target id can survive a reconnect while its bound host changes.
        // Never carry account data (or an in-flight loading state) across that
        // identity boundary.
        if (existing !== undefined && previousTarget?.hostId === target.hostId) {
          nextByTarget[target.targetId] = existing;
        } else if (previousTarget !== undefined && previousTarget.hostId !== target.hostId) {
          generations.set(target.targetId, (generations.get(target.targetId) ?? 0) + 1);
        }
      }
      const targetsChanged = !usageTargetsEqual(current.targets, resolution.targets);
      const selectedChanged = current.selectedTargetId !== selectedTargetId;
      if (
        targetsChanged ||
        selectedChanged ||
        current.availability !== resolution.availability ||
        Object.keys(nextByTarget).length !== Object.keys(current.byTarget).length
      ) {
        set({
          availability: resolution.availability,
          targets: resolution.targets,
          selectedTargetId,
          byTarget: nextByTarget,
        });
      }
      if (
        selectedTargetId !== null &&
        (selectedChanged || targetState(nextByTarget, selectedTargetId).snapshot === null) &&
        !targetState(nextByTarget, selectedTargetId).loading
      ) {
        void get().refresh(selectedTargetId);
      }
    },

    selectTarget: (targetId) => {
      const current = get();
      if (!current.targets.some((target) => target.targetId === targetId)) return;
      if (current.selectedTargetId !== targetId) set({ selectedTargetId: targetId, announcement: "" });
      const entry = targetState(get().byTarget, targetId);
      if (entry.snapshot === null && !entry.loading) void get().refresh(targetId);
    },

    refresh: async (requestedTargetId) => {
      const current = get();
      const targetId = requestedTargetId ?? current.selectedTargetId;
      if (targetId === null) return;
      const pending = inFlight.get(targetId);
      if (pending !== undefined) return pending;
      const target = current.targets.find((candidate) => candidate.targetId === targetId);
      if (target === undefined) return;

      const generation = (generations.get(targetId) ?? 0) + 1;
      generations.set(targetId, generation);
      const previous = targetState(current.byTarget, targetId);
      set({
        byTarget: {
          ...current.byTarget,
          [targetId]: { ...previous, loading: true, error: null },
        },
        announcement: previous.snapshot === null ? "Loading account usage" : "Refreshing account usage",
      });

      const run = (async () => {
        try {
          const snapshot = await readUsage(
            runtime,
            target,
            options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
          );
          if (generations.get(targetId) !== generation) return;
          const live = get();
          if (
            !live.targets.some(
              (candidate) =>
                candidate.targetId === targetId && candidate.hostId === target.hostId,
            )
          )
            return;
          set({
            byTarget: {
              ...live.byTarget,
              [targetId]: {
                snapshot,
                receivedAt: now(),
                loading: false,
                error: null,
              },
            },
            announcement: `Usage updated for ${target.label}`,
          });
        } catch (error) {
          if (generations.get(targetId) !== generation) return;
          const live = get();
          if (
            !live.targets.some(
              (candidate) =>
                candidate.targetId === targetId && candidate.hostId === target.hostId,
            )
          )
            return;
          const latest = targetState(live.byTarget, targetId);
          set({
            byTarget: {
              ...live.byTarget,
              [targetId]: { ...latest, loading: false, error: safeError(error) },
            },
            announcement: "Usage refresh failed",
          });
        } finally {
          inFlight.delete(targetId);
        }
      })();
      inFlight.set(targetId, run);
      return run;
    },
  }));
}

export function useUsage<T>(api: UsageStoreApi, selector: (state: UsageState & UsageActions) => T): T {
  return useStore(api, selector);
}
