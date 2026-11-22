import { createCall } from "./call.js";
import { createSync } from "./sync.js";

const $ = selector => document.querySelector(selector);

const peerId = crypto.randomUUID();
const DEFAULT_SERVER = "ws://127.0.0.1:3001";

let serverUrl = safeGet("telebeeServerUrl") || DEFAULT_SERVER;
let displayName = safeGet("telebeeName") || "";
let socket = null;
let roomCode = "";
let hostId = null;
let partner = null; // { id, name, mic, camera }
let callState = "idle";
let manualClose = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
let unread = 0;
let localStream = null;
let micDeviceId = "";
let cameraDeviceId = "";

const els = {
  roomInput: $("#roomCode"),
  nameInput: $("#displayName"),
  serverInput: $("#serverUrl"),
  status: $("#status"),
  conn: $("#conn"),
  messages: $("#messages"),
  remoteVideo: $("#remoteVideo"),
  localVideo: $("#localVideo"),
  micBtn: $("#micBtn"),
  cameraBtn: $("#cameraBtn"),
  chatToggle: $("#chatToggle")
};

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function randomRoom() {
  return Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, "X");
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

const isHost = () => hostId === peerId;

const call = createCall({
  send,
  onRemoteStream: stream => {
    els.remoteVideo.srcObject = stream;
    if (stream) els.remoteVideo.play().catch(() => {});
    renderStage();
  },
  onState: state => {
    callState = state;
    renderStatus();
    renderStage();
  }
});

const sync = createSync({
  send,
  isHost,
  onStatus: renderSyncStatus
});

/* ---------- Rendering ---------- */

function setView(view) {
  document.body.dataset.view = view;
  $("#joinView").hidden = view !== "join";
  $("#roomView").hidden = view !== "room";
}

function setConn(state, text) {
  els.conn.dataset.state = state;
  els.status.textContent = text;
}

function renderStatus() {
  if (!socket || manualClose) return setConn("idle", "Not connected");
  if (socket.readyState !== WebSocket.OPEN) return setConn("connecting", "Connecting…");
  if (!partner) return setConn("ok", "Waiting for partner");
  if (callState === "connected") return setConn("ok", `With ${partner.name}`);
  if (callState === "failed") return setConn("error", "Call failed, retrying…");
  return setConn("connecting", "Connecting call…");
}

function renderRole() {
  const badge = $("#roleBadge");
  badge.hidden = !partner && !isHost();
  badge.textContent = isHost() ? "Host" : "Following";
  badge.title = isHost()
    ? "Your play, pause and seek keep the room in sync"
    : "You follow your partner's playback";
}

function renderStage() {
  const hasVideo = Boolean(els.remoteVideo.srcObject?.getVideoTracks().length);
  const showVideo = Boolean(partner) && hasVideo && callState === "connected" && partner.camera !== false;
  els.remoteVideo.style.visibility = showVideo ? "visible" : "hidden";
  $("#remoteEmpty").hidden = showVideo;
  $("#remoteName").hidden = !partner;
  $("#remoteName").textContent = partner?.name || "";
  $("#remoteMuted").hidden = !(partner && partner.mic === false);
  $("#remoteAvatar").textContent = (partner?.name || "?").charAt(0).toUpperCase();

  let text = `Waiting for someone to join…\nShare code ${roomCode}`;
  if (partner) {
    if (callState === "connected") text = `${partner.name}'s camera is off`;
    else if (callState === "failed") text = "Connection failed. Retrying…";
    else text = `Connecting to ${partner.name}…`;
  }
  const remoteText = $("#remoteText");
  remoteText.textContent = text;
  remoteText.style.whiteSpace = "pre-line";
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = value => String(value).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function renderSyncStatus(state) {
  const line = $(".syncline");
  if (!state?.found) {
    $("#syncText").textContent = "No video detected on this page";
    line.classList.remove("active");
    return;
  }
  $("#syncText").textContent = `${state.paused ? "Paused" : "Playing"} · ${formatTime(state.time)}`;
  line.classList.toggle("active", Boolean(partner));
}

function addSystem(text) {
  const item = document.createElement("div");
  item.className = "msg system";
  item.textContent = text;
  els.messages.append(item);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addChat(name, text, ts, mine) {
  const item = document.createElement("div");
  item.className = mine ? "msg mine" : "msg";
  const meta = document.createElement("span");
  meta.className = "meta";
  const time = new Date(ts || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  meta.textContent = mine ? time : `${name} · ${time}`;
  item.append(meta, document.createTextNode(text));
  els.messages.append(item);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setUnread(count) {
  unread = count;
  const badge = $("#unread");
  badge.hidden = count === 0;
  badge.textContent = count > 9 ? "9+" : String(count);
}

function showJoinError(text) {
  const error = $("#joinError");
  error.textContent = text;
  error.hidden = !text;
}

/* ---------- Camera and microphone ---------- */

function updateMediaButtons() {
  const mic = localStream?.getAudioTracks()[0];
  const camera = localStream?.getVideoTracks()[0];
  for (const [button, track] of [[els.micBtn, mic], [els.cameraBtn, camera]]) {
    const on = Boolean(track?.enabled);
    button.setAttribute("aria-pressed", String(on));
    button.classList.toggle("muted-off", Boolean(track) && !on);
    button.classList.remove("denied");
  }
  const cameraOn = Boolean(camera?.enabled);
  $("#self").classList.toggle("live", cameraOn);
}

function sendMediaState() {
  if (!partner) return;
  send({
    type: "media-state",
    mic: Boolean(localStream?.getAudioTracks()[0]?.enabled),
    camera: Boolean(localStream?.getVideoTracks()[0]?.enabled)
  });
}

function publishLocalTracks() {
  call.setLocalTrack("audio", localStream?.getAudioTracks()[0] || null);
  call.setLocalTrack("video", localStream?.getVideoTracks()[0] || null);
}

async function enableMedia() {
  if (localStream) return true;
  if (!navigator.mediaDevices?.getUserMedia) {
    addSystem("Camera and microphone are not available in this browser context.");
    return false;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (error) {
    // Fall back to audio only if the camera is missing or busy.
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      addSystem("Camera unavailable. Joined with microphone only.");
    } catch {
      const denied = error.name === "NotAllowedError";
      addSystem(denied
        ? "Camera and microphone permission was denied. You can still watch and chat."
        : error.message);
      for (const button of [els.micBtn, els.cameraBtn]) button.classList.add("denied");
      return false;
    }
  }
  els.localVideo.srcObject = localStream;
  publishLocalTracks();
  updateMediaButtons();
  sendMediaState();
  await refreshDevices();
  return true;
}

function stopMedia() {
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null;
  els.localVideo.srcObject = null;
  updateMediaButtons();
}

async function toggleTrack(kind) {
  if (!localStream) {
    await enableMedia();
    return;
  }
  const track = kind === "audio"
    ? localStream.getAudioTracks()[0]
    : localStream.getVideoTracks()[0];
  if (!track) {
    await replaceMediaTrack(kind, "");
    return;
  }
  track.enabled = !track.enabled;
  updateMediaButtons();
  sendMediaState();
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (select, kind, fallbackLabel, emptyLabel, selected) => {
    select.innerHTML = "";
    for (const device of devices.filter(item => item.kind === kind)) {
      select.add(new Option(device.label || fallbackLabel, device.deviceId));
    }
    if (!select.options.length) select.add(new Option(emptyLabel, ""));
    const active = localStream?.getTracks().find(t => t.kind === (kind === "audioinput" ? "audio" : "video"));
    const activeId = active?.getSettings().deviceId;
    select.value = selected || activeId || select.options[0].value;
  };
  fill($("#micSelect"), "audioinput", "Microphone", "No microphone found", micDeviceId);
  fill($("#cameraSelect"), "videoinput", "Camera", "No camera found", cameraDeviceId);
}

async function replaceMediaTrack(kind, deviceId) {
  const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const constraints = kind === "audio"
    ? {
        audio: {
          ...(deviceId && { deviceId: { exact: deviceId } }),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      }
    : { video: { ...base, ...(deviceId && { deviceId: { exact: deviceId } }) } };

  try {
    const replacement = await navigator.mediaDevices.getUserMedia(constraints);
    const newTrack = kind === "audio"
      ? replacement.getAudioTracks()[0]
      : replacement.getVideoTracks()[0];
    if (!newTrack) return;

    if (!localStream) localStream = new MediaStream();
    const oldTrack = kind === "audio"
      ? localStream.getAudioTracks()[0]
      : localStream.getVideoTracks()[0];
    if (oldTrack) {
      newTrack.enabled = oldTrack.enabled;
      oldTrack.stop();
      localStream.removeTrack(oldTrack);
    }
    localStream.addTrack(newTrack);
    els.localVideo.srcObject = localStream;
    call.setLocalTrack(kind, newTrack);

    if (kind === "audio") micDeviceId = deviceId;
    else cameraDeviceId = deviceId;
    updateMediaButtons();
    sendMediaState();
    await refreshDevices();
  } catch (error) {
    addSystem(`Could not switch ${kind === "audio" ? "microphone" : "camera"}: ${error.message}`);
  }
}

/* ---------- Room connection ---------- */

function connectRoom() {
  roomCode = els.roomInput.value.trim().toUpperCase();
  if (!roomCode) return showJoinError("Enter a room code or press New.");

  const url = els.serverInput.value.trim().replace(/\/$/, "");
  if (!/^wss?:\/\//i.test(url)) {
    showJoinError("Server URL must start with ws:// or wss:// (see Settings).");
    return;
  }
  serverUrl = url;
  displayName = els.nameInput.value.trim();
  safeSet("telebeeServerUrl", serverUrl);
  safeSet("telebeeName", displayName);
  showJoinError("");

  manualClose = false;
  openSocket();
}

function openSocket() {
  clearTimeout(reconnectTimer);
  if (socket) {
    const old = socket;
    socket = null;
    old.close();
  }
  const ws = new WebSocket(serverUrl);
  socket = ws;
  setConn("connecting", "Connecting…");

  ws.onopen = async () => {
    if (ws !== socket) return;
    reconnectDelay = 1000;
    const [tab, playback] = await Promise.all([sync.getActiveTab(), sync.getPlayback()]);
    send({
      type: "join",
      room: roomCode,
      peerId,
      name: displayName || "Guest",
      url: tab?.url && /^https?:/i.test(tab.url) ? tab.url : "",
      playback: playback.found ? { ...playback, kind: "event" } : null
    });
  };

  ws.onmessage = async event => {
    if (ws !== socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    try { await handleMessage(message); } catch (error) { console.error(error); }
  };

  ws.onclose = () => {
    if (ws !== socket) return;
    callState = "idle";
    if (manualClose) return;
    setConn("connecting", "Reconnecting…");
    reconnectTimer = setTimeout(openSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  };

  ws.onerror = () => {
    if (ws !== socket) return;
    if (!$("#joinView").hidden) showJoinError("Could not reach the server. Check the Server URL in Settings.");
  };
}

async function handleMessage(message) {
  switch (message.type) {
    case "room-joined": {
      hostId = message.hostId;
      partner = message.peers[0]
        ? { ...message.peers[0], mic: true, camera: true }
        : null;
      call.setIceServers(message.iceServers);
      $("#roomLabel").textContent = roomCode;
      setView("room");
      renderRole();
      renderStatus();
      renderStage();
      sync.start();
      addSystem(partner ? `Joined room ${roomCode} with ${partner.name}` : `Joined room ${roomCode}`);
      void enableMedia();
      if (partner) {
        call.start(partner.id, { initiator: false });
        sendMediaState();
        await sync.applyRoomState(message.state);
      }
      break;
    }
    case "peer-joined": {
      partner = { id: message.peerId, name: message.name, mic: true, camera: true };
      callState = "connecting";
      addSystem(`${partner.name} joined`);
      call.start(partner.id, { initiator: true });
      sendMediaState();
      renderRole();
      renderStatus();
      renderStage();
      break;
    }
    case "peer-left": {
      if (partner?.id !== message.peerId) break;
      addSystem(`${partner.name} left`);
      partner = null;
      hostId = message.hostId;
      callState = "idle";
      call.stop();
      renderRole();
      renderStatus();
      renderStage();
      break;
    }
    case "host-changed":
      hostId = message.hostId;
      renderRole();
      break;
    case "signal":
      await call.handleSignal(message.from, message.signal);
      break;
    case "chat":
      addChat(message.name || partner?.name || "Guest", message.text, message.ts, false);
      if (document.body.classList.contains("chat-hidden")) setUnread(unread + 1);
      break;
    case "playback":
      await sync.applyRemote(message.state, message.state?.kind);
      break;
    case "navigate":
      await sync.openUrl(message.url);
      break;
    case "media-state":
      if (partner?.id === message.from) {
        partner.mic = message.mic;
        partner.camera = message.camera;
        renderStage();
      }
      break;
    case "room-full":
      manualClose = true;
      socket?.close();
      showJoinError("That room already has two people.");
      setConn("error", "Room full");
      break;
    default:
      break;
  }
}

function leaveRoom() {
  manualClose = true;
  clearTimeout(reconnectTimer);
  const ws = socket;
  socket = null;
  ws?.close();
  call.stop();
  sync.stop();
  stopMedia();
  partner = null;
  hostId = null;
  callState = "idle";
  els.messages.innerHTML = "";
  setUnread(0);
  document.body.classList.remove("chat-hidden");
  els.chatToggle.setAttribute("aria-pressed", "true");
  setView("join");
  setConn("idle", "Not connected");
}

/* ---------- Wiring ---------- */

els.roomInput.value = randomRoom();
els.nameInput.value = displayName;
els.serverInput.value = serverUrl;

$("#joinBtn").addEventListener("click", connectRoom);
$("#genBtn").addEventListener("click", () => { els.roomInput.value = randomRoom(); });
$("#leaveBtn").addEventListener("click", leaveRoom);
els.micBtn.addEventListener("click", () => toggleTrack("audio"));
els.cameraBtn.addEventListener("click", () => toggleTrack("video"));
$("#micSelect").addEventListener("change", event => {
  if (event.target.value) void replaceMediaTrack("audio", event.target.value);
});
$("#cameraSelect").addEventListener("change", event => {
  if (event.target.value) void replaceMediaTrack("video", event.target.value);
});

els.chatToggle.addEventListener("click", () => {
  const hidden = document.body.classList.toggle("chat-hidden");
  els.chatToggle.setAttribute("aria-pressed", String(!hidden));
  if (!hidden) {
    setUnread(0);
    els.messages.scrollTop = els.messages.scrollHeight;
    $("#chatInput").focus();
  }
});

$("#settingsToggle").addEventListener("click", event => {
  const panel = $("#settingsPanel");
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) void refreshDevices();
});

$("#copyBtn").addEventListener("click", async event => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(roomCode);
    button.textContent = "Copied!";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => { button.textContent = "Copy code"; }, 1500);
});

$("#syncBtn").addEventListener("click", async () => {
  hostId = peerId;
  send({ type: "take-control" });
  renderRole();
  const state = await sync.pushNow();
  renderSyncStatus(state);
});

els.roomInput.addEventListener("input", event => {
  els.roomInput.value = els.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (event.inputType === "insertFromPaste" && els.roomInput.value.length === 6) connectRoom();
});
els.roomInput.addEventListener("keydown", event => {
  if (event.key === "Enter") connectRoom();
});
els.nameInput.addEventListener("keydown", event => {
  if (event.key === "Enter") connectRoom();
});

$("#chatForm").addEventListener("submit", event => {
  event.preventDefault();
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  if (send({ type: "chat", text })) {
    addChat(displayName || "You", text, Date.now(), true);
    input.value = "";
  } else {
    addSystem("Not connected. Message not sent.");
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "PLAYBACK_ERROR") addSystem(`Playback: ${message.error}`);
  if (message.type === "PLAYBACK_STATE") sync.handleLocalPlayback(message.state);
});

navigator.mediaDevices?.addEventListener("devicechange", () => void refreshDevices());

setView("join");
updateMediaButtons();
