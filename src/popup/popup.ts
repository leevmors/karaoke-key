import {
  type PopupToBg,
  type TabState,
  clampSemitones,
} from "../shared/messages";

interface BgResponse {
  ok: boolean;
  tabId?: number;
  state?: TabState;
  error?: string;
}

const valueEl = document.getElementById("value") as HTMLDivElement;
const signEl = document.getElementById("sign") as HTMLDivElement;
const labelEl = document.getElementById("label") as HTMLDivElement;
const readoutEl = document.getElementById("readout") as HTMLElement;
const upBtn = document.getElementById("up") as HTMLButtonElement;
const downBtn = document.getElementById("down") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;

let activeTabId: number | null = null;
let currentSemitones = 0;

function send<R = BgResponse>(msg: PopupToBg): Promise<R> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp: R) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp);
    });
  });
}

function describe(semitones: number): {
  sign: string;
  value: string;
  label: string;
  direction: "up" | "down" | "neutral";
} {
  if (semitones === 0) {
    return {
      sign: "±",
      value: "0",
      label: "Original key",
      direction: "neutral",
    };
  }
  const abs = Math.abs(semitones);
  const semWord = abs === 1 ? "semitone" : "semitones";
  if (semitones > 0) {
    return {
      sign: "+",
      value: String(abs),
      label: `${abs} ${semWord} higher`,
      direction: "up",
    };
  }
  return {
    sign: "−",
    value: String(abs),
    label: `${abs} ${semWord} lower`,
    direction: "down",
  };
}

function render(semitones: number, animate: boolean): void {
  const { sign, value, label, direction } = describe(semitones);
  signEl.textContent = sign;
  valueEl.textContent = value;
  labelEl.textContent = label;
  readoutEl.dataset.direction = direction;
  if (animate) {
    valueEl.classList.remove("bump");
    void valueEl.offsetWidth; // restart animation
    valueEl.classList.add("bump");
  }
  currentSemitones = semitones;
}

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.setTimeout(() => {
    toastEl.hidden = true;
  }, 4000);
}

async function findActiveTabId(): Promise<number | undefined> {
  // Popup context has a real associated window; this is reliable.
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tab?.id;
}

async function bootstrap(): Promise<void> {
  try {
    const tabId = await findActiveTabId();
    if (tabId == null) {
      showToast("No active tab.");
      return;
    }
    activeTabId = tabId;
    const resp = await send({ type: "GET_STATE", tabId });
    if (!resp.ok) {
      showToast(resp.error ?? "Couldn't load state.");
      return;
    }
    render(resp.state?.semitones ?? 0, false);
    if (resp.state?.drmDetected) {
      showToast("This site uses DRM. Pitch shifting won't work here.");
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not load state.");
  }
}

async function nudge(delta: number): Promise<void> {
  if (activeTabId == null) return;
  const target = clampSemitones(currentSemitones + delta);
  if (target === currentSemitones) return;
  render(target, true);
  try {
    const resp = await send({
      type: "PITCH_DELTA",
      tabId: activeTabId,
      delta,
    });
    if (!resp.ok) {
      showToast(resp.error ?? "Couldn't adjust pitch on this tab.");
      // revert visual on error
      render(currentSemitones - delta, false);
      return;
    }
    if (resp.state) render(resp.state.semitones, false);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Pitch shift failed.");
    render(currentSemitones - delta, false);
  }
}

async function reset(): Promise<void> {
  if (activeTabId == null) return;
  render(0, true);
  try {
    await send({ type: "RESET_PITCH", tabId: activeTabId });
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Reset failed.");
  }
}

upBtn.addEventListener("click", () => nudge(+1));
downBtn.addEventListener("click", () => nudge(-1));
resetBtn.addEventListener("click", reset);

// In-popup keyboard shortcuts (work while popup is focused).
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === "ArrowUp") {
    event.preventDefault();
    void nudge(+1);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    void nudge(-1);
  } else if (event.key === "0" || event.key === "Escape") {
    event.preventDefault();
    void reset();
  }
});

// Live-update if the SW state changes (hotkey pressed while popup is open).
chrome.storage.session.onChanged.addListener((changes) => {
  if (activeTabId == null) return;
  const k = `tab:${activeTabId}`;
  const change = changes[k];
  if (!change) return;
  const next = (change.newValue as TabState | undefined) ?? {
    semitones: 0,
    active: false,
  };
  if (next.semitones !== currentSemitones) {
    render(next.semitones, true);
  }
  if (next.drmDetected) {
    showToast("This site uses DRM. Pitch shifting won't work here.");
  }
});

void bootstrap();
