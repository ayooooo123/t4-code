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
  Spinner,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@t4-code/ui";
import { FolderCog, FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";

import { desktopRuntime, useDesktopRuntimeSnapshot } from "../platform/desktop-runtime.ts";
import { rendererPlatform, workspaceStore } from "../state/store-instance.ts";

type Roots = { readonly roots: readonly { readonly id: string; readonly label: string }[]; readonly activeRootId: string | null };

/** Desktop-only chooser for the directories T4 is allowed to create projects in. */
export function WorkspaceRootsAction({ placement = "toolbar" }: { readonly placement?: "toolbar" | "rail" }) {
  const shell = rendererPlatform.shell;
  const [open, setOpen] = useState(false);
  const [roots, setRoots] = useState<Roots>({ roots: [], activeRootId: null });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const snapshot = useDesktopRuntimeSnapshot();
  if (shell === null || shell.workspaceRootsList === undefined || shell.workspaceRootChoose === undefined || shell.workspaceRootSelect === undefined || shell.workspaceProjectCreate === undefined) return null;

  const refresh = async (): Promise<void> => {
    try { setRoots(await shell.workspaceRootsList!()); }
    catch { setMessage("Couldn’t load the approved workspace folders."); }
  };
  useEffect(() => { if (open) void refresh(); }, [open]);

  const chooseRoot = async (): Promise<void> => {
    setBusy(true); setMessage(null);
    try {
      const result = await shell.workspaceRootChoose!();
      if (result.root !== null) await refresh();
    } catch { setMessage("Couldn’t approve that workspace folder."); }
    finally { setBusy(false); }
  };
  const selectRoot = async (rootId: string): Promise<void> => {
    setBusy(true); setMessage(null);
    try { await shell.workspaceRootSelect!({ rootId }); await refresh(); }
    catch { setMessage("Couldn’t select that workspace folder."); }
    finally { setBusy(false); }
  };
  const createProject = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setBusy(true); setMessage(null);
    try {
      const project = await shell.workspaceProjectCreate!({ name: trimmed });
      const binding = snapshot?.targetHosts.entries().next().value as readonly [string, string] | undefined;
      if (binding !== undefined) workspaceStore.getState().addWorkspaceProject({ hostId: binding[1], projectId: project.project.id, name: project.project.name });
      setName("");
      setMessage(binding === undefined ? `Created ${project.project.name} and its first OMP session. Connect to OMP to sync it into the left rail.` : `Created ${project.project.name} and its first OMP session. Syncing it into the left rail…`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Couldn’t create the project folder."); }
    finally { setBusy(false); }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      {placement === "rail" ? (
        <Button className="mt-2 w-full justify-start" onClick={() => setOpen(true)} size="sm" variant="outline"><FolderPlus /> New folder</Button>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<IconButton aria-label="Manage workspace folders" className="size-11 sm:size-7" onClick={() => setOpen(true)} size="icon-sm"><FolderCog /></IconButton>} />
          <TooltipPopup side="bottom">Workspace folders</TooltipPopup>
        </Tooltip>
      )}
      <DialogPopup aria-label="Workspace folders" className="max-w-md">
        <DialogHeader>
          <DialogTitle>Workspace folders</DialogTitle>
          <DialogDescription>Choose folders on this computer. Your phone can select from these approved folders and create projects inside them; it cannot browse the computer.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {roots.roots.length === 0 ? <p className="rounded-md bg-secondary px-3 py-2 text-sm text-muted-foreground">No workspace folders are approved yet.</p> : roots.roots.map((root) => (
            <Button className="justify-start" disabled={busy} key={root.id} onClick={() => void selectRoot(root.id)} variant={root.id === roots.activeRootId ? "secondary" : "outline"}>
              <span className="min-w-0 truncate">{root.label}</span>{root.id === roots.activeRootId && <span className="ml-auto text-xs">Active</span>}
            </Button>
          ))}
          <Button disabled={busy} onClick={() => void chooseRoot()} variant="outline"><FolderPlus /> Approve a folder</Button>
        </div>
        <div className="mt-4 flex gap-2">
          <input aria-label="New project folder name" className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" disabled={busy || roots.activeRootId === null} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createProject(); }} placeholder="New project folder" value={name} />
          <Button disabled={busy || roots.activeRootId === null || name.trim() === ""} onClick={() => void createProject()}>{busy && <Spinner />}Create</Button>
        </div>
        {message !== null && <p aria-live="polite" className="mt-2 text-sm text-muted-foreground" role="status">{message}</p>}
        <DialogFooter><DialogClose render={<Button disabled={busy} size="sm" variant="ghost" />}>Close</DialogClose></DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
