// Regression: streamed shell projections rebuild the session object on every
// output/status update while the route stays put. Activation (which closes
// the narrow rail overlay) must fire once per present route session ID, so a
// deliberately reopened rail is not slammed shut by live output. No DOM.
import { describe, expect, it } from "vite-plus/test";

import {
  createSessionRouteActivationGate,
  type SessionRouteActivationGate,
  type SessionRouteDecision,
} from "../src/lib/session-route.ts";
import { createMemoryPersistence } from "../src/state/persistence.ts";
import {
  createWorkspaceStore,
  type WorkspaceStoreApi,
} from "../src/state/workspace-store.ts";

const present: SessionRouteDecision = { kind: "present" };
const pending: SessionRouteDecision = { kind: "pending" };

interface RouteSession {
  readonly id: string;
  readonly status: string | null;
  readonly lastActivity: string;
}

function session(id: string, patch: Partial<Omit<RouteSession, "id">> = {}): RouteSession {
  return { id, status: null, lastActivity: "", ...patch };
}

function makeStore(): WorkspaceStoreApi {
  return createWorkspaceStore({ persistence: createMemoryPersistence() });
}

/** Mirrors the SessionRoute activation effect: gate first, then the store. */
function runActivationEffect(
  store: WorkspaceStoreApi,
  gate: SessionRouteActivationGate,
  decision: SessionRouteDecision,
  routeSession: RouteSession | undefined,
  visitedAt: string,
) {
  const target = gate.resolve(decision, routeSession);
  if (target !== null) {
    store.getState().activateSession(target, visitedAt);
  }
}

describe("session route activation gate", () => {
  it("activates once on the first present route and closes the overlay", () => {
    const store = makeStore();
    const gate = createSessionRouteActivationGate();
    store.getState().setRailOverlayOpen(true);

    runActivationEffect(store, gate, present, session("A"), "2026-07-16T10:00:00Z");

    expect(store.getState().activeSessionId).toBe("A");
    expect(store.getState().railOverlayOpen).toBe(false);
    expect(store.getState().lastVisitedAtBySessionId["A"]).toBe("2026-07-16T10:00:00Z");
  });

  it("leaves a reopened overlay open while the same session streams updates", () => {
    const store = makeStore();
    const gate = createSessionRouteActivationGate();

    runActivationEffect(store, gate, present, session("A"), "2026-07-16T10:00:00Z");
    expect(store.getState().railOverlayOpen).toBe(false);

    // The user reopens the rail to switch sessions while output streams.
    store.getState().setRailOverlayOpen(true);

    // Each streamed projection rebuilds the session object: fresh identity,
    // changed status/output. The route has not changed, so no re-activation.
    runActivationEffect(
      store,
      gate,
      present,
      session("A", { status: "running", lastActivity: "thinking…" }),
      "2026-07-16T10:00:01Z",
    );
    runActivationEffect(
      store,
      gate,
      present,
      session("A", { status: "running", lastActivity: "writing router.tsx" }),
      "2026-07-16T10:00:02Z",
    );

    expect(store.getState().railOverlayOpen).toBe(true);
    expect(store.getState().activeSessionId).toBe("A");
  });

  it("does not re-activate when the decision flaps through pending and back", () => {
    const store = makeStore();
    const gate = createSessionRouteActivationGate();

    runActivationEffect(store, gate, present, session("A"), "2026-07-16T10:00:00Z");
    store.getState().setRailOverlayOpen(true);

    // Reconnect blip: route truth briefly loses the session, then recovers.
    runActivationEffect(store, gate, pending, undefined, "2026-07-16T10:00:01Z");
    runActivationEffect(store, gate, present, session("A"), "2026-07-16T10:00:02Z");

    expect(store.getState().railOverlayOpen).toBe(true);
  });

  it("still activates and closes the overlay when navigating to another session", () => {
    const store = makeStore();
    const gate = createSessionRouteActivationGate();

    runActivationEffect(store, gate, present, session("A"), "2026-07-16T10:00:00Z");
    store.getState().setRailOverlayOpen(true);

    runActivationEffect(store, gate, present, session("B"), "2026-07-16T10:00:03Z");

    expect(store.getState().activeSessionId).toBe("B");
    expect(store.getState().railOverlayOpen).toBe(false);
    expect(store.getState().lastVisitedAtBySessionId["B"]).toBe("2026-07-16T10:00:03Z");

    // Returning to A is a genuine route change again: overlay closes.
    store.getState().setRailOverlayOpen(true);
    runActivationEffect(store, gate, present, session("A"), "2026-07-16T10:00:04Z");
    expect(store.getState().activeSessionId).toBe("A");
    expect(store.getState().railOverlayOpen).toBe(false);
  });
});
