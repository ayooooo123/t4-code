import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useMobileQrAttemptOwner } from "../src/components/MobileConnectionScreen.tsx";
import { buildPeerPairingCandidate, type MobileQrScanAttempt } from "../src/platform/mobile-qr-scanner.ts";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INVITE = `t4peer://v1/${KEY}/${KEY}`;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferredAttempt(): {
  readonly attempt: MobileQrScanAttempt;
  readonly cancellations: string[];
  resolve(): void;
} {
  let resolveResult!: (value: ReturnType<typeof buildPeerPairingCandidate>) => void;
  const cancellations: string[] = [];
  return {
    attempt: {
      result: new Promise((resolve) => { resolveResult = resolve; }),
      cancel: (reason) => { cancellations.push(reason); },
    },
    cancellations,
    resolve: () => resolveResult(buildPeerPairingCandidate(INVITE)),
  };
}

function ScanHarness({
  attempt,
  events,
}: {
  readonly attempt: MobileQrScanAttempt;
  readonly events: string[];
}) {
  const owner = useMobileQrAttemptOwner();
  useEffect(() => {
    void owner.run(attempt, {
      success: () => { events.push("persist", "reload", "success-state"); },
      failure: () => { events.push("error-state"); },
      settled: () => { events.push("settled-state"); },
    });
  }, [attempt, events, owner]);
  return null;
}

let renderer: ReactTestRenderer | undefined;
let consoleErrors: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  consoleErrors?.mockRestore();
  consoleErrors = undefined;
});

describe("mounted mobile QR lifecycle", () => {
  it("cancels the active attempt on real React unmount and suppresses its late result", async () => {
    const errors: unknown[][] = [];
    consoleErrors = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args); });
    const scan = deferredAttempt();
    const events: string[] = [];

    await act(async () => {
      renderer = create(<ScanHarness attempt={scan.attempt} events={events} />);
    });
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    expect(scan.cancellations).toEqual(["unmount"]);

    await act(async () => {
      scan.resolve();
      await Promise.resolve();
    });
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors.flat().join(" ")).toMatch(/react-test-renderer is deprecated/u);
  });

  it("cancels the active attempt when the mounted flow is replaced", async () => {
    const errors: unknown[][] = [];
    consoleErrors = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args); });
    const first = deferredAttempt();
    const second = deferredAttempt();
    const events: string[] = [];
    await act(async () => {
      renderer = create(<ScanHarness attempt={first.attempt} events={events} />);
    });
    await act(async () => {
      renderer?.update(<ScanHarness attempt={second.attempt} events={events} />);
    });
    expect(first.cancellations).toEqual(["replaced"]);

    await act(async () => {
      first.resolve();
      second.resolve();
      await Promise.resolve();
    });
    expect(events).toEqual(["persist", "reload", "success-state", "settled-state"]);
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    expect(second.cancellations).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors.flat().join(" ")).toMatch(/react-test-renderer is deprecated/u);
  });
});
