import {
  type BgToOffscreen,
  type OffscreenToBg,
  type PopupToBg,
  type TabState,
  STATE_PREFIX,
  clampSemitones,
} from "../shared/messages";

const OFFSCREEN_URL = "src/offscreen/offscreen.html";

async function ensureOffscreen(): Promise<void> {
  const exists = await chrome.offscreen.hasDocument?.();
  if (exists) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification:
      "Capture and pitch-shift the active tab's audio in real time.",
  });
}

function key(tabId: number) {
  return `${STATE_PREFIX}${tabId}`;
}

async function getState(tabId: number): Promise<TabState> {
  const k = key(tabId);
  const got = await chrome.storage.session.get(k);
  return (got[k] as TabState) ?? { semitones: 0, active: false };
}

async function saveState(tabId: number, state: TabState): Promise<void> {
  await chrome.storage.session.set({ [key(tabId)]: state });
}

async function clearState(tabId: number): Promise<void> {
  await chrome.storage.session.remove(key(tabId));
}

async function getActiveTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tab?.id;
}

async function sendToOffscreen(msg: BgToOffscreen): Promise<void> {
  await ensureOffscreen();
  await chrome.runtime.sendMessage(msg);
}

async function startCapture(tabId: number, semitones: number): Promise<void> {
  await ensureOffscreen();
  // getMediaStreamId must be called from extension contexts; SW is allowed.
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId(
      { targetTabId: tabId },
      (sid: string | undefined) => {
        if (chrome.runtime.lastError || !sid) {
          reject(
            new Error(
              chrome.runtime.lastError?.message ?? "Failed to get stream id",
            ),
          );
          return;
        }
        resolve(sid);
      },
    );
  });
  await sendToOffscreen({
    type: "START_CAPTURE",
    tabId,
    streamId,
    semitones,
  });
}

async function applyPitch(tabId: number, semitones: number): Promise<TabState> {
  const clamped = clampSemitones(semitones);
  const state = await getState(tabId);
  const next: TabState = {
    semitones: clamped,
    active: true,
    drmDetected: state.drmDetected,
  };

  if (!state.active) {
    await startCapture(tabId, clamped);
  } else {
    await sendToOffscreen({
      type: "SET_PITCH",
      tabId,
      semitones: clamped,
    });
  }
  await saveState(tabId, next);
  return next;
}

async function stopCapture(tabId: number): Promise<void> {
  await sendToOffscreen({ type: "STOP_CAPTURE", tabId });
  await clearState(tabId);
}

chrome.runtime.onMessage.addListener(
  (
    msg: PopupToBg | OffscreenToBg,
    _sender,
    sendResponse: (r: unknown) => void,
  ) => {
    (async () => {
      try {
        switch (msg.type) {
          case "GET_STATE": {
            const tabId = msg.tabId ?? (await getActiveTabId());
            if (tabId == null) {
              sendResponse({ ok: false, error: "no active tab" });
              return;
            }
            const state = await getState(tabId);
            sendResponse({ ok: true, tabId, state });
            return;
          }
          case "SET_PITCH": {
            const state = await applyPitch(msg.tabId, msg.semitones);
            sendResponse({ ok: true, tabId: msg.tabId, state });
            return;
          }
          case "PITCH_DELTA": {
            const cur = await getState(msg.tabId);
            const state = await applyPitch(
              msg.tabId,
              cur.semitones + msg.delta,
            );
            sendResponse({ ok: true, tabId: msg.tabId, state });
            return;
          }
          case "RESET_PITCH": {
            const cur = await getState(msg.tabId);
            if (cur.active) {
              await sendToOffscreen({
                type: "SET_PITCH",
                tabId: msg.tabId,
                semitones: 0,
              });
              await stopCapture(msg.tabId);
            }
            sendResponse({
              ok: true,
              tabId: msg.tabId,
              state: { semitones: 0, active: false } as TabState,
            });
            return;
          }
          case "STOP": {
            await stopCapture(msg.tabId);
            sendResponse({ ok: true });
            return;
          }
          case "DRM_SUSPECTED": {
            const cur = await getState(msg.tabId);
            await saveState(msg.tabId, { ...cur, drmDetected: true });
            sendResponse({ ok: true });
            return;
          }
          case "CAPTURE_ERROR": {
            await clearState(msg.tabId);
            sendResponse({ ok: true });
            return;
          }
          case "CAPTURE_STARTED": {
            sendResponse({ ok: true });
            return;
          }
          default: {
            const _exhaustive: never = msg;
            void _exhaustive;
            sendResponse({ ok: false, error: "unknown message" });
          }
        }
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true; // async response
  },
);

chrome.commands.onCommand.addListener(async (command) => {
  const tabId = await getActiveTabId();
  if (tabId == null) return;
  const cur = await getState(tabId);
  switch (command) {
    case "pitch-up":
      await applyPitch(tabId, cur.semitones + 1);
      break;
    case "pitch-down":
      await applyPitch(tabId, cur.semitones - 1);
      break;
    case "pitch-reset":
      if (cur.active) await stopCapture(tabId);
      break;
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const cur = await getState(tabId);
  if (cur.active) {
    try {
      await sendToOffscreen({ type: "STOP_CAPTURE", tabId });
    } catch {
      // offscreen may already be gone — ignore
    }
  }
  await clearState(tabId);
});
