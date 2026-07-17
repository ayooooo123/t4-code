import { BrandLockup, Button, Spinner } from "@t4-code/ui";
import { Cable, KeyRound, LockKeyhole, Network } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  probeMobileBackend,
  replaceStoredMobileBackend,
  writeFirstRunPeerBackend,
  writeFirstRunTailnetBackend,
} from "../platform/native-mobile.ts";
import {
  MobileConnectionUserError,
  parseTailnetBackend,
  type StoredMobileBackend,
} from "../platform/mobile-connection-records.ts";
import { buildPeerPairingCandidate } from "../platform/mobile-qr-scanner.ts";
import { MobileQrScannerFlow } from "./MobileQrScannerFlow.tsx";

export { MobileQrAttemptOwner, useMobileQrAttemptOwner } from "./MobileQrScannerFlow.tsx";

/**
 * Shared Tailnet address form: parse, probe, then persist-and-reload. Used by
 * the first-run screen and the host manager's Add view so address validation
 * and probing never fork. Nothing is written until the probe succeeds, so a
 * cancelled or failed attempt leaves every saved host untouched. `save`
 * decides what a success writes: startup repair replaces broken state, the
 * host manager upserts alongside existing hosts.
 */
type MobileBackendProbe = (
  backend: StoredMobileBackend,
  options: { readonly signal?: AbortSignal },
) => Promise<void>;

/** Shared validation boundary used by the pasted-key submit path. */
export function buildPastedPeerPairingCandidate(
  value: string,
): ReturnType<typeof buildPeerPairingCandidate> {
  return buildPeerPairingCandidate(value);
}

/**
 * Probe before persistence, and re-check cancellation after the async boundary.
 * This keeps a closed or backed-out Add view from saving a late probe result.
 */
export async function probeAndSaveMobileBackend(
  backend: StoredMobileBackend,
  io: {
    readonly signal: AbortSignal;
    readonly probe?: MobileBackendProbe;
    readonly save: (backend: StoredMobileBackend) => boolean | void;
    readonly reload: () => void;
  },
): Promise<"cancelled" | "refused" | "saved"> {
  const probe = io.probe ?? probeMobileBackend;
  try {
    await probe(backend, { signal: io.signal });
  } catch (error) {
    if (io.signal.aborted) return "cancelled";
    throw error;
  }
  if (io.signal.aborted) return "cancelled";
  if (io.save(backend) === false) return "refused";
  io.reload();
  return "saved";
}

export function safeTailnetFormMessage(error: unknown, phase: "validation" | "probe"): string {
  if (error instanceof MobileConnectionUserError) return error.message;
  return phase === "validation"
    ? "Enter a valid HTTPS Tailnet address."
    : "T4 Code could not verify that host. Check Tailscale and try again.";
}

export function TailnetAddressForm({
  cancelSignal,
  probe,
  save,
  submitLabel = "Connect",
}: {
  readonly cancelSignal?: AbortSignal;
  readonly probe?: MobileBackendProbe;
  readonly save: (backend: StoredMobileBackend) => boolean | void;
  readonly submitLabel?: string;
}) {
  const id = useId();
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const activeProbe = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      activeProbe.current?.abort();
    },
    [],
  );
  const addressId = `${id}-address`;
  const helpId = `${id}-help`;
  const statusId = `${id}-status`;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (checking) return;
        setMessage(null);
        let backend;
        try {
          backend = parseTailnetBackend(address);
        } catch (error) {
          setMessage(safeTailnetFormMessage(error, "validation"));
          return;
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        cancelSignal?.addEventListener("abort", cancel, { once: true });
        if (cancelSignal?.aborted === true) controller.abort();
        activeProbe.current = controller;
        setChecking(true);
        void probeAndSaveMobileBackend(backend, {
          signal: controller.signal,
          ...(probe === undefined ? {} : { probe }),
          save,
          reload: () => window.location.reload(),
        }).then((outcome) => {
          if (outcome === "refused") {
            setMessage("Another saved connection appeared. Nothing was replaced; reopen setup to continue.");
          }
        })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            setMessage(safeTailnetFormMessage(error, "probe"));
          })
          .finally(() => {
            cancelSignal?.removeEventListener("abort", cancel);
            if (activeProbe.current !== controller) return;
            activeProbe.current = null;
            if (!controller.signal.aborted) setChecking(false);
          });
      }}
    >
      <label className="font-medium text-sm" htmlFor={addressId}>
        Tailnet address
      </label>
      <input
        aria-describedby={`${helpId} ${statusId}`}
        aria-invalid={message !== null}
        autoCapitalize="none"
        autoComplete="url"
        autoCorrect="off"
        className="h-12 w-full rounded-lg border border-input bg-background px-3 font-mono text-base outline-none transition-shadow duration-(--motion-duration-fast) placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        disabled={checking}
        id={addressId}
        inputMode="url"
        onChange={(event) => setAddress(event.target.value)}
        placeholder="https://host.tailnet.ts.net:8445"
        spellCheck={false}
        type="url"
        value={address}
      />
      <p className="text-muted-foreground text-xs leading-relaxed" id={helpId}>
        Use the full HTTPS address shown by the T4 gateway on your computer.
      </p>
      <p
        aria-live="polite"
        className="min-h-5 text-destructive-foreground text-sm"
        id={statusId}
        role={message === null ? undefined : "alert"}
      >
        {message}
      </p>
      <Button className="mt-1 h-12 w-full text-base" disabled={checking} size="lg" type="submit">
        {checking && <Spinner />}
        {checking ? "Checking host…" : submitLabel}
      </Button>
    </form>
  );
}

export function MobileConnectionScreen({
  mode,
  repairAction,
  startupMessage,
}: {
  readonly mode: "first-run" | "repair";
  readonly repairAction?: "tailnet" | "upgrade" | "unavailable";
  readonly startupMessage?: string;
}) {
  const [showPrivatePairing, setShowPrivatePairing] = useState(mode === "first-run");
  const [showTailnet, setShowTailnet] = useState(mode === "repair" && repairAction === "tailnet");

  const savePrivateInvite = (backend: ReturnType<typeof buildPeerPairingCandidate>): boolean => {
    const saved = writeFirstRunPeerBackend(backend);
    if (saved) window.location.reload();
    return saved;
  };

  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <header className="flex min-h-14 items-center border-border border-b px-4 pt-[env(safe-area-inset-top)]">
        <BrandLockup />
      </header>
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-5 py-10">
        <div className="mb-8 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Cable aria-hidden="true" className="size-5" />
        </div>
        <h1 className="text-balance font-heading font-semibold text-2xl">
          {mode === "first-run" ? "Connect to your T4 host" : "Repair your saved connection"}
        </h1>
        <p className="mt-2 max-w-[62ch] text-pretty text-muted-foreground text-sm leading-relaxed">
          {mode === "first-run"
            ? "Scan the key from your desktop to connect directly. OMP and your projects stay on your computer."
            : "T4 Code found saved connection data it cannot safely open. Existing bytes will not be replaced by QR or pasted-key setup."}
        </p>

        {startupMessage !== undefined && (
          <p className="mt-5 rounded-lg border border-border p-3 text-destructive-foreground text-sm" role="alert">{startupMessage}</p>
        )}

        {mode === "first-run" && showPrivatePairing && (
          <div className="mt-8 overflow-hidden rounded-2xl border border-border">
            <MobileQrScannerFlow onDismiss={() => setShowPrivatePairing(false)} save={savePrivateInvite} />
          </div>
        )}

        {mode === "first-run" && !showPrivatePairing && !showTailnet && (
          <Button autoFocus className="mt-8 h-12 w-full text-base" onClick={() => setShowPrivatePairing(true)} size="lg" type="button">
            <KeyRound aria-hidden="true" /> Scan or paste private key
          </Button>
        )}

        {showTailnet && (
          <div className="mt-8 rounded-xl border border-border p-4">
            <TailnetAddressForm
              save={mode === "first-run" ? writeFirstRunTailnetBackend : replaceStoredMobileBackend}
              submitLabel={mode === "repair" ? "Repair with Tailnet" : "Use Tailscale address"}
            />
          </div>
        )}

        {mode === "first-run" && !showTailnet && !showPrivatePairing && (
          <Button className="mt-4 h-12 w-full text-base" onClick={() => { setShowPrivatePairing(false); setShowTailnet(true); }} size="lg" type="button" variant="outline">
            <Network aria-hidden="true" /> Use Tailscale address
          </Button>
        )}

        <div className="mt-9 divide-y divide-border border-border border-y">
          <div className="flex gap-3 py-3.5">
            <Network aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-relaxed">
              Open Tailscale on this phone and connect to the same tailnet as your computer before using a Tailnet address.
            </p>
          </div>
          <div className="flex gap-3 py-3.5">
            <LockKeyhole aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-relaxed">
              The key authorizes only this direct desktop connection. Reset it from the desktop if you want to revoke access.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
