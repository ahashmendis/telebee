let serverUrl = localStorage.getItem("telebeeServerUrl") || "ws://127.0.0.1:3001";
const peerId = crypto.randomUUID();
const peerConnections = new Map();
let socket = null;
let localStream = null;
let roomCode = "";
let applyingPlayback = false;
let lastSharedUrl = "";
let playbackApplyTimer = null;
let micDeviceId = "";
let cameraDeviceId = "";

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
  if (tab.url !== url) {
    await chrome.tabs.update(tab.id, { url });
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
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
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "SET_PLAYBACK", ...state });
      return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function applyRemotePlayback(playback) {
  if (!playback) return;
  applyingPlayback = true;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await setPlayback({
      action: playback.paused ? "pause" : "play",
      time: playback.time,
      rate: playback.rate
    });
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  playbackApplyTimer = setTimeout(() => {
    applyingPlayback = false;
  }, 1000);
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
      video: { width: { ideal: 640 }, height: { ideal: 360 } },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    addVideo(peerId, localStream);
    for (const pc of peerConnections.values()) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }
    updateMediaButtons();
    await refreshDevices();
  } catch (error) {
    const message = error.name === "NotAllowedError"
      ? "Camera and microphone permission was denied."
      : error.message;
    addMessage(message, "Media");
    document.querySelector("#micBtn").classList.add("denied");
    document.querySelector("#cameraBtn").classList.add("denied");
  }
}

async function ensureMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    addMessage("Camera and microphone are not supported in this browser context.", "Media");
    return false;
  }
  if (!localStream) await enableMedia();
  return Boolean(localStream);
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const micSelect = document.querySelector("#micSelect");
  const cameraSelect = document.querySelector("#cameraSelect");

  micSelect.innerHTML = "";
  cameraSelect.innerHTML = "";

  for (const device of devices.filter(item => item.kind === "audioinput")) {
    micSelect.add(new Option(device.label || "Microphone", device.deviceId));
  }
  for (const device of devices.filter(item => item.kind === "videoinput")) {
    cameraSelect.add(new Option(device.label || "Camera", device.deviceId));
  }

  if (!micSelect.options.length) micSelect.add(new Option("No microphone found", ""));
  if (!cameraSelect.options.length) cameraSelect.add(new Option("No camera found", ""));
  if (micDeviceId) micSelect.value = micDeviceId;
  if (cameraDeviceId) cameraSelect.value = cameraDeviceId;
}

async function replaceMediaTrack(kind, deviceId) {
  if (!await ensureMedia()) return;
  const constraints = kind === "audio"
    ? {
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      }
    : {
        audio: false,
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 640 },
          height: { ideal: 360 }
        }
      };

  try {
    const replacement = await navigator.mediaDevices.getUserMedia(constraints);
    const newTrack = kind === "audio"
      ? replacement.getAudioTracks()[0]
      : replacement.getVideoTracks()[0];
    if (!newTrack) return;

    const oldTrack = kind === "audio"
      ? localStream.getAudioTracks()[0]
      : localStream.getVideoTracks()[0];

    if (oldTrack) {
      oldTrack.stop();
      localStream.removeTrack(oldTrack);
    }
    localStream.addTrack(newTrack);

    for (const pc of peerConnections.values()) {
      const sender = pc.getSenders().find(item => item.track?.kind === kind);
      if (sender) await sender.replaceTrack(newTrack);
      else pc.addTrack(newTrack, localStream);
    }

    if (kind === "audio") micDeviceId = deviceId;
    else cameraDeviceId = deviceId;

    addVideo(peerId, localStream);
    updateMediaButtons();
    await refreshDevices();
    addMessage(`${kind === "audio" ? "Microphone" : "Camera"} changed`, "Media");
  } catch (error) {
    addMessage(error.message, "Media");
  }
}

function updateMediaButtons() {
  const mic = localStream?.getAudioTracks()[0];
  const camera = localStream?.getVideoTracks()[0];
  const micBtn = document.querySelector("#micBtn");
  const cameraBtn = document.querySelector("#cameraBtn");

  micBtn.textContent = mic?.enabled ? "Mic: on" : "Mic: off";
  micBtn.setAttribute("aria-pressed", String(Boolean(mic?.enabled)));
  micBtn.classList.toggle("active", Boolean(mic?.enabled));
  micBtn.classList.remove("denied");

  cameraBtn.textContent = camera?.enabled ? "Camera: on" : "Camera: off";
  cameraBtn.setAttribute("aria-pressed", String(Boolean(camera?.enabled)));
  cameraBtn.classList.toggle("active", Boolean(camera?.enabled));
  cameraBtn.classList.remove("denied");
}

async function toggleTrack(kind) {
  if (!await ensureMedia()) return;
  const track = kind === "audio"
    ? localStream.getAudioTracks()[0]
    : localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  updateMediaButtons();
  addMessage(
    `${kind === "audio" ? "Microphone" : "Camera"} ${track.enabled ? "on" : "off"}`,
    "Media"
  );
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
      void ensureMedia();
      for (const remoteId of message.peers) await createOffer(remoteId);
      if (message.state?.url) {
        await openOrSyncUrl(message.state.url);
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      if (message.state?.playback) {
        await applyRemotePlayback(message.state.playback);
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
        await applyRemotePlayback(state.playback);
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
      await applyRemotePlayback(message.state);
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
document.querySelector("#micBtn").addEventListener("click", () => toggleTrack("audio"));
document.querySelector("#cameraBtn").addEventListener("click", () => toggleTrack("video"));
document.querySelector("#micSelect").addEventListener("change", event => {
  if (event.target.value) void replaceMediaTrack("audio", event.target.value);
});
document.querySelector("#cameraSelect").addEventListener("change", event => {
  if (event.target.value) void replaceMediaTrack("video", event.target.value);
});
document.querySelector("#chatToggle").addEventListener("click", event => {
  const hidden = document.body.classList.toggle("chat-hidden");
  event.target.textContent = hidden ? "Chat: off" : "Chat: on";
  event.target.setAttribute("aria-pressed", String(!hidden));
});
document.querySelector("#settingsToggle").addEventListener("click", event => {
  const panel = document.querySelector("#settingsPanel");
  panel.hidden = !panel.hidden;
  event.target.setAttribute("aria-expanded", String(!panel.hidden));
  event.target.textContent = panel.hidden ? "Settings" : "Settings: open";
});

navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);

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
  if (message.type === "PLAYBACK_ERROR") {
    addMessage(`Playback error: ${message.error}`, "Media");
  }
  if (message.type === "PLAYBACK_STATE") {
    if (applyingPlayback || !socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "playback", state: message.state }));
    }
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
