import { Button, Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle, IconButton, Spinner } from "@t4-code/ui";
import { useNavigate } from "@tanstack/react-router";
import { FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";

import { createLiveSession } from "../features/session-runtime/live-create.ts";
import { desktopRuntime, useDesktopRuntimeSnapshot } from "../platform/desktop-runtime.ts";
import { currentNativeMobilePeerInvite, nativeMobilePlatform } from "../platform/native-mobile.ts";
import { rendererPlatform } from "../state/store-instance.ts";

export function MobileWorkspaceAction() {
  const shell = rendererPlatform.shell;
  const snapshot = useDesktopRuntimeSnapshot();
  const controller = desktopRuntime();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [roots, setRoots] = useState<{ readonly roots: readonly { readonly id: string; readonly label: string }[]; readonly activeRootId: string | null }>({ roots: [], activeRootId: null });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (nativeMobilePlatform() === null || currentNativeMobilePeerInvite() === null || shell === null || shell.workspaceRootsList === undefined || shell.workspaceRootSelect === undefined || shell.workspaceProjectCreate === undefined) return null;

  const load = async (): Promise<void> => {
    try { setRoots(await shell.workspaceRootsList!()); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Couldn’t load workspace folders."); }
  };
  useEffect(() => { if (open) void load(); }, [open]);
  const select = async (rootId: string): Promise<void> => {
    setBusy(true); setMessage(null);
    try { await shell.workspaceRootSelect!({ rootId }); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Couldn’t select that workspace folder."); }
    finally { setBusy(false); }
  };
  const create = async (): Promise<void> => {
    if (controller === null || snapshot === null || name.trim() === "") return;
    const binding = snapshot.targetHosts.entries().next().value as readonly [string, string] | undefined;
    if (binding === undefined) { setMessage("Connect to the desktop before creating a project."); return; }
    setBusy(true); setMessage(null);
    try {
      const project = await shell.workspaceProjectCreate!({ name: name.trim() });
      const created = await createLiveSession(controller, { targetId: binding[0], hostId: binding[1], projectId: project.project.id });
      setOpen(false);
      void navigate({ params: { sessionId: created.viewId }, to: "/sessions/$sessionId" });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Couldn’t create the project."); }
    finally { setBusy(false); }
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <IconButton aria-label="Create project folder" className="size-11" onClick={() => setOpen(true)} size="icon-sm"><FolderPlus /></IconButton>
      <DialogPopup aria-label="New project" className="max-w-md">
        <DialogHeader><DialogTitle>New project</DialogTitle><DialogDescription>Select an approved desktop folder, then create a project and its first OMP session.</DialogDescription></DialogHeader>
        <div className="flex flex-col gap-2">{roots.roots.length === 0 ? <p className="rounded-md bg-secondary p-3 text-sm text-muted-foreground">No folders are approved on the desktop yet.</p> : roots.roots.map((root) => <Button disabled={busy} key={root.id} onClick={() => void select(root.id)} variant={root.id === roots.activeRootId ? "secondary" : "outline"}>{root.label}{root.id === roots.activeRootId && <span className="ml-auto text-xs">Active</span>}</Button>)}</div>
        <div className="mt-4 flex gap-2"><input aria-label="Project name" className="h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3" disabled={busy || roots.activeRootId === null} onChange={(event) => setName(event.target.value)} placeholder="Project name" value={name} /><Button disabled={busy || roots.activeRootId === null || name.trim() === ""} onClick={() => void create()}>{busy && <Spinner />}Create</Button></div>
        {message !== null && <p aria-live="polite" className="mt-2 text-sm text-destructive-foreground" role="alert">{message}</p>}
        <DialogFooter><DialogClose render={<Button disabled={busy} size="sm" variant="ghost" />}>Close</DialogClose></DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
