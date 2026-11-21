let serverUrl = localStorage.getItem("telebeeServerUrl") || "ws://127.0.0.1:3001";
const peerId = crypto.randomUUID();
const peerConnections = new Map();
let socket = null;
let localStream = null;
let roomCode = "";
let applyingPlayback = false;
let lastSharedUrl = "";

const roomInput = document.querySelector("#roomCode");
const serverInput = document.querySelector("#serverUrl");
const statusEl = document.querySelector("#status");
const messagesEl = document.querySelector("#messages");
const videosEl = document.querySelector("#videos");

function randomRoom() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

if (!roomInput.value) roomInput.value = randomRoom();
serverInput.value = serverUrl;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function openOrSyncUrl(url) {
  if (!url) return;
  const tab = await getActiveTab();
  if (!tab?.id) return;
  if (tab.url !== url) await chrome.tabs.update(tab.id, { url });
  lastSharedUrl = url;
}

async function getPlayback() {
  const tab = await getActiveTab();
  if (!tab?.id) return { found: false };
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "GET_PLAYBACK" });
  } catch {
    return { found: false };
  }
}

async function setPlayback(state) {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "SET_PLAYBACK", ...state });
  } catch {}
}

function addMessage(text, author = "System") {
  const item = document.createElement("div");
  item.className = "message";
  const label = document.createElement("strong");
  label.textContent = `${author}: `;
  item.append(label, document.createTextNode(text));
  messagesEl.append(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addVideo(id, stream) {
  let tile = document.querySelector(`[data-peer="${CSS.escape(id)}"]`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "videoTile";
    tile.dataset.peer = id;
    tile.innerHTML = "<video autoplay playsinline></video><span></span>";
    videosEl.append(tile);
  }
  const video = tile.querySelector("video");
  video.srcObject = stream;
  video.muted = id === peerId;
  tile.querySelector("span").textContent = id === peerId ? "You" : "Guest";
}

async function enableMedia() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 } },
      audio: true
    });
    addVideo(peerId, localStream);
    for (const pc of peerConnections.values()) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }
    document.querySelector("#mediaBtn").textContent = "Mic/Camera on";
  } catch (error) {
    addMessage(error.message, "Media");
  }
}

function createPeer(remoteId) {
  if (peerConnections.has(remoteId)) return peerConnections.get(remoteId);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  peerConnections.set(remoteId, pc);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.send(JSON.stringify({
      type: "signal", to: remoteId, signal: { candidate: candidate.toJSON() }
    }));
  };

  pc.ontrack = ({ streams }) => addVideo(remoteId, streams[0]);
  if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      peerConnections.delete(remoteId);
      document.querySelector(`[data-peer="${CSS.escape(remoteId)}"]`)?.remove();
    }
  };
  return pc;
}

async function createOffer(remoteId) {
  const pc = createPeer(remoteId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.send(JSON.stringify({
    type: "signal", to: remoteId, signal: { description: pc.localDescription }
  }));
}

async function handleSignal(message) {
  const pc = createPeer(message.from);
  const signal = message.signal;

  if (signal.description) {
    await pc.setRemoteDescription(signal.description);
    if (signal.description.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.send(JSON.stringify({
        type: "signal", to: message.from, signal: { description: pc.localDescription }
      }));
    }
  } else if (signal.candidate) {
    try { await pc.addIceCandidate(signal.candidate); } catch {}
  }
}

function connectRoom() {
  roomCode = roomInput.value.trim().toUpperCase();
  if (!roomCode) return;
  serverUrl = serverInput.value.trim().replace(/\/$/, "");
  if (!/^wss?:\/\//i.test(serverUrl)) {
    statusEl.textContent = "Server URL must start with ws:// or wss://";
    return;
  }
  localStorage.setItem("telebeeServerUrl", serverUrl);

  if (socket) socket.close();
  socket = new WebSocket(serverUrl);
  statusEl.textContent = "Connecting...";

  socket.onopen = async () => {
    const tab = await getActiveTab();
    socket.send(JSON.stringify({
      type: "join",
      room: roomCode,
      peerId,
      url: tab?.url || ""
    }));
  };

  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "room-joined") {
      statusEl.textContent = `In room ${roomCode}`;
      addMessage(`Joined room ${roomCode}`);
      for (const remoteId of message.peers) await createOffer(remoteId);
      if (message.state?.url) {
        await openOrSyncUrl(message.state.url);
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      if (message.state?.playback) {
        applyingPlayback = true;
        await setPlayback({
          action: message.state.playback.paused ? "pause" : "play",
          time: message.state.playback.time,
          rate: message.state.playback.rate
        });
        setTimeout(() => { applyingPlayback = false; }, 1500);
      }
      const playback = await getPlayback();
      if (playback.found && !message.state?.playback) {
        socket.send(JSON.stringify({ type: "playback", state: playback }));
      }
    } else if (message.type === "peer-joined") {
      addMessage("Someone joined");
    } else if (message.type === "room-state" || message.type === "navigate") {
      const state = message.state || message;
      if (state.url) {
        await openOrSyncUrl(state.url);
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      if (state.playback) {
        applyingPlayback = true;
        await setPlayback({
          action: state.playback.paused ? "pause" : "play",
          time: state.playback.time,
          rate: state.playback.rate
        });
        setTimeout(() => { applyingPlayback = false; }, 1500);
      }
    } else if (message.type === "peer-left") {
      peerConnections.get(message.peerId)?.close();
      peerConnections.delete(message.peerId);
      document.querySelector(`[data-peer="${CSS.escape(message.peerId)}"]`)?.remove();
    } else if (message.type === "signal") {
      await handleSignal(message);
    } else if (message.type === "chat") {
      addMessage(message.text, "Guest");
    } else if (message.type === "playback") {
      applyingPlayback = true;
      await setPlayback({
        action: message.state.paused ? "pause" : "play",
        time: message.state.time,
        rate: message.state.rate
      });
      setTimeout(() => { applyingPlayback = false; }, 1500);
    }
  };

  socket.onclose = () => {
    statusEl.textContent = "Disconnected";
  };
  socket.onerror = () => {
    statusEl.textContent = "Server unavailable";
  };
}

document.querySelector("#joinBtn").addEventListener("click", connectRoom);
document.querySelector("#mediaBtn").addEventListener("click", enableMedia);

roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (roomInput.value.length >= 6 && (!socket || socket.readyState === WebSocket.CLOSED)) {
    connectRoom();
  }
});

roomInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") connectRoom();
});

document.querySelector("#chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  addMessage(text, "You");
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "chat", text }));
  }
  input.value = "";
});

document.querySelector("#syncBtn").addEventListener("click", async () => {
  const state = await getPlayback();
  const tab = await getActiveTab();
  if (tab?.url) {
    lastSharedUrl = tab.url;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "navigate", url: tab.url }));
    }
  }
  if (!state.found) {
    document.querySelector("#syncText").textContent = "No video detected";
    return;
  }
  document.querySelector("#syncText").textContent = `${state.paused ? "Paused" : "Playing"} at ${Math.round(state.time)}s`;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "playback", state }));
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "PLAYBACK_STATE" || applyingPlayback || !socket) return;
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "playback", state: message.state }));
  }
});

setInterval(async () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const tab = await getActiveTab();
  if (!tab?.url || tab.url === lastSharedUrl) return;
  if (!tab.url.startsWith("http://") && !tab.url.startsWith("https://")) return;
  lastSharedUrl = tab.url;
  socket.send(JSON.stringify({ type: "navigate", url: tab.url }));
}, 1500);
