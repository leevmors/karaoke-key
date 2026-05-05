import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Karaoke Key — Pitch Shifter",
  version: "0.1.0",
  description:
    "Raise or lower the key of any song playing in your tab. Real-time pitch shift for karaoke. No tempo change, no setup.",
  minimum_chrome_version: "116",
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  action: {
    default_popup: "src/popup/popup.html",
    default_title: "Karaoke Key",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
    },
  },
  background: {
    service_worker: "src/background/background.ts",
    type: "module",
  },
  permissions: ["tabCapture", "activeTab", "offscreen", "storage"],
  commands: {
    "pitch-up": {
      suggested_key: { default: "Ctrl+Up", mac: "Command+Up" },
      description: "Raise key by one semitone",
    },
    "pitch-down": {
      suggested_key: { default: "Ctrl+Down", mac: "Command+Down" },
      description: "Lower key by one semitone",
    },
    "pitch-reset": {
      suggested_key: { default: "Ctrl+0", mac: "Command+0" },
      description: "Reset to original key",
    },
  },
  web_accessible_resources: [
    {
      resources: ["src/worklets/pitch-shift-worklet.js"],
      matches: ["<all_urls>"],
    },
  ],
});
