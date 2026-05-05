import type { BgToOffscreen, Mode, OffscreenToBg } from "../shared/messages";

interface TabGraph {
  tabId: number;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  gain: GainNode;
  silenceMonitor?: number;
  silenceStartedAt?: number;
}

const graphs = new Map<number, TabGraph>();
let audioContext: AudioContext | null = null;
let workletReady: Promise<void> | null = null;

function getContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext({ latencyHint: "interactive" });
  }
  return audioContext;
}

async function ensureWorkletLoaded(ctx: AudioContext): Promise<void> {
  if (workletReady) return workletReady;
  workletReady = (async () => {
    // The worklet ships as a static asset declared in web_accessible_resources;
    // chrome.runtime.getURL is stable across the bundler's chunk hashing.
    const url = chrome.runtime.getURL("src/worklets/pitch-shift-worklet.js");
    await ctx.audioWorklet.addModule(url);
  })();
  return workletReady;
}

async function buildGraph(
  tabId: number,
  streamId: string,
  semitones: number,
  mode: Mode,
): Promise<TabGraph> {
  const ctx = getContext();
  await ensureWorkletLoaded(ctx);
  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error - non-standard Chrome constraint
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const source = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, "pitch-shift-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const gain = ctx.createGain();
  gain.gain.value = 1.0;

  source.connect(worklet);
  worklet.connect(gain);
  gain.connect(ctx.destination);

  setMode(worklet, mode);
  setSemitones(worklet, semitones);

  const graph: TabGraph = { tabId, stream, source, worklet, gain };
  startSilenceMonitor(graph);
  return graph;
}

function setSemitones(worklet: AudioWorkletNode, semitones: number): void {
  worklet.port.postMessage({ type: "set-pitch-semitones", value: semitones });
}

function setMode(worklet: AudioWorkletNode, mode: Mode): void {
  worklet.port.postMessage({ type: "set-mode", value: mode });
}

function teardownGraph(graph: TabGraph): void {
  if (graph.silenceMonitor) {
    clearInterval(graph.silenceMonitor);
  }
  try {
    graph.gain.disconnect();
  } catch {
    /* noop */
  }
  try {
    graph.worklet.port.postMessage({ type: "shutdown" });
    graph.worklet.disconnect();
  } catch {
    /* noop */
  }
  try {
    graph.source.disconnect();
  } catch {
    /* noop */
  }
  for (const track of graph.stream.getTracks()) {
    track.stop();
  }
}

function startSilenceMonitor(graph: TabGraph): void {
  // Heuristic DRM detection: if the captured audio is dead-silent for >1.2s
  // after the user told us to start, the tab is probably DRM-protected.
  let lastEnergy = 0;
  graph.worklet.port.addEventListener("message", (ev) => {
    const data = ev.data as { type?: string; rms?: number } | undefined;
    if (data?.type === "rms") {
      lastEnergy = data.rms ?? 0;
    }
  });
  graph.worklet.port.start();

  graph.silenceStartedAt = performance.now();
  graph.silenceMonitor = self.setInterval(() => {
    const SILENCE_THRESHOLD = 1e-5;
    const SILENCE_GRACE_MS = 1500;
    if (lastEnergy > SILENCE_THRESHOLD) {
      graph.silenceStartedAt = performance.now();
      return;
    }
    const since = performance.now() - (graph.silenceStartedAt ?? 0);
    if (since > SILENCE_GRACE_MS) {
      const msg: OffscreenToBg = {
        type: "DRM_SUSPECTED",
        tabId: graph.tabId,
      };
      chrome.runtime.sendMessage(msg).catch(() => {
        /* SW may be asleep; ignore */
      });
      // Only fire once per graph.
      if (graph.silenceMonitor) {
        clearInterval(graph.silenceMonitor);
        graph.silenceMonitor = undefined;
      }
    }
  }, 250);
}

chrome.runtime.onMessage.addListener(
  (msg: BgToOffscreen, _sender, sendResponse: (r: unknown) => void) => {
    (async () => {
      try {
        switch (msg.type) {
          case "START_CAPTURE": {
            // Tear down any prior graph for this tab.
            const prev = graphs.get(msg.tabId);
            if (prev) {
              teardownGraph(prev);
              graphs.delete(msg.tabId);
            }
            const graph = await buildGraph(
              msg.tabId,
              msg.streamId,
              msg.semitones,
              msg.mode,
            );
            graphs.set(msg.tabId, graph);
            const reply: OffscreenToBg = {
              type: "CAPTURE_STARTED",
              tabId: msg.tabId,
            };
            chrome.runtime.sendMessage(reply).catch(() => undefined);
            sendResponse({ ok: true });
            return;
          }
          case "SET_MODE": {
            // Apply to all live graphs.
            for (const g of graphs.values()) {
              setMode(g.worklet, msg.mode);
            }
            sendResponse({ ok: true });
            return;
          }
          case "SET_PITCH": {
            const g = graphs.get(msg.tabId);
            if (!g) {
              sendResponse({ ok: false, error: "no graph for tab" });
              return;
            }
            setSemitones(g.worklet, msg.semitones);
            sendResponse({ ok: true });
            return;
          }
          case "STOP_CAPTURE": {
            const g = graphs.get(msg.tabId);
            if (g) {
              teardownGraph(g);
              graphs.delete(msg.tabId);
            }
            sendResponse({ ok: true });
            return;
          }
          case "PROBE_DRM": {
            sendResponse({ ok: true });
            return;
          }
          default: {
            const _exhaustive: never = msg;
            void _exhaustive;
            sendResponse({ ok: false });
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const reply: OffscreenToBg = {
          type: "CAPTURE_ERROR",
          tabId: (msg as { tabId?: number }).tabId ?? -1,
          error,
        };
        chrome.runtime.sendMessage(reply).catch(() => undefined);
        sendResponse({ ok: false, error });
      }
    })();
    return true;
  },
);
