import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();
const roomStates = new Map();

app.get("/health", (_request, response) => {
  response.json({ ok: true, rooms: rooms.size });
});

function roomFor(code) {
  if (!rooms.has(code)) rooms.set(code, new Map());
  return rooms.get(code);
}

wss.on("connection", (socket) => {
  socket.room = null;
  socket.peerId = null;

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "join") {
      const code = String(message.room || "").trim().toUpperCase().slice(0, 12);
      if (!code) return;
      socket.room = code;
      socket.peerId = message.peerId;
      const room = roomFor(code);
      const peers = [...room.keys()];
      room.set(socket.peerId, socket);

      if (message.url) {
        const previous = roomStates.get(code);
        if (!previous?.url) {
          roomStates.set(code, {
            ...(previous || {}),
            url: message.url
          });
        }
      }
      if (message.playback) {
        roomStates.set(code, {
          ...(roomStates.get(code) || {}),
          playback: message.playback
        });
      }

      socket.send(JSON.stringify({
        type: "room-joined",
        peerId: socket.peerId,
        peers,
        state: roomStates.get(code) || null
      }));

      for (const peer of room.values()) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({
            type: "peer-joined",
            peerId: socket.peerId
          }));
          if (message.url) {
            peer.send(JSON.stringify({
              type: "room-state",
              state: roomStates.get(code)
            }));
          }
        }
      }
      return;
    }

    if (!socket.room) return;
    const room = roomFor(socket.room);

    if (message.type === "signal" && message.to) {
      const target = room.get(message.to);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({
          ...message,
          from: socket.peerId
        }));
      }
      return;
    }

    if (["chat", "playback", "navigate", "room-state"].includes(message.type)) {
      if (message.type === "playback") {
        roomStates.set(socket.room, {
          ...(roomStates.get(socket.room) || {}),
          playback: message.state
        });
      }
      if (message.type === "navigate" && message.url) {
        roomStates.set(socket.room, {
          ...(roomStates.get(socket.room) || {}),
          url: message.url
        });
      }
      for (const peer of room.values()) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({
            ...message,
            from: socket.peerId
          }));
        }
      }
    }
  });

  socket.on("close", () => {
    if (!socket.room) return;
    const room = roomFor(socket.room);
    room.delete(socket.peerId);
    for (const peer of room.values()) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({
          type: "peer-left",
          peerId: socket.peerId
        }));
      }
    }
    if (room.size === 0) {
      rooms.delete(socket.room);
      roomStates.delete(socket.room);
    }
  });
});

const port = Number(process.env.PORT || 3001);
server.listen(port, "0.0.0.0", () => {
  console.log(`Telebee signaling server listening on 0.0.0.0:${port}`);
});
