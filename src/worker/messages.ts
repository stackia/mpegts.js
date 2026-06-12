import type { PlayerConfig } from "../config";
import type { PlayerSegment } from "../types";

export type WorkerCommand =
	| { type: "init"; segments: PlayerSegment[]; config: PlayerConfig; gen: number }
	| { type: "start" }
	| { type: "load-segments"; segments: PlayerSegment[]; gen: number }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "seek"; time: number }
	| { type: "destroy" };

export type WorkerEvent =
	| { type: "init-segment"; track: "video" | "audio"; data: ArrayBuffer; codec: string; container: string; gen: number }
	| { type: "media-segment"; track: "video" | "audio"; data: ArrayBuffer; gen: number }
	| { type: "media-info"; info: unknown; gen: number }
	| { type: "complete"; gen: number }
	| { type: "error"; category: "io" | "demux"; detail: string; info?: string; gen: number }
	| { type: "seek-handled"; gen: number }
	| { type: "seek-not-handled"; time: number; gen: number }
	| { type: "pcm-audio-data"; pcm: ArrayBuffer; channels: number; sampleRate: number; pts: number; gen: number };
