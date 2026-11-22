// Playback and page synchronization between the side panel and the page's
// content script.

const URL_POLL_MS = 1500;
const STATUS_POLL_MS = 2000;

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createSync({ send, isHost, onStatus }) {
  let applying = false;
  let applyTimer = null;
  let navigating = false;
  let lastSharedUrl = "";
  let urlTimer = null;
  let statusTimer = null;

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function getPlayback() {
    const tab = await getActiveTab();
    if (!tab?.id) return { found: false };
    try {
      return (await chrome.tabs.sendMessage(tab.id, { type: "GET_PLAYBACK" })) || { found: false };
    } catch {
      return { found: false };
    }
  }

  async function setPlayback(payload) {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "SET_PLAYBACK", ...payload });
        return;
      } catch {}
      await sleep(500);
    }
  }

  function waitForTabLoad(tabId, timeout = 8000) {
    return new Promise(resolve => {
      const finish = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") finish();
      };
      const timer = setTimeout(finish, timeout);
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // Open the shared page in the active tab. Afterwards remember the URL the tab
  // actually ended up on (after redirects) so we don't echo it back as a "new" page.
  async function openUrl(url) {
    if (!isHttpUrl(url)) return;
    const tab = await getActiveTab();
    if (!tab?.id) return;
    if (tab.url !== url) {
      navigating = true;
      try {
        await chrome.tabs.update(tab.id, { url });
        await waitForTabLoad(tab.id);
        await sleep(800);
      } finally {
        navigating = false;
      }
    }
    const fresh = await getActiveTab();
    lastSharedUrl = fresh?.url || url;
  }

  async function applyRemote(playback, kind = "event") {
    if (!playback || playback.found === false) return;
    clearTimeout(applyTimer);
    applying = true;
    await setPlayback({
      action: playback.paused ? "pause" : "play",
      time: playback.time,
      rate: playback.rate,
      kind
    });
    applyTimer = setTimeout(() => { applying = false; }, 1200);
  }

  async function applyRoomState(state) {
    if (!state) return;
    if (state.url) await openUrl(state.url);
    if (state.playback) await applyRemote(state.playback, "event");
  }

  // Called with a PLAYBACK_STATE message from the content script.
  function handleLocalPlayback(state) {
    if (applying || !state?.found) return;
    // Only the host sends periodic corrections; either side can send user actions.
    if (state.kind === "heartbeat" && !isHost()) return;
    send({ type: "playback", state });
  }

  // Share this tab's page and position with the room.
  async function pushNow() {
    const [tab, playback] = await Promise.all([getActiveTab(), getPlayback()]);
    if (tab?.url && isHttpUrl(tab.url)) {
      lastSharedUrl = tab.url;
      send({ type: "navigate", url: tab.url });
    }
    if (playback.found) send({ type: "playback", state: { ...playback, kind: "event" } });
    return playback;
  }

  async function pollUrl() {
    if (navigating) return;
    const tab = await getActiveTab();
    if (!tab?.url || !isHttpUrl(tab.url) || tab.url === lastSharedUrl) return;
    lastSharedUrl = tab.url;
    send({ type: "navigate", url: tab.url });
  }

  async function pollStatus() {
    onStatus(await getPlayback());
  }

  function start() {
    stop();
    urlTimer = setInterval(() => void pollUrl(), URL_POLL_MS);
    statusTimer = setInterval(() => void pollStatus(), STATUS_POLL_MS);
    void pollStatus();
  }

  function stop() {
    clearInterval(urlTimer);
    clearInterval(statusTimer);
    urlTimer = null;
    statusTimer = null;
  }

  return {
    getActiveTab,
    getPlayback,
    openUrl,
    applyRemote,
    applyRoomState,
    handleLocalPlayback,
    pushNow,
    start,
    stop
  };
}
