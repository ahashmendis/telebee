let lastVideo = null;
let ignoreLocalUpdatesUntil = 0;
let eventTimer = null;

const HEARTBEAT_MS = 5000;
const IGNORE_AFTER_APPLY_MS = 1500;

function findVideo() {
  const videos = [...document.querySelectorAll("video")].filter(video => {
    const rect = video.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  });
  const video = videos.find(item => item.readyState >= 2 && item.duration > 0) ||
    videos.find(item => item.readyState >= 2) ||
    videos.find(item => item.duration > 0) ||
    document.querySelector("video");
  if (video !== lastVideo) {
    lastVideo = video;
    attachPlaybackEvents(video);
  }
  return video;
}

function attachPlaybackEvents(video) {
  if (!video || video.dataset.telebeeAttached === "true") return;
  video.dataset.telebeeAttached = "true";
  ["play", "pause", "seeked", "ratechange", "ended"].forEach(eventName => {
    video.addEventListener(eventName, scheduleEventBroadcast, { passive: true });
  });
}

// Coalesce bursts (e.g. pause + seeked + play while scrubbing) into one message
// carrying the final state.
function scheduleEventBroadcast() {
  clearTimeout(eventTimer);
  eventTimer = setTimeout(() => broadcastPlayback("event"), 150);
}

function broadcastPlayback(kind) {
  if (Date.now() < ignoreLocalUpdatesUntil) return;
  const current = state();
  if (!current.found) return;
  if (kind === "heartbeat" && current.paused) return;
  chrome.runtime.sendMessage({
    type: "PLAYBACK_STATE",
    state: { ...current, kind }
  }).catch(() => {});
}

function state() {
  const video = findVideo();
  if (!video) return { found: false };
  return {
    found: true,
    paused: video.paused,
    time: video.currentTime,
    rate: video.playbackRate,
    readyState: video.readyState,
    error: video.error
      ? { code: video.error.code, message: video.error.message }
      : null
  };
}

function reportError(error) {
  chrome.runtime.sendMessage({ type: "PLAYBACK_ERROR", error }).catch(() => {});
}

function seekThreshold(message) {
  if (message.kind === "heartbeat") return 2.5;
  return message.action === "pause" ? 0.3 : 0.6;
}

function applyToVideo(video, message) {
  ignoreLocalUpdatesUntil = Date.now() + IGNORE_AFTER_APPLY_MS;

  if (typeof message.time === "number" && Number.isFinite(message.time)) {
    if (Math.abs(video.currentTime - message.time) > seekThreshold(message)) {
      const target = Math.max(0, message.time);
      try {
        if (video.readyState >= 1) {
          video.currentTime = target;
        } else {
          video.addEventListener("loadedmetadata", () => {
            video.currentTime = target;
          }, { once: true });
        }
      } catch (error) {
        reportError(`Seek failed: ${error.message}`);
      }
    }
  }

  if (typeof message.rate === "number" && Number.isFinite(message.rate) &&
      video.playbackRate !== message.rate) {
    video.playbackRate = message.rate;
  }

  if (message.action === "play" && video.paused) {
    video.muted = false;
    const playPromise = video.play();
    if (playPromise?.catch) {
      playPromise.catch(error => reportError(`Could not start video source: ${error.message}`));
    }
  }
  if (message.action === "pause" && !video.paused) video.pause();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Frames without a video stay silent so the frame that has one can answer.
  if (message.type === "GET_PLAYBACK") {
    const current = state();
    if (current.found) sendResponse(current);
    return;
  }

  if (message.type !== "SET_PLAYBACK") return;

  const video = findVideo();
  if (!video) {
    for (const frame of document.querySelectorAll("iframe")) {
      frame.contentWindow?.postMessage({ type: "TELEBEE_SET_PLAYBACK", payload: message }, "*");
    }
    return;
  }

  let responseSent = false;
  const respond = response => {
    if (responseSent) return;
    responseSent = true;
    sendResponse(response);
  };
  const apply = () => {
    applyToVideo(video, message);
    respond({ ok: true });
  };

  if (video.readyState === 0 || video.networkState === 3) {
    video.addEventListener("loadedmetadata", apply, { once: true });
    video.addEventListener("loadeddata", apply, { once: true });
    setTimeout(() => respond({ found: true, waiting: true }), 3000);
  } else {
    apply();
  }
  return true;
});

let scanTimer = null;
new MutationObserver(() => {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    findVideo();
  }, 500);
}).observe(document.documentElement, {
  childList: true,
  subtree: true
});

setInterval(() => broadcastPlayback("heartbeat"), HEARTBEAT_MS);

window.addEventListener("message", event => {
  if (event.data?.type !== "TELEBEE_SET_PLAYBACK") return;
  const video = findVideo();
  if (video) applyToVideo(video, event.data.payload);
});
