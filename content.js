let lastVideo = null;

function findVideo() {
  const video = document.querySelector("video");
  if (video !== lastVideo) {
    lastVideo = video;
  }
  return video;
}

function state() {
  const video = findVideo();
  if (!video) return { found: false };
  return {
    found: true,
    paused: video.paused,
    time: video.currentTime,
    rate: video.playbackRate
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
    if (typeof message.time === "number" && Math.abs(video.currentTime - message.time) > 1) {
      video.currentTime = message.time;
    }
    if (typeof message.rate === "number") video.playbackRate = message.rate;
    if (message.action === "play") video.play().catch(() => {});
    if (message.action === "pause") video.pause();
    sendResponse({ ok: true });
  }
});

setInterval(() => {
  const video = findVideo();
  if (!video) return;
  chrome.runtime.sendMessage({
    type: "PLAYBACK_STATE",
    state: state()
  }).catch(() => {});
}, 2000);
