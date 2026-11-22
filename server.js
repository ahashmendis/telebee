import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const MAX_PEERS = Number(process.env.TELEBEE_MAX_PEERS || 2);
const MAX_PAYLOAD = 64 * 1024;
const PING_INTERVAL_MS = 30_000;
const EMPTY_ROOM_GRACE_MS = 60_000;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

// code -> { peers: Map<peerId, socket>, hostId, state: { url?, playback? }, cleanup }
const rooms = new Map();

app.get("/health", (_request, response) => {
  response.json({ ok: true, rooms: rooms.size });
});

function iceServers() {
  const servers = [{ urls: "stun:stun.l.google.com:19302" }];
  const urls = (process.env.TURN_URLS || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  if (urls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  return servers;
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room, message, except = null) {
  for (const peer of room.peers.values()) {
    if (peer !== except) send(peer, message);
  }
}

function isHttpUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function cleanPlayback(state) {
  if (!state || typeof state !== "object" || state.found === false) return null;
  const time = Number(state.time);
  const rate = Number(state.rate);
  if (!Number.isFinite(time)) return null;
  return {
    found: true,
    paused: Boolean(state.paused),
    time: Math.max(0, time),
    rate: Number.isFinite(rate) ? Math.min(4, Math.max(0.25, rate)) : 1,
    kind: state.kind === "heartbeat" ? "heartbeat" : "event"
  };
}

function cleanName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 24);
  return name || "Guest";
}

function pickHost(room, preferred = null) {
  if (preferred && room.peers.has(preferred)) return preferred;
  return room.peers.keys().next().value ?? null;
}

function scheduleCleanup(code, room) {
  clearTimeout(room.cleanup);
  room.cleanup = setTimeout(() => {
    if (room.peers.size === 0) rooms.delete(code);
  }, EMPTY_ROOM_GRACE_MS);
  room.cleanup.unref?.();
}

function handleJoin(socket, message) {
  if (socket.room) return;
  const code = String(message.room || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  const peerId = typeof message.peerId === "string" ? message.peerId.slice(0, 64) : "";
  if (!code || !peerId) return;

  let room = rooms.get(code);
  if (!room) {
    room = { peers: new Map(), hostId: null, state: {}, cleanup: null };
    rooms.set(code, room);
  }

  const previous = room.peers.get(peerId);
  if (!previous && room.peers.size >= MAX_PEERS) {
    send(socket, { type: "room-full" });
    socket.close(1000, "room-full");
    return;
  }

  // The same client reconnecting: retire its old socket without announcing a departure.
  if (previous) {
    previous.replaced = true;
    previous.room = null;
    room.peers.delete(peerId);
    previous.close(1000, "replaced");
  }

  clearTimeout(room.cleanup);
  socket.room = code;
  socket.peerId = peerId;
  socket.name = cleanName(message.name);

  const others = [...room.peers.values()].map(peer => ({ id: peer.peerId, name: peer.name }));
  room.peers.set(peerId, socket);
  room.hostId = pickHost(room, room.hostId);

  if (isHttpUrl(message.url) && !room.state.url) room.state.url = message.url;
  const playback = cleanPlayback(message.playback);
  if (playback && !room.state.playback) room.state.playback = playback;

  send(socket, {
    type: "room-joined",
    peerId,
    peers: others,
    hostId: room.hostId,
    state: room.state,
    iceServers: iceServers()
  });
  broadcast(room, { type: "peer-joined", peerId, name: socket.name }, socket);
}

function handleMessage(socket, message) {
  if (message.type === "join") return handleJoin(socket, message);

  const room = socket.room ? rooms.get(socket.room) : null;
  if (!room) return;
  const from = socket.peerId;

  switch (message.type) {
    case "signal": {
      const target = room.peers.get(message.to);
      if (target && message.signal && typeof message.signal === "object") {
        send(target, { type: "signal", from, signal: message.signal });
      }
      break;
    }
    case "chat": {
      const text = String(message.text || "").trim().slice(0, 2000);
      if (!text) break;
      broadcast(room, { type: "chat", from, name: socket.name, text, ts: Date.now() }, socket);
      break;
    }
    case "playback": {
      const state = cleanPlayback(message.state);
      if (!state) break;
      room.state.playback = state;
      broadcast(room, { type: "playback", from, state }, socket);
      break;
    }
    case "navigate": {
      if (!isHttpUrl(message.url)) break;
      room.state.url = message.url;
      room.state.playback = null;
      broadcast(room, { type: "navigate", from, url: message.url }, socket);
      break;
    }
    case "media-state": {
      broadcast(room, {
        type: "media-state",
        from,
        mic: Boolean(message.mic),
        camera: Boolean(message.camera)
      }, socket);
      break;
    }
    case "take-control": {
      room.hostId = from;
      broadcast(room, { type: "host-changed", hostId: from });
      break;
    }
    default:
      break;
  }
}

wss.on("connection", (socket) => {
  socket.room = null;
  socket.peerId = null;
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message && typeof message === "object") handleMessage(socket, message);
  });

  socket.on("close", () => {
    if (socket.replaced || !socket.room) return;
    const code = socket.room;
    const room = rooms.get(code);
    if (!room || room.peers.get(socket.peerId) !== socket) return;

    room.peers.delete(socket.peerId);
    if (room.hostId === socket.peerId) room.hostId = pickHost(room);
    broadcast(room, { type: "peer-left", peerId: socket.peerId, hostId: room.hostId });
    if (room.peers.size === 0) scheduleCleanup(code, room);
  });

  socket.on("error", () => {});
});

const pingTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, PING_INTERVAL_MS);
pingTimer.unref();

const port = Number(process.env.PORT || 3001);
server.listen(port, "0.0.0.0", () => {
  console.log(`Telebee signaling server listening on 0.0.0.0:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(pingTimer);
    for (const socket of wss.clients) socket.close(1001, "server-shutdown");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
