// Observer UX contract: the strict `liveState.sessionControl` reader, the
// freshness precedence rule, the copy every surface renders, and the write
// gates (slash palette, composer controls). Absence must stay writable so
// hosts without `session.observer` keep working unchanged; any present but
// unproven shape must stay read-only with unknown-safe copy.
import { describe, expect, it } from "vite-plus/test";

import type { CatalogItem, SessionRef } from "@t4-code/protocol";

import { slashCommandsFromCatalog } from "../composer/slash.ts";
import type { ComposerControlsSnapshot } from "./session-controls.ts";
import {
  gateComposerControls,
  initialControlAnnouncerState,
  presentSessionControl,
  presentSessionControlKind,
  readSessionControl,
  reduceControlAnnouncement,
  SESSION_CONTROL_RETURNED_ANNOUNCEMENT,
  sessionControlDisplayKind,
  sessionControlForLink,
  type ControlAnnouncerState,
  type SessionControlState,
} from "./session-observer.ts";

function refWith(liveState: unknown): SessionRef {
  return { liveState } as unknown as SessionRef;
}

const OBSERVER_LIVE: SessionControlState = {
  mode: "observer",
  lockStatus: "live",
  transcript: "live",
};

describe("readSessionControl", () => {
  it("treats only a truly absent field as writable (backward compatibility)", () => {
    expect(readSessionControl(undefined)).toBeNull();
    expect(readSessionControl({} as unknown as SessionRef)).toBeNull();
    expect(readSessionControl(refWith({}))).toBeNull();
    expect(readSessionControl(refWith({ isStreaming: true }))).toBeNull();
  });

  it("parses every exact observer shape", () => {
    for (const lockStatus of ["live", "suspect", "malformed"] as const) {
      for (const transcript of ["live", "snapshot"] as const) {
        expect(
          readSessionControl(refWith({ sessionControl: { mode: "observer", lockStatus, transcript } })),
        ).toEqual({ mode: "observer", lockStatus, transcript });
      }
    }
  });

  it("parses both reconciling shapes", () => {
    for (const transcript of ["live", "snapshot"] as const) {
      expect(
        readSessionControl(refWith({ sessionControl: { mode: "reconciling", transcript } })),
      ).toEqual({ mode: "reconciling", transcript });
    }
  });

  it("reads extra keys on a known mode as unknown (exact shapes only)", () => {
    expect(
      readSessionControl(
        refWith({
          sessionControl: { mode: "observer", lockStatus: "live", transcript: "live", later: 1 },
        }),
      ),
    ).toEqual({ mode: "unknown" });
    expect(
      readSessionControl(
        refWith({ sessionControl: { mode: "reconciling", transcript: "live", extra: true } }),
      ),
    ).toEqual({ mode: "unknown" });
  });

  it("reads any present but unproven shape as unknown, never writable", () => {
    for (const liveState of [undefined, null, "invalid", 42, true, []]) {
      expect(readSessionControl(refWith(liveState))).toEqual({ mode: "unknown" });
    }
    const malformed: unknown[] = [
      null,
      "observer",
      42,
      true,
      [],
      { mode: "owner" },
      { mode: "observer" },
      { mode: "observer", lockStatus: "held", transcript: "live" },
      { mode: "observer", lockStatus: "live", transcript: "durable" },
      { mode: "reconciling" },
      { mode: "reconciling", transcript: "partial" },
    ];
    for (const sessionControl of malformed) {
      expect(readSessionControl(refWith({ sessionControl }))).toEqual({ mode: "unknown" });
    }
  });

  it("returns to writable the moment the field clears", () => {
    expect(readSessionControl(refWith({ sessionControl: { mode: "reconciling", transcript: "live" } }))).not.toBeNull();
    expect(readSessionControl(refWith({ isStreaming: false }))).toBeNull();
  });
});

describe("sessionControlForLink", () => {
  it("keeps observer state only on a live link (cached/offline copy wins)", () => {
    expect(sessionControlForLink("live", OBSERVER_LIVE)).toEqual(OBSERVER_LIVE);
    expect(sessionControlForLink("cached", OBSERVER_LIVE)).toBeNull();
    expect(sessionControlForLink("offline", OBSERVER_LIVE)).toBeNull();
    expect(sessionControlForLink("live", null)).toBeNull();
  });
});

const EVERY_STATE: readonly SessionControlState[] = [
  { mode: "observer", lockStatus: "live", transcript: "live" },
  { mode: "observer", lockStatus: "live", transcript: "snapshot" },
  { mode: "observer", lockStatus: "suspect", transcript: "live" },
  { mode: "observer", lockStatus: "suspect", transcript: "snapshot" },
  { mode: "observer", lockStatus: "malformed", transcript: "live" },
  { mode: "observer", lockStatus: "malformed", transcript: "snapshot" },
  { mode: "reconciling", transcript: "live" },
  { mode: "reconciling", transcript: "snapshot" },
  { mode: "unknown" },
];

describe("presentSessionControl", () => {
  it("renders complete copy for every state — no holes, no 'undefined'", () => {
    for (const state of EVERY_STATE) {
      const presentation = presentSessionControl(state);
      for (const [key, value] of Object.entries(presentation)) {
        if (key === "bannerBusy") continue;
        expect(typeof value, `${JSON.stringify(state)}.${key}`).toBe("string");
        expect(value, `${JSON.stringify(state)}.${key}`).not.toBe("");
        expect(value, `${JSON.stringify(state)}.${key}`).not.toMatch(/\bundefined\b|\bnull\b/);
      }
    }
    expect(SESSION_CONTROL_RETURNED_ANNOUNCEMENT).toBe(
      "Session is now available in T4. Input is back.",
    );
  });

  it("uses the Active elsewhere rail label only for a confirmed live lock", () => {
    for (const state of EVERY_STATE) {
      const presentation = presentSessionControl(state);
      expect(presentation.railLabel === "Active elsewhere", JSON.stringify(state)).toBe(
        state.mode === "observer" && state.lockStatus === "live",
      );
      expect(presentation.bannerDetail).not.toMatch(/TUI|terminal|CLI|lock|watermark|promot/i);
    }
  });

  it("distinguishes live following from a snapshot copy", () => {
    const live = presentSessionControl({ mode: "observer", lockStatus: "live", transcript: "live" });
    const snapshot = presentSessionControl({
      mode: "observer",
      lockStatus: "live",
      transcript: "snapshot",
    });
    expect(live.bannerDetail).toContain("live");
    expect(live.bannerBusy).toBe(true);
    expect(snapshot.bannerDetail).toContain("saved copy");
    expect(snapshot.bannerBusy).toBe(false);
    expect(live.bannerDetail).not.toBe(snapshot.bannerDetail);
  });

  it("names /continue-in-t4 as the explicit transfer path while the owner is live", () => {
    const presentation = presentSessionControl(OBSERVER_LIVE);
    expect(presentation.bannerDetail).toContain("/continue-in-t4");
    expect(presentation.composerReason).toContain("/continue-in-t4");
  });

  it("distinguishes lock states without naming internals", () => {
    const live = presentSessionControl(OBSERVER_LIVE);
    const suspect = presentSessionControl({
      mode: "observer",
      lockStatus: "suspect",
      transcript: "live",
    });
    const malformed = presentSessionControl({
      mode: "observer",
      lockStatus: "malformed",
      transcript: "live",
    });
    // Suspect: the other app went quiet; T4 waits before taking over.
    expect(suspect.bannerDetail).toContain("gone quiet");
    expect(suspect.bannerDetail).toContain("waits");
    expect(suspect.bannerDetail).not.toContain("/continue-in-t4");
    // Malformed: ownership is unclear; T4 stays read-only until safe.
    expect(malformed.bannerDetail.toLowerCase()).toContain("ownership");
    expect(malformed.bannerDetail.toLowerCase()).toContain("unclear");
    expect(malformed.bannerDetail.toLowerCase()).toContain("read-only");
    expect(malformed.bannerDetail).not.toContain("/continue-in-t4");
    // All three read differently.
    expect(new Set([live.bannerDetail, suspect.bannerDetail, malformed.bannerDetail]).size).toBe(3);
  });

  it("marks reconciling as busy with return-of-input copy", () => {
    for (const transcript of ["live", "snapshot"] as const) {
      const presentation = presentSessionControl({ mode: "reconciling", transcript });
      expect(presentation.bannerBusy).toBe(true);
      expect(presentation.railLabel).toBe("Taking over");
      expect(presentation.composerReason.toLowerCase()).toContain("input returns");
    }
  });
});

describe("sessionControlDisplayKind", () => {
  it("reserves the observer kind for a confirmed live lock", () => {
    for (const state of EVERY_STATE) {
      expect(sessionControlDisplayKind(state) === "observer", JSON.stringify(state)).toBe(
        state.mode === "observer" && state.lockStatus === "live",
      );
    }
  });

  it("maps every state to its honest compact kind", () => {
    for (const transcript of ["live", "snapshot"] as const) {
      expect(
        sessionControlDisplayKind({ mode: "observer", lockStatus: "suspect", transcript }),
      ).toBe("suspect");
      expect(
        sessionControlDisplayKind({ mode: "observer", lockStatus: "malformed", transcript }),
      ).toBe("unclear");
      expect(sessionControlDisplayKind({ mode: "reconciling", transcript })).toBe("reconciling");
    }
    expect(sessionControlDisplayKind({ mode: "unknown" })).toBe("unclear");
  });
});

describe("presentSessionControlKind", () => {
  it("says another app is active only for the observer kind", () => {
    const kinds = ["observer", "suspect", "reconciling", "unclear"] as const;
    for (const kind of kinds) {
      const presentation = presentSessionControlKind(kind);
      expect(presentation.railLabel === "Active elsewhere", kind).toBe(kind === "observer");
      expect(presentation.composerReason.includes("active in another app"), kind).toBe(
        kind === "observer",
      );
    }
  });

  it("matches presentSessionControl copy for each state's kind", () => {
    for (const state of EVERY_STATE) {
      const viaKind = presentSessionControlKind(sessionControlDisplayKind(state));
      const direct = presentSessionControl(state);
      // Compact surfaces render only transcript-independent fields.
      expect(viaKind.railLabel, JSON.stringify(state)).toBe(direct.railLabel);
      expect(viaKind.composerReason, JSON.stringify(state)).toBe(direct.composerReason);
      expect(viaKind.managementReason, JSON.stringify(state)).toBe(direct.managementReason);
    }
  });

  it("keeps suspect and unclear copy calm and owner-free", () => {
    const suspect = presentSessionControlKind("suspect");
    expect(suspect.railLabel).toBe("Waiting to take over");
    expect(suspect.composerReason).toContain("gone quiet");
    const unclear = presentSessionControlKind("unclear");
    expect(unclear.railLabel).toBe("Read-only");
    expect(unclear.composerReason.toLowerCase()).toContain("unclear");
    expect(unclear.composerReason.toLowerCase()).not.toContain("another app is");
  });
});

const WRITABLE_CONTROLS: ComposerControlsSnapshot = {
  modelSupported: true,
  modelUnsupportedReason: null,
  modelLabel: "anthropic/claude",
  modelSelectedId: "model:anthropic/claude",
  modelChoices: [],
  thinkingSupported: true,
  thinkingUnsupportedReason: null,
  thinking: "medium",
  thinkingEffective: "medium",
  thinkingResolved: null,
  thinkingLevels: ["off", "auto", "medium"],
  thinkingOffFloored: false,
  fastSupported: true,
  fastUnsupportedReason: null,
  fastAvailable: true,
  fast: false,
  fastActive: false,
  modeSupported: false,
  mode: null,
  attachmentsSupported: true,
  attachmentsUnsupportedReason: null,
  pendingControl: null,
  controlError: null,
};

describe("gateComposerControls", () => {
  it("gates model/thinking/fast/attachments while values keep host truth", () => {
    const reason = presentSessionControl(OBSERVER_LIVE).controlReason;
    const gated = gateComposerControls(WRITABLE_CONTROLS, reason);
    expect(gated.modelSupported).toBe(false);
    expect(gated.modelUnsupportedReason).toBe(reason);
    expect(gated.thinkingSupported).toBe(false);
    expect(gated.thinkingUnsupportedReason).toBe(reason);
    expect(gated.fastSupported).toBe(false);
    expect(gated.fastUnsupportedReason).toBe(reason);
    expect(gated.modeSupported).toBe(false);
    expect(gated.attachmentsSupported).toBe(false);
    // Labels and current values still show what the host reports.
    expect(gated.modelLabel).toBe(WRITABLE_CONTROLS.modelLabel);
    expect(gated.thinking).toBe(WRITABLE_CONTROLS.thinking);
    expect(gated.fast).toBe(WRITABLE_CONTROLS.fast);
  });
});

describe("slash gating", () => {
  const items = [
    { kind: "command", name: "retry", description: "Retry the last turn" },
    { kind: "command", name: "compact", description: "Compact context" },
  ] as unknown as readonly CatalogItem[];

  it("gates every command with the observer reason on a live link", () => {
    const reason = presentSessionControl(OBSERVER_LIVE).slashReason;
    const commands = slashCommandsFromCatalog(
      items,
      { link: "live", turnActive: false, readOnlyReason: reason },
      ["sessions.prompt"],
    );
    expect(commands.length).toBe(2);
    for (const command of commands) expect(command.disabledReason).toBe(reason);
  });

  it("lets cached/offline reasons win over the observer reason", () => {
    const reason = presentSessionControl(OBSERVER_LIVE).slashReason;
    const [cached] = slashCommandsFromCatalog(
      items,
      { link: "cached", turnActive: false, readOnlyReason: reason },
      ["sessions.prompt"],
    );
    expect(cached?.disabledReason).toBe("Unavailable on a cached copy");
    const [offline] = slashCommandsFromCatalog(
      items,
      { link: "offline", turnActive: false, readOnlyReason: reason },
      ["sessions.prompt"],
    );
    expect(offline?.disabledReason).toBe("Unavailable while the host is unreachable");
  });

  it("stays unchanged when no read-only policy applies", () => {
    const commands = slashCommandsFromCatalog(
      items,
      { link: "live", turnActive: false },
      ["sessions.prompt"],
    );
    for (const command of commands) expect(command.disabledReason).toBeNull();
  });
});

describe("ownership-unclear honesty", () => {
  const UNCLEAR_STATES: readonly SessionControlState[] = [
    { mode: "observer", lockStatus: "malformed", transcript: "live" },
    { mode: "observer", lockStatus: "malformed", transcript: "snapshot" },
    { mode: "unknown" },
  ];

  it("never claims another app controls a malformed or unknown shape", () => {
    for (const state of UNCLEAR_STATES) {
      const presentation = presentSessionControl(state);
      for (const [key, value] of Object.entries(presentation)) {
        if (typeof value !== "string") continue;
        expect(value, `${JSON.stringify(state)}.${key}`).not.toMatch(
          /active in another app|another app controls|app running this session/i,
        );
      }
      expect(presentation.composerReason.toLowerCase()).toContain("unclear");
      expect(presentation.managementReason.toLowerCase()).toContain("unclear");
      expect(presentation.announcement.toLowerCase()).toContain("unclear");
      expect(presentation.bannerDetail.toLowerCase()).toContain("read-only");
    }
  });

  it("says active in another app only while the lock is proven live", () => {
    for (const state of EVERY_STATE) {
      const claims = Object.values(presentSessionControl(state)).some(
        (value) => typeof value === "string" && /active in another app/i.test(value),
      );
      expect(claims, JSON.stringify(state)).toBe(
        state.mode === "observer" && state.lockStatus === "live",
      );
    }
  });
});

describe("attachment gating", () => {
  it("gives attachments the observer-specific rejection reason", () => {
    const reason = presentSessionControl(OBSERVER_LIVE).controlReason;
    const gated = gateComposerControls(WRITABLE_CONTROLS, reason);
    expect(gated.attachmentsSupported).toBe(false);
    expect(gated.attachmentsUnsupportedReason).toBe(reason);
    expect(WRITABLE_CONTROLS.attachmentsUnsupportedReason).toBeNull();
  });
});

describe("reduceControlAnnouncement", () => {
  const RECONCILING: SessionControlState = { mode: "reconciling", transcript: "live" };
  const step = (
    state: ControlAnnouncerState,
    control: SessionControlState | null,
    link: "live" | "cached" | "offline" = "live",
    writable = control === null,
  ) => reduceControlAnnouncement(state, { control, link, writable });

  it("announces entering a state once, then again only when the copy changes", () => {
    let state = initialControlAnnouncerState(null);
    const entered = step(state, OBSERVER_LIVE);
    expect(entered.announcement).toBe(presentSessionControl(OBSERVER_LIVE).announcement);
    state = entered.state;
    expect(step(state, OBSERVER_LIVE).announcement).toBeNull();
    const reconciling = step(state, RECONCILING);
    expect(reconciling.announcement).toBe(presentSessionControl(RECONCILING).announcement);
  });

  it("announces input back only on a confirmed live+writable return", () => {
    let state = initialControlAnnouncerState(OBSERVER_LIVE);
    // Live but not yet writable (grants pending): keep holding.
    const notWritable = reduceControlAnnouncement(state, {
      control: null,
      link: "live",
      writable: false,
    });
    expect(notWritable.announcement).toBeNull();
    expect(notWritable.state.pendingReturn).toBe(true);
    state = notWritable.state;
    const returned = step(state, null);
    expect(returned.announcement).toBe(SESSION_CONTROL_RETURNED_ANNOUNCEMENT);
    // The transition is one-shot.
    expect(step(returned.state, null).announcement).toBeNull();
  });

  it("retains the pending transition across cached/offline without announcing", () => {
    let state = initialControlAnnouncerState(OBSERVER_LIVE);
    for (const link of ["cached", "offline"] as const) {
      const held = reduceControlAnnouncement(state, { control: null, link, writable: false });
      expect(held.announcement).toBeNull();
      expect(held.state.pendingReturn).toBe(true);
      state = held.state;
    }
    // Reconnecting straight into a writable live session announces exactly once.
    const returned = step(state, null);
    expect(returned.announcement).toBe(SESSION_CONTROL_RETURNED_ANNOUNCEMENT);
  });

  it("never announces a return for a session that was never observed", () => {
    let state = initialControlAnnouncerState(null);
    for (const link of ["offline", "cached", "live"] as const) {
      const next = reduceControlAnnouncement(state, { control: null, link, writable: true });
      expect(next.announcement).toBeNull();
      state = next.state;
    }
  });
});
