let lastVideo = null;
let playbackTimer = null;
let ignoreLocalUpdatesUntil = 0;

function findVideo() {
  const videos = [...document.querySelectorAll("video")].filter(video => {
    const rect = video.getBoundingClientRect();
    return video.readyState >= 0 && rect.width > 1 && rect.height > 1;
  });
  const video = videos.find(item => item.readyState >= 2) ||
    videos.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0] ||
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
    sendResponse({ found: false });
    return;
  }

  if (message.type === "SET_PLAYBACK") {
    ignoreLocalUpdatesUntil = Date.now() + 2500;
    const apply = () => {
      if (typeof message.time === "number" && Number.isFinite(message.time)) {
        if (Math.abs(video.currentTime - message.time) > 0.75) {
          try {
            video.currentTime = Math.max(0, message.time);
          } catch {}
        }
      }
      if (typeof message.rate === "number" && Number.isFinite(message.rate)) {
        video.playbackRate = message.rate;
      }
      if (message.action === "play" && video.paused) {
        const playPromise = video.play();
        if (playPromise?.catch) {
          playPromise.catch(error => {
            chrome.runtime.sendMessage({
              type: "PLAYBACK_ERROR",
              error: error.message
            }).catch(() => {});
          });
        }
      }
      if (message.action === "pause" && !video.paused) video.pause();
      sendResponse({ ok: true });
    };

    if (video.readyState === 0) {
      video.addEventListener("loadedmetadata", apply, { once: true });
      setTimeout(() => {
        if (video.readyState === 0) sendResponse({ found: true, waiting: true });
      }, 1500);
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

playbackTimer = setInterval(broadcastPlayback, 2000);
