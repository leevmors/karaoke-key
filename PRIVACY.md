# Privacy Policy — Karaoke Key

**Effective: 2026-05-05**

Karaoke Key does not collect, store, transmit, or share any personal
information or audio data.

- Tab audio is captured **locally**, processed **locally** in your browser via
  the Web Audio API, and sent **only** to your speakers.
- No analytics, telemetry, advertising, or tracking SDKs are included.
- No data leaves your device.
- Per-tab pitch settings are stored in `chrome.storage.session`, which is
  cleared automatically when you close the browser.

The extension requires the following permissions for its core function:

- `tabCapture` — to capture audio from the active tab.
- `activeTab` — to know which tab to capture.
- `offscreen` — to host the audio processing pipeline (required by Manifest V3).
- `storage` — to remember the current pitch per tab during your browser session.

If you have questions, open an issue at the project's repository.
