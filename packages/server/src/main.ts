import { defineRoom, defineServer, matchMaker } from "colyseus";
import type { Request, Response } from "express";
import { CaboRoom } from "./CaboRoom.js";

const port = Number.parseInt(process.env.PORT ?? "2567", 10);
const allowedOrigins = (process.env.WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function corsOrigin(origin: string | null | undefined): string {
  if (!origin) return "*";
  if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) return origin;
  return "null";
}

matchMaker.controller.getCorsHeaders = (headers) => ({
  "Access-Control-Allow-Origin": corsOrigin(headers.get("origin")),
  Vary: "Origin",
});

export const server = defineServer({
  rooms: {
    cabo: defineRoom(CaboRoom),
  },
  express: (app) => {
    app.use((request, response, next) => {
      response.setHeader("Access-Control-Allow-Origin", corsOrigin(request.headers.origin));
      response.setHeader("Vary", "Origin");
      next();
    });
    app.get("/healthz", (_request: Request, response: Response) => {
      response.status(200).json({ ok: true });
    });
    app.get("/rooms", async (_request: Request, response: Response) => {
      const rooms = await matchMaker.query({ name: "cabo" });
      response.json(
        rooms
          .filter((room) => room.metadata?.visibility === "public" && room.metadata?.phase === "LOBBY" && !room.locked)
          .map((room) => ({ roomId: room.roomId, ...room.metadata })),
      );
    });
  },
});

await server.listen(port);
console.log(`Cabo server listening on http://localhost:${port}`);
