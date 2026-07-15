import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  IconButton,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@t4-code/ui";
import { QrCode, RefreshCw, Share2, Square, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

import { rendererPlatform } from "../state/store-instance.ts";

type PeerShare = { readonly invite: string };

export function PeerShareAction() {
  const shell = rendererPlatform.shell;
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<PeerShare | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  if (
    shell === null ||
    shell.peerShareStart === undefined ||
    shell.peerShareStop === undefined ||
    shell.peerShareRegenerate === undefined
  ) return null;
  const peerShareStart = shell.peerShareStart;
  const peerShareStop = shell.peerShareStop;
  const peerShareRegenerate = shell.peerShareRegenerate;

  const begin = async (regenerate = false): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setCopied(false);
    try {
      setShare(await (regenerate ? peerShareRegenerate() : peerShareStart()));
    } catch {
      setError("Couldn’t start a private mobile connection. Check that the local OMP service is running, then try again.");
    } finally {
      setBusy(false);
    }
  };
  const stop = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await peerShareStop();
      setShare(undefined);
    } catch {
      setError("Couldn’t stop the private mobile connection.");
    } finally {
      setBusy(false);
    }
  };
  const copy = async (): Promise<void> => {
    if (share === undefined) return;
    try {
      await navigator.clipboard.writeText(share.invite);
      setCopied(true);
    } catch {
      setError("Copy isn’t available here. Select the key below and copy it manually.");
    }
  };
  const openDialog = (): void => {
    setOpen(true);
    if (share === undefined) void begin();
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger
          render={
            <IconButton
              aria-label="Share private mobile connection"
              className="size-11 sm:size-7"
              onClick={openDialog}
              size="icon-sm"
            >
              <Share2 />
            </IconButton>
          }
        />
        <TooltipPopup side="bottom">Connect a phone privately</TooltipPopup>
      </Tooltip>
      <DialogPopup aria-label="Private mobile connection" className="max-w-md">
        <DialogHeader>
          <DialogTitle>Private mobile connection</DialogTitle>
          <DialogDescription>
            Scan this code from T4 Code on Android, or paste the key. It stays paired until you reset it and supports up to four phones at once.
          </DialogDescription>
        </DialogHeader>
        {share !== undefined ? (
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-xl border border-border bg-background p-3 shadow-sm">
              <QRCodeSVG includeMargin level="M" size={208} value={share.invite} />
            </div>
            <p className="w-full break-all rounded-md bg-secondary px-3 py-2 font-mono text-xs leading-relaxed">{share.invite}</p>
          </div>
        ) : (
          <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
            <QrCode className="mr-2 size-4" /> {busy ? "Creating private key…" : "No private key is active."}
          </div>
        )}
        {error !== undefined && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button disabled={busy} size="sm" variant="ghost" />}>Close</DialogClose>
          <Button disabled={busy || share === undefined} onClick={() => void copy()} size="sm" variant="outline">
            <Copy /> {copied ? "Copied" : "Copy key"}
          </Button>
          <Button disabled={busy || share === undefined} onClick={() => void begin(true)} size="sm" variant="outline">
            <RefreshCw /> Reset pairing
          </Button>
          <Button disabled={busy || share === undefined} onClick={() => void stop()} size="sm" variant="destructive">
            <Square /> Stop
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
