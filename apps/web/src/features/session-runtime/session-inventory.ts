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

/** True only when this process received the ref after the latest reconnect boundary. */
export function sessionRefIsCurrent(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
  sessionId: string,
): boolean {
  const key = `${hostId}\u0000${sessionId}`;
  return (
    snapshot.projection.sessionIndex.has(key) &&
    snapshot.projection.sessionRefArrivalOrdinals.has(key)
  );
}

/**
 * Dispatch-time freshness for one session: offline when the target is not
 * connected; live when the target is bound to this host and THIS session has
 * a ref from the current connection. A live transcript cursor gap stays
 * cached until a later inventory ref proves current authority; a restored
 * cache without that live-gap marker may become writable from current
 * inventory alone. The host still enforces revision/ownership on dispatch.
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
  const refArrivalOrdinal = snapshot.projection.sessionRefArrivalOrdinals.get(key);
  const inventoryReady =
    snapshot.targetHosts.get(targetId) === hostId &&
    snapshot.projection.sessionIndex.has(key) &&
    refArrivalOrdinal !== undefined;
  const catchUpFromCurrentStream =
    warm?.catchingUpSinceArrivalOrdinal !== undefined &&
    refArrivalOrdinal !== undefined &&
    refArrivalOrdinal <= warm.catchingUpSinceArrivalOrdinal;
  return !inventoryReady || catchUpFromCurrentStream ? "cached" : "live";
}
