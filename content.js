let lastVideo = null;
let playbackTimer = null;
let ignoreLocalUpdatesUntil = 0;
let lastBroadcastState = null;

function findVideo() {
  const videos = [...document.querySelectorAll("video")].filter(video => {
    const rect = video.getBoundingClientRect();
    return video.readyState >= 0 && rect.width > 1 && rect.height > 1;
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
    video.addEventListener(eventName, broadcastPlayback, { passive: true });
  });
}

function broadcastPlayback() {
  if (Date.now() < ignoreLocalUpdatesUntil) return;
  const current = state();
  if (!current.found) return;
  if (lastBroadcastState &&
      lastBroadcastState.paused === current.paused &&
      Math.abs(lastBroadcastState.time - current.time) < (current.paused ? 1 : 4) &&
      lastBroadcastState.rate === current.rate) {
    return;
  }
  lastBroadcastState = current;
  chrome.runtime.sendMessage({
    type: "PLAYBACK_STATE",
    state: current
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_PLAYBACK") {
    sendResponse(state());
    return;
  }

  const video = findVideo();
  if (!video) {
    if (message.type === "SET_PLAYBACK") {
      for (const frame of document.querySelectorAll("iframe")) {
        frame.contentWindow?.postMessage({
          type: "TELEBEE_SET_PLAYBACK",
          payload: message
        }, "*");
      }
    }
    sendResponse({ found: false });
    return;
  }

  if (message.type === "SET_PLAYBACK") {
    ignoreLocalUpdatesUntil = Date.now() + 2500;
    let responseSent = false;
    const respond = response => {
      if (responseSent) return;
      responseSent = true;
      sendResponse(response);
    };
    const apply = () => {
      if (typeof message.time === "number" && Number.isFinite(message.time)) {
        const seekThreshold = message.action === "pause" ? 0.5 : 2.5;
        if (Math.abs(video.currentTime - message.time) > seekThreshold) {
          try {
            if (video.readyState >= 1) {
              video.currentTime = Math.max(0, message.time);
            } else {
              video.addEventListener("loadedmetadata", () => {
                video.currentTime = Math.max(0, message.time);
              }, { once: true });
            }
          } catch (error) {
            chrome.runtime.sendMessage({
              type: "PLAYBACK_ERROR",
              error: `Seek failed: ${error.message}`
            }).catch(() => {});
          }
        }
      }
      if (typeof message.rate === "number" && Number.isFinite(message.rate)) {
        video.playbackRate = message.rate;
      }
      if (message.action === "play" && video.paused) {
        video.muted = false;
        const playPromise = video.play();
        if (playPromise?.catch) {
          playPromise.catch(error => {
            chrome.runtime.sendMessage({
              type: "PLAYBACK_ERROR",
              error: `Could not start video source: ${error.message}`
            }).catch(() => {});
          });
        }
      }
      if (message.action === "pause" && !video.paused) video.pause();
      respond({ ok: true });
    };

    if (video.readyState === 0 || video.networkState === 3) {
      video.addEventListener("loadedmetadata", apply, { once: true });
      video.addEventListener("loadeddata", apply, { once: true });
      setTimeout(() => {
        if (!responseSent) respond({ found: true, waiting: true });
      }, 3000);
    } else {
      apply();
    }
    return true;
  }
});

const playbackObserver = new MutationObserver(() => {
  const video = findVideo();
  if (video) attachPlaybackEvents(video);
});
playbackObserver.observe(document.documentElement, {
  childList: true,
  subtree: true
});

playbackTimer = setInterval(broadcastPlayback, 5000);

window.addEventListener("message", event => {
  if (event.data?.type !== "TELEBEE_SET_PLAYBACK") return;
  const message = event.data.payload;
  const video = findVideo();
  if (!video) return;

  ignoreLocalUpdatesUntil = Date.now() + 2500;
  if (typeof message.time === "number" && video.readyState >= 1) {
    if (Math.abs(video.currentTime - message.time) > 0.75) {
      video.currentTime = Math.max(0, message.time);
    }
  }
  if (typeof message.rate === "number") video.playbackRate = message.rate;
  if (message.action === "play" && video.paused) {
    const playPromise = video.play();
    if (playPromise?.catch) {
      playPromise.catch(error => {
        chrome.runtime.sendMessage({
          type: "PLAYBACK_ERROR",
          error: `Could not start video source: ${error.message}`
        }).catch(() => {});
      });
    }
  }
  if (message.action === "pause" && !video.paused) video.pause();
});
