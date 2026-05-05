import {
  type Mode,
  type PopupToBg,
  type TabState,
  DEFAULT_MODE,
  clampSemitones,
} from "../shared/messages";

interface BgResponse {
  ok: boolean;
  tabId?: number;
  state?: TabState;
  mode?: Mode;
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
const modeToggleBtn = document.getElementById(
  "mode-toggle",
) as HTMLButtonElement;
const modeLabelEl = modeToggleBtn.querySelector(
  ".mode-label",
) as HTMLSpanElement;

let activeTabId: number | null = null;
let currentSemitones = 0;
let currentMode: Mode = DEFAULT_MODE;

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
  // Try the popup's own window first; fall back to the last focused window
  // (covers detached popup-window quirks), then any active normal-window tab.
  try {
    const [a] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (a?.id != null) return a.id;
  } catch {
    /* fall through */
  }
  try {
    const [b] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (b?.id != null) return b.id;
  } catch {
    /* fall through */
  }
  try {
    const all = await chrome.tabs.query({ active: true });
    return all.find((t) => t.id != null && t.windowId != null)?.id;
  } catch {
    return undefined;
  }
}

async function ensureTabId(): Promise<number | undefined> {
  if (activeTabId != null) return activeTabId;
  const id = await findActiveTabId();
  if (id != null) activeTabId = id;
  return activeTabId ?? undefined;
}

function renderMode(mode: Mode): void {
  currentMode = mode;
  modeToggleBtn.dataset.mode = mode;
  modeLabelEl.textContent = mode === "heavy" ? "HD" : "Lite";
  modeToggleBtn.title =
    mode === "heavy"
      ? "Heavy: full stereo preservation, slightly more CPU. Click to switch to Lite."
      : "Lite: lower CPU, slight stereo bleed. Click to switch to HD.";
}

async function bootstrap(): Promise<void> {
  // Mode is a global preference; load it independent of any tab.
  try {
    const r = await send({ type: "GET_MODE" });
    if (r.ok && r.mode) renderMode(r.mode);
  } catch {
    /* silent */
  }

  // Bootstrap is best-effort. If anything fails here it's not user-actionable
  // (SW cold-start race, transient API hiccup, etc.) - we just stay on the
  // default 0 readout. The user's next click will resolve the tab lazily and
  // drive the SW. Only the DRM warning is shown because that IS actionable.
  const tabId = await ensureTabId();
  if (tabId == null) return;
  try {
    const resp = await send({ type: "GET_STATE", tabId });
    if (resp.ok && resp.state) {
      render(resp.state.semitones ?? 0, false);
      if (resp.state.drmDetected) {
        showToast("This site uses DRM. Pitch shifting won't work here.");
      }
    }
  } catch {
    /* silent - the popup will sync after the next user action */
  }
}

async function toggleMode(): Promise<void> {
  const prev = currentMode;
  const next: Mode = prev === "heavy" ? "light" : "heavy";
  // Optimistic UI update.
  renderMode(next);
  try {
    await send({ type: "SET_MODE", mode: next });
  } catch {
    renderMode(prev);
  }
}

async function nudge(delta: number): Promise<void> {
  const tabId = await ensureTabId();
  if (tabId == null) return;
  const target = clampSemitones(currentSemitones + delta);
  if (target === currentSemitones) return;
  render(target, true);
  try {
    const resp = await send({ type: "PITCH_DELTA", tabId, delta });
    if (!resp.ok) {
      // Real, user-facing failure (e.g. tabCapture refused) - show it.
      if (resp.error) showToast(resp.error);
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
  const tabId = await ensureTabId();
  if (tabId == null) return;
  render(0, true);
  try {
    await send({ type: "RESET_PITCH", tabId });
  } catch {
    /* silent - reset is fire-and-forget */
  }
}

upBtn.addEventListener("click", () => nudge(+1));
downBtn.addEventListener("click", () => nudge(-1));
resetBtn.addEventListener("click", reset);
modeToggleBtn.addEventListener("click", () => void toggleMode());

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
