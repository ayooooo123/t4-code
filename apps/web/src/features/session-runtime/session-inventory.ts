import type { DesktopRuntimeSnapshot } from "@t4-code/client";

/** True only when this host has supplied one complete current session inventory. */
export function hostSessionInventoryIsComplete(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
): boolean {
  const metadata = snapshot.projection.sessionIndexMetadata.get(hostId);
  if (metadata === undefined || metadata.truncated) return false;
  let indexed = 0;
  for (const ref of snapshot.projection.sessionIndex.values()) {
    if (String(ref.hostId) === hostId) indexed += 1;
  }
  return indexed === metadata.totalCount;
}

export type SessionWriteLink = "live" | "cached" | "offline";

/**
 * Dispatch-time freshness for one session, stricter than the render link:
 * offline when the target is not connected; live ONLY when the target is
 * bound to this host, the host's session inventory is complete, THIS
 * session is present in the index, and any warm projection is fresh. A
 * missing indexed ref cannot prove the session's current state, so it
 * stays cached/read-only for writes.
 */
export function sessionWriteLink(
  snapshot: DesktopRuntimeSnapshot,
  targetId: string,
  hostId: string,
  sessionId: string,
): SessionWriteLink {
  if (snapshot.connections.get(targetId) !== "connected") return "offline";
  const key = `${hostId}\u0000${sessionId}`;
  const warm = snapshot.projection.sessions.get(key);
  const inventoryReady =
    snapshot.targetHosts.get(targetId) === hostId &&
    hostSessionInventoryIsComplete(snapshot, hostId) &&
    snapshot.projection.sessionIndex.get(key) !== undefined;
  return !inventoryReady || (warm !== undefined && warm.freshness !== "fresh")
    ? "cached"
    : "live";
}
