import { describe, expect, it, vi } from "vitest";
import { copyText, invitationLink, readInvitation } from "./invitation.js";

describe("invitations", () => {
  it("round-trips case-sensitive room IDs and a custom server without applying it", () => {
    const previous = localStorage.getItem("cabo.server.v1");
    const link = invitationLink("aB_9", "https://example.com/game", "https://play.example.com");
    expect(readInvitation(link)).toEqual({ roomId: "aB_9", server: "https://example.com/game" });
    expect(localStorage.getItem("cabo.server.v1")).toBe(previous);
  });
  it("rejects unsafe server protocols", () => {
    expect(readInvitation("http://localhost/?room=abc&server=javascript:alert(1)")?.error).toBeTruthy();
  });
  it("reports clipboard failure for a manual fallback", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    expect(await copyText("abc")).toBe(false);
    vi.mocked(navigator.clipboard.writeText).mockResolvedValue(undefined);
    expect(await copyText("abc")).toBe(true);
  });
});
