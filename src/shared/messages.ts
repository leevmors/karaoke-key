export const MIN_SEMITONES = -12;
export const MAX_SEMITONES = 12;

export type PopupToBg =
  | { type: "GET_STATE"; tabId?: number }
  | { type: "SET_PITCH"; tabId: number; semitones: number }
  | { type: "PITCH_DELTA"; tabId: number; delta: number }
  | { type: "RESET_PITCH"; tabId: number }
  | { type: "STOP"; tabId: number };

export type BgToOffscreen =
  | {
      type: "START_CAPTURE";
      tabId: number;
      streamId: string;
      semitones: number;
    }
  | { type: "SET_PITCH"; tabId: number; semitones: number }
  | { type: "STOP_CAPTURE"; tabId: number }
  | { type: "PROBE_DRM"; tabId: number };

export type OffscreenToBg =
  | { type: "DRM_SUSPECTED"; tabId: number }
  | { type: "CAPTURE_ERROR"; tabId: number; error: string }
  | { type: "CAPTURE_STARTED"; tabId: number };

export interface TabState {
  semitones: number;
  active: boolean;
  drmDetected?: boolean;
}

export const STATE_PREFIX = "tab:";

export function clampSemitones(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, Math.round(n)));
}
