import { Button, Spinner } from "@t4-code/ui";
import { Camera, ClipboardPaste, KeyRound, ScanLine, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  MobileQrScanError,
  buildPeerPairingCandidate,
  createMobileQrScanAttempt,
  type MobileQrScanAttempt,
} from "../platform/mobile-qr-scanner.ts";
import {
  peerDesktopPublicKey,
  type StoredPeerMobileBackend,
} from "../platform/mobile-connection-records.ts";
import { nativeQrScanner } from "../platform/native-mobile.ts";

interface MobileQrAttemptCallbacks {
  readonly success: (candidate: StoredPeerMobileBackend) => void;
  readonly failure: (error: unknown) => void;
  readonly settled: () => void;
}

/** Owns the one scan allowed to update a mounted mobile connection flow. */
export class MobileQrAttemptOwner {
  private current: MobileQrScanAttempt | null = null;

  async run(attempt: MobileQrScanAttempt, callbacks: MobileQrAttemptCallbacks): Promise<void> {
    this.current?.cancel("replaced");
    this.current = attempt;
    try {
      const candidate = await attempt.result;
      if (this.current !== attempt) return;
      callbacks.success(candidate);
    } catch (error) {
      if (this.current !== attempt) return;
      callbacks.failure(error);
    } finally {
      if (this.current === attempt) {
        this.current = null;
        callbacks.settled();
      }
    }
  }

  cancel(reason: string): void {
    this.current?.cancel(reason);
  }

  dispose(): void {
    const attempt = this.current;
    this.current = null;
    attempt?.cancel("unmount");
  }
}

/** Returns the component-owned scan slot and disposes it through React's real lifecycle. */
export function useMobileQrAttemptOwner(): MobileQrAttemptOwner {
  const ownerRef = useRef<MobileQrAttemptOwner | null>(null);
  ownerRef.current ??= new MobileQrAttemptOwner();
  const owner = ownerRef.current;
  useEffect(() => () => owner.dispose(), [owner]);
  return owner;
}

type ScannerCapability = "loading" | "supported" | "unavailable";
type ScannerPhase = "instructions" | "paste" | "opening" | "active" | "cancelling" | "preview";

async function defaultCapability(): Promise<"supported" | "unavailable"> {
  const plugin = nativeQrScanner();
  if (plugin === null) return "unavailable";
  try {
    return (await plugin.isSupported()).supported ? "supported" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function safeScanMessage(error: unknown): string {
  if (error instanceof MobileQrScanError) return error.message;
  return "The QR scanner could not start. Try again.";
}

function fingerprint(candidate: StoredPeerMobileBackend): string {
  const key = peerDesktopPublicKey(candidate.invite);
  return key.slice(0, 16).match(/.{1,4}/gu)?.join(" ") ?? key.slice(0, 16);
}

export interface MobileQrScannerFlowProps {
  readonly checkCapability?: () => Promise<"supported" | "unavailable">;
  readonly createAttempt?: () => MobileQrScanAttempt;
  readonly onDismiss: () => void;
  /** Returns false when the atomic first-run boundary refuses the write. */
  readonly save: (candidate: StoredPeerMobileBackend) => boolean;
}

/**
 * Stable web-owned pairing sheet. The Android activity exclusively owns the
 * camera surface; this component owns instructions, recovery and confirmation.
 * Persistence is injected so scan and paste cannot bypass the same guard.
 */
export function MobileQrScannerFlow({
  checkCapability = defaultCapability,
  createAttempt = createMobileQrScanAttempt,
  onDismiss,
  save,
}: MobileQrScannerFlowProps) {
  const [capability, setCapability] = useState<ScannerCapability>("loading");
  const [phase, setPhase] = useState<ScannerPhase>("instructions");
  const [message, setMessage] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [candidate, setCandidate] = useState<StoredPeerMobileBackend | null>(null);
  const confirmed = useRef(false);
  const mounted = useRef(true);
  const dialogRef = useRef<HTMLElement | null>(null);
  const attemptSequence = useRef(0);
  const owner = useMobileQrAttemptOwner();

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    void checkCapability().then(
      (value) => { if (!cancelled) setCapability(value); },
      () => { if (!cancelled) setCapability("unavailable"); },
    );
    return () => { cancelled = true; mounted.current = false; };
  }, [checkCapability]);

  useEffect(() => { dialogRef.current?.focus(); }, []);

  const beginScan = (): void => {
    if (capability !== "supported" || phase === "opening" || phase === "active") return;
    setMessage(null);
    setCandidate(null);
    setPhase("opening");
    const attempt = createAttempt();
    const sequence = ++attemptSequence.current;
    const markActive = (): void => {
      if (!mounted.current || attemptSequence.current !== sequence) return;
      setPhase((current) => current === "opening" ? "active" : current);
    };
    if (attempt.opened === undefined) markActive();
    else void attempt.opened.then(markActive);
    void owner.run(attempt, {
      success: (next) => {
        if (attemptSequence.current !== sequence) return;
        confirmed.current = false;
        setCandidate(next);
        setPhase("preview");
      },
      failure: (error) => {
        const failureMessage = safeScanMessage(error);
        const revealRetry = (): void => {
          if (!mounted.current || attemptSequence.current !== sequence) return;
          setMessage(failureMessage);
          setPhase("instructions");
        };
        if (attempt.closed === undefined) {
          revealRetry();
          return;
        }
        setMessage(failureMessage);
        setPhase("cancelling");
        // There is deliberately no retry timeout here. Result settlement stays
        // bounded in the coordinator, but enabling another scan before native
        // startScan returns can collide with the Activity's scan_active guard.
        // The sheet remains dismissible if a broken bridge never acknowledges.
        void attempt.closed.then(revealRetry);
      },
      settled: () => undefined,
    });
  };

  const reviewPaste = (): void => {
    try {
      const next = buildPeerPairingCandidate(paste);
      confirmed.current = false;
      setCandidate(next);
      setMessage(null);
      setPhase("preview");
    } catch (error) {
      setMessage(safeScanMessage(error));
    }
  };

  const confirm = (): void => {
    if (candidate === null || confirmed.current) return;
    confirmed.current = true;
    if (save(candidate)) return;
    setMessage("Another saved connection appeared. Nothing was replaced; reopen setup to continue.");
    setPhase("instructions");
    setCandidate(null);
  };

  const scanning = phase === "opening" || phase === "active" || phase === "cancelling";
  const status = phase === "opening"
    ? "Opening camera…"
    : phase === "active"
      ? "Scanner active. Point the camera at the desktop QR code."
      : phase === "cancelling"
        ? "Closing scanner…"
        : message ?? "Your key stays on this device until you confirm.";

  return (
    <section
      aria-describedby="mobile-pairing-status"
      aria-labelledby="mobile-pairing-title"
      aria-modal="true"
      className="flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full flex-col overflow-y-auto rounded-t-2xl border-border border-t bg-background px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-foreground shadow-2xl"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onDismiss();
      }}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">Private connection</p>
          <h2 className="mt-1 font-heading font-semibold text-xl" id="mobile-pairing-title">Pair this phone</h2>
        </div>
        <Button aria-label="Not now" className="size-11 shrink-0" onClick={onDismiss} size="icon" type="button" variant="ghost">
          <X aria-hidden="true" />
        </Button>
      </div>

      <p aria-live="polite" className="mt-4 min-h-11 text-muted-foreground text-sm leading-relaxed" id="mobile-pairing-status" role="status">
        {status}
      </p>

      {phase === "preview" && candidate !== null ? (
        <div className="mt-3 rounded-xl border border-border bg-muted/30 p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><ShieldCheck aria-hidden="true" className="size-5" /></div>
            <div>
              <p className="font-medium text-sm">T4 desktop key</p>
              <p className="mt-1 font-mono text-muted-foreground text-xs tracking-[0.12em]">{fingerprint(candidate)}</p>
            </div>
          </div>
          <p className="mt-4 text-muted-foreground text-sm leading-relaxed">Compare this fingerprint with the desktop before connecting.</p>
          <Button className="mt-5 h-12 w-full text-base" onClick={confirm} size="lg" type="button">
            <KeyRound aria-hidden="true" /> Confirm connection
          </Button>
          <Button className="mt-2 h-12 w-full" onClick={onDismiss} type="button" variant="ghost">Not now</Button>
        </div>
      ) : phase === "paste" ? (
        <div className="mt-3">
          <label className="font-medium text-sm" htmlFor="mobile-private-key">Private connection key</label>
          <textarea
            autoCapitalize="none"
            autoCorrect="off"
            className="mt-2 min-h-28 w-full resize-none rounded-xl border border-input bg-background p-3 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
            id="mobile-private-key"
            onChange={(event) => setPaste(event.target.value)}
            placeholder="t4peer://v1/…"
            spellCheck={false}
            value={paste}
          />
          <Button className="mt-3 h-12 w-full text-base" onClick={reviewPaste} size="lg" type="button">Review key</Button>
          <Button className="mt-2 h-12 w-full" onClick={() => { setMessage(null); setPhase("instructions"); }} type="button" variant="ghost">Back</Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {capability === "loading" && (
            <Button className="h-12 w-full text-base" disabled size="lg" type="button"><Spinner /> Checking camera…</Button>
          )}
          {capability === "supported" && !scanning && (
            <Button className="h-12 w-full text-base" onClick={beginScan} size="lg" type="button">
              <ScanLine aria-hidden="true" /> {message === null ? "Scan QR code" : "Scan again"}
            </Button>
          )}
          {capability === "unavailable" && (
            <div className="rounded-lg border border-border p-3 text-muted-foreground text-sm leading-relaxed">
              Camera scanning isn’t available on this device. Paste the private key shown on your desktop instead.
            </div>
          )}
          {scanning && (
            <Button
              className="h-12 w-full text-base"
              disabled={phase === "cancelling"}
              onClick={() => { setPhase("cancelling"); owner.cancel("user"); }}
              size="lg"
              type="button"
              variant="outline"
            >
              {phase === "cancelling" ? <Spinner /> : <Camera aria-hidden="true" />}
              {phase === "cancelling" ? "Closing scanner…" : "Cancel scan"}
            </Button>
          )}
          {!scanning && (
            <Button className="h-12 w-full text-base" onClick={() => { setMessage(null); setPhase("paste"); }} size="lg" type="button" variant="outline">
              <ClipboardPaste aria-hidden="true" /> Paste private key
            </Button>
          )}
          {!scanning && <Button className="h-12 w-full" onClick={onDismiss} type="button" variant="ghost">Not now</Button>}
        </div>
      )}
    </section>
  );
}
