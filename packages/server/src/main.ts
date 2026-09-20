import { defineRoom, defineServer, matchMaker } from "colyseus";
import type { Request, Response } from "express";
import { CaboRoom } from "./CaboRoom.js";

const port = Number.parseInt(process.env.PORT ?? "2567", 10);

export const server = defineServer({
  rooms: {
    cabo: defineRoom(CaboRoom),
  },
  express: (app) => {
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
