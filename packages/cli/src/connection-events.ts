export const QUICK_RECONNECT_GRACE_MS = 1_000;

export interface ConnectionEventGate {
  dropped(): void;
  reconnected(): void;
  reset(): void;
}

export function createConnectionEventGate(
  emit: (message: string) => void,
  graceMs = QUICK_RECONNECT_GRACE_MS,
): ConnectionEventGate {
  let pendingDrop: ReturnType<typeof setTimeout> | undefined;
  let reportedDrop = false;

  return {
    dropped() {
      if (pendingDrop || reportedDrop) return;
      pendingDrop = setTimeout(() => {
        pendingDrop = undefined;
        reportedDrop = true;
        emit("Connection dropped. Your seat is held for 60 seconds; use reconnect if recovery fails.");
      }, graceMs);
    },
    reconnected() {
      if (pendingDrop) {
        clearTimeout(pendingDrop);
        pendingDrop = undefined;
        return;
      }
      if (!reportedDrop) return;
      reportedDrop = false;
      emit("Reconnected.");
    },
    reset() {
      if (pendingDrop) clearTimeout(pendingDrop);
      pendingDrop = undefined;
      reportedDrop = false;
    },
  };
}

export function isRedundantSelfReconnectEvent(event: unknown, selfId: string | undefined): boolean {
  if (!selfId || typeof event !== "object" || event === null) return false;
  const candidate = event as { type?: unknown; playerId?: unknown };
  return candidate.type === "reconnected" && candidate.playerId === selfId;
}
