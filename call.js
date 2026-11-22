// One-to-one WebRTC call.
//
// The peer who was already in the room (the "initiator") creates the offer; the
// peer who arrives later only answers. Both sides use fixed audio/video
// transceivers, so camera and microphone can be attached, swapped or removed at
// any time with replaceTrack() and never need renegotiation.

const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const MAX_RESTARTS = 5;

export function createCall({ send, onRemoteStream, onState }) {
  let pc = null;
  let remoteId = null;
  let initiator = false;
  let iceServers = DEFAULT_ICE;
  let remoteStream = null;
  let pendingCandidates = [];
  let restartTimer = null;
  let restarts = 0;
  const localTracks = { audio: null, video: null };

  function sendSignal(signal) {
    if (remoteId) send({ type: "signal", to: remoteId, signal });
  }

  function transceiverFor(kind) {
    return pc?.getTransceivers().find(item => item.receiver.track?.kind === kind);
  }

  async function attach(kind) {
    const transceiver = transceiverFor(kind);
    if (!transceiver) return;
    try {
      await transceiver.sender.replaceTrack(localTracks[kind]);
    } catch {}
  }

  async function attachAll() {
    for (const transceiver of pc?.getTransceivers() || []) {
      if (transceiver.direction !== "sendrecv") transceiver.direction = "sendrecv";
    }
    await Promise.all([attach("audio"), attach("video")]);
  }

  function scheduleRestart(delay) {
    clearTimeout(restartTimer);
    if (!pc || !initiator || restarts >= MAX_RESTARTS) return;
    const current = pc;
    restartTimer = setTimeout(() => {
      if (pc !== current) return;
      if (["connected", "completed"].includes(current.iceConnectionState)) return;
      restarts += 1;
      current.restartIce();
    }, delay);
  }

  function createConnection() {
    const connection = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });

    connection.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal({ candidate: candidate.toJSON() });
    };

    connection.ontrack = ({ track }) => {
      if (!remoteStream) remoteStream = new MediaStream();
      if (!remoteStream.getTracks().includes(track)) remoteStream.addTrack(track);
      onRemoteStream(remoteStream);
    };

    connection.onnegotiationneeded = async () => {
      if (!initiator || connection.signalingState !== "stable") return;
      try {
        await connection.setLocalDescription();
        if (pc === connection) sendSignal({ description: connection.localDescription });
      } catch {}
    };

    connection.onconnectionstatechange = () => {
      if (pc !== connection) return;
      onState(connection.connectionState);
      if (connection.connectionState === "connected") {
        restarts = 0;
        clearTimeout(restartTimer);
      } else if (connection.connectionState === "disconnected") {
        scheduleRestart(4000);
      } else if (connection.connectionState === "failed") {
        scheduleRestart(500);
      }
    };

    return connection;
  }

  function start(peerId, { initiator: isInitiator }) {
    stop();
    remoteId = peerId;
    initiator = isInitiator;
    pc = createConnection();
    onState("connecting");
    if (initiator) {
      pc.addTransceiver("audio", { direction: "sendrecv" });
      pc.addTransceiver("video", { direction: "sendrecv" });
      void attachAll();
    }
  }

  function stop() {
    clearTimeout(restartTimer);
    restarts = 0;
    pendingCandidates = [];
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onnegotiationneeded = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    pc = null;
    remoteId = null;
    if (remoteStream) {
      remoteStream = null;
      onRemoteStream(null);
    }
  }

  async function flushCandidates() {
    const queued = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch {}
    }
  }

  async function handleSignal(from, signal) {
    if (!signal) return;
    if (!pc) start(from, { initiator: false });
    if (from !== remoteId) return;
    const connection = pc;

    try {
      if (signal.description) {
        const description = signal.description;
        if (description.type === "offer") {
          if (initiator) return; // The initiator owns offers; ignore a colliding one.
          await connection.setRemoteDescription(description);
          await attachAll();
          await flushCandidates();
          await connection.setLocalDescription();
          if (pc === connection) sendSignal({ description: connection.localDescription });
        } else {
          await connection.setRemoteDescription(description);
          await flushCandidates();
        }
      } else if (signal.candidate) {
        if (connection.remoteDescription) {
          await connection.addIceCandidate(signal.candidate);
        } else {
          pendingCandidates.push(signal.candidate);
        }
      }
    } catch {}
  }

  function setLocalTrack(kind, track) {
    localTracks[kind] = track;
    void attach(kind);
  }

  return {
    start,
    stop,
    handleSignal,
    setLocalTrack,
    setIceServers(servers) {
      if (Array.isArray(servers) && servers.length) iceServers = servers;
    }
  };
}
