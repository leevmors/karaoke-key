# Karaoke Key

Real-time pitch shifting for any tab. Raise or lower the key of a YouTube song
(or anything else playing) in semitones, without changing tempo. Built for
karaoke — find your range, sing, done.

## How it works

- The extension captures the active tab's audio with `chrome.tabCapture`.
- A `MediaStream` is held in an offscreen document (Manifest V3 requirement —
  service workers can't host audio).
- Audio flows through a granular pitch-shifter `AudioWorkletProcessor` (two
  Hann-windowed read heads in a circular buffer, crossfaded to preserve
  amplitude while shifting pitch).
- Tab's original audio is auto-muted by `chrome.tabCapture`; only the
  pitch-shifted signal reaches the speakers.

## Limitations

- DRM-protected audio (Spotify Premium, Netflix, Apple Music Web, etc.) returns
  silence under tabCapture. The extension detects this and shows a warning.
- Latency target: ~30–40 ms end-to-end. Should feel tight against a singing
  voice. If you hear slap-back, your output device buffer is high; try wired
  headphones.

## Build

```sh
pnpm install
pnpm build
```

Load `dist/` as an unpacked extension at `chrome://extensions/`.

## Layout

```
src/
  background/    Service worker — message router, tabCapture broker
  offscreen/     Hidden document hosting AudioContext + worklet graph
  popup/         UI (vanilla TS + glassmorphism CSS)
  worklets/      Pitch-shift AudioWorkletProcessor (vanilla JS)
  shared/        Cross-context types and helpers
manifest.config.ts   MV3 manifest (defined via @crxjs/vite-plugin)
```

## Hotkeys

| Action          | Default           |
| --------------- | ----------------- |
| Raise key       | `Ctrl+Up` / `⌘+↑` |
| Lower key       | `Ctrl+Down` / `⌘+↓` |
| Reset           | `Ctrl+0` / `⌘+0`  |

Override in `chrome://extensions/shortcuts`.

## License

MIT.
