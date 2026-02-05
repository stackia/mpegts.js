/*
 * Codec Support Detection
 *
 * Utilities for detecting browser codec support and determining
 * when software decoding is needed
 */

import Log from "../utils/logger";

const TAG = "CodecSupport";

/**
 * Audio codec types that may need software decoding
 */
export type SoftDecodeAudioCodec = "mp2" | "ac-3" | "ec-3";

/**
 * Check if MediaSource is supported
 */
export function isMSESupported(): boolean {
  return (
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported !== undefined
  );
}

/**
 * Check if a specific codec is supported by the browser's MSE implementation
 */
export function isCodecSupported(
  codec: string,
  container: string = "mp4"
): boolean {
  if (!isMSESupported()) {
    return false;
  }

  const mimeType = `audio/${container}; codecs="${codec}"`;
  const supported = MediaSource.isTypeSupported(mimeType);

  Log.v(TAG, `Codec check: ${mimeType} -> ${supported}`);
  return supported;
}

/**
 * Check if MP2 (MPEG-1/2 Layer 2) audio is natively supported
 *
 * MP2 codec strings:
 * - mp4a.69: MPEG-2 Audio Layer 2
 * - mp4a.6B: MPEG-1 Audio Layer 2
 */
export function isMp2Supported(): boolean {
  // Try both MPEG-1 and MPEG-2 layer 2 codec strings
  return isCodecSupported("mp4a.69") || isCodecSupported("mp4a.6B");
}

/**
 * Check if AC-3 (Dolby Digital) audio is natively supported
 */
export function isAc3Supported(): boolean {
  return isCodecSupported("ac-3");
}

/**
 * Check if E-AC3 (Dolby Digital Plus) audio is natively supported
 */
export function isEac3Supported(): boolean {
  return isCodecSupported("ec-3");
}

/**
 * Cached codec support results
 */
let codecSupportCache: Map<SoftDecodeAudioCodec, boolean> | null = null;

/**
 * Get codec support status with caching
 */
export function getCodecSupport(): Map<SoftDecodeAudioCodec, boolean> {
  if (codecSupportCache) {
    return codecSupportCache;
  }

  codecSupportCache = new Map([
    ["mp2", isMp2Supported()],
    ["ac-3", isAc3Supported()],
    ["ec-3", isEac3Supported()],
  ]);

  Log.i(
    TAG,
    `Codec support: MP2=${codecSupportCache.get("mp2")}, ` +
      `AC-3=${codecSupportCache.get("ac-3")}, ` +
      `E-AC3=${codecSupportCache.get("ec-3")}`
  );

  return codecSupportCache;
}

/**
 * Check if software decoding is needed for a specific codec
 */
export function needsSoftwareDecode(codec: SoftDecodeAudioCodec): boolean {
  const support = getCodecSupport();
  return !support.get(codec);
}

/**
 * Determine the audio codec from track metadata
 *
 * @param codec - Codec string from demuxer (e.g., "mp3", "ac-3", "ec-3")
 * @param objectType - MPEG-4 audio object type (for mp3/mp2 distinction)
 */
export function identifyAudioCodec(
  codec: string,
  objectType?: number
): SoftDecodeAudioCodec | null {
  // Normalize codec string
  const normalizedCodec = codec.toLowerCase();

  if (normalizedCodec === "ac-3") {
    return "ac-3";
  }

  if (normalizedCodec === "ec-3") {
    return "ec-3";
  }

  // Check for MP2 based on object type
  // MPEG-4 Audio Object Types:
  // 32 = Layer 1
  // 33 = Layer 2 (MP2)
  // 34 = Layer 3 (MP3)
  if (normalizedCodec === "mp3" && objectType !== undefined) {
    if (objectType === 33) {
      return "mp2";
    }
  }

  return null;
}

/**
 * Get a human-readable description of codec support status
 */
export function getCodecSupportDescription(): string {
  const support = getCodecSupport();
  const lines: string[] = [];

  for (const [codec, supported] of support) {
    const status = supported ? "Native" : "Needs Software Decode";
    lines.push(`  ${codec}: ${status}`);
  }

  return `Browser Audio Codec Support:\n${lines.join("\n")}`;
}
