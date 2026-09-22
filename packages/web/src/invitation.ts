import { validateServerUrl } from "./browser-session.js";

export function readInvitation(url = window.location.href): { roomId: string; server: string; error?: string } | undefined {
  const params = new URL(url).searchParams;
  const roomId = params.get("room");
  if (!roomId) return;
  try {
    const server = validateServerUrl(params.get("server") ?? "");
    return { roomId, server };
  } catch (error) { return { roomId, server: params.get("server") ?? "", error: error instanceof Error ? error.message : "Invalid invitation server." }; }
}

export function invitationLink(roomId: string, server: string, origin = window.location.origin): string {
  const url = new URL("/", origin);
  url.searchParams.set("room", roomId);
  url.searchParams.set("server", server);
  return url.href;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}
