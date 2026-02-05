/*
 * Worker Audio Decoder
 *
 * Manages audio decoding in Web Worker environment
 * Supports MP2 and AC3 codecs via WASM decoders
 */

import Log from "../utils/logger";
import { MpegAudioDecoder } from "./mpeg-audio-decoder";
import { AC3Decoder } from "./ac3-decoder";
import {
  AudioDecoder,
  AudioDecoderInfo,
  WasmModule,
} from "./wasm-audio-decoder";

const TAG = "WorkerAudioDecoder";

export type SoftDecodeAudioCodec = "mp2" | "ac-3" | "ec-3";

export interface PCMAudioData {
  pcm: Float32Array;
  channels: number;
  sampleRate: number;
  pts: number; // PTS in milliseconds
}

export interface WorkerAudioDecoderConfig {
  wasmPath?: string;
}

/**
 * Load WASM module in Worker using dynamic import
 */
async function loadWasmModuleInWorker(jsUrl: string): Promise<WasmModule> {
  let absoluteUrl: string;

  // Convert to absolute URL if needed
  if (
    jsUrl.startsWith("http://") ||
    jsUrl.startsWith("https://") ||
    jsUrl.startsWith("blob:")
  ) {
    absoluteUrl = jsUrl;
  } else if (jsUrl.startsWith("/")) {
    // Absolute path - use origin
    absoluteUrl = self.location.origin + jsUrl;
  } else {
    // Relative path - resolve against current location
    const base = self.location.href || self.location.origin || "";
    absoluteUrl = new URL(jsUrl, base).href;
  }

  Log.v(TAG, `Loading WASM module from ${absoluteUrl}`);

  // Dynamic import the ES module
  const module = await import(/* @vite-ignore */ absoluteUrl);
  const factory = module.default || module;

  if (typeof factory === "function") {
    return await factory();
  }

  throw new Error(`Failed to load WASM module from ${jsUrl}`);
}

/**
 * Audio decoder for use in Web Worker
 * Handles WASM module loading and audio decoding
 */
export class WorkerAudioDecoder {
  private mp2Decoder: MpegAudioDecoder | null = null;
  private ac3Decoder: AC3Decoder | null = null;
  private currentDecoder: AudioDecoder | null = null;
  private currentCodec: SoftDecodeAudioCodec | null = null;
  private isInitialized: boolean = false;
  private wasmPath: string;

  // WASM modules (loaded once)
  private mp2Module: WasmModule | null = null;
  private ac3Module: WasmModule | null = null;

  constructor(config?: WorkerAudioDecoderConfig) {
    this.wasmPath = config?.wasmPath || "/wasm/";
  }

  /**
   * Check if decoder can handle a codec
   */
  canDecode(codec: SoftDecodeAudioCodec): boolean {
    return codec === "mp2" || codec === "ac-3";
  }

  /**
   * Initialize decoder for a specific codec
   */
  async initDecoder(codec: SoftDecodeAudioCodec): Promise<boolean> {
    if (!this.canDecode(codec)) {
      Log.w(TAG, `Codec ${codec} not supported`);
      return false;
    }

    // Reuse existing decoder if same codec
    if (this.currentCodec === codec && this.currentDecoder?.isReady) {
      return true;
    }

    // Destroy previous decoder
    this.destroyCurrentDecoder();

    Log.i(TAG, `Initializing decoder for ${codec} in worker`);

    try {
      switch (codec) {
        case "mp2":
          await this.initMp2Decoder();
          break;
        case "ac-3":
          await this.initAc3Decoder();
          break;
      }

      this.currentCodec = codec;
      this.isInitialized = true;
      Log.i(TAG, `Decoder for ${codec} initialized successfully`);
      return true;
    } catch (err) {
      Log.e(TAG, `Failed to initialize decoder for ${codec}: ${err}`);
      this.destroyCurrentDecoder();
      return false;
    }
  }

  /**
   * Initialize MP2 decoder
   */
  private async initMp2Decoder(): Promise<void> {
    if (!this.mp2Module) {
      // Load WASM module in Worker
      const url = `${this.wasmPath}mp2_decoder.js`;
      Log.i(TAG, `Loading MP2 WASM module from ${url}`);
      this.mp2Module = await loadWasmModuleInWorker(url);
    }

    this.mp2Decoder = new MpegAudioDecoder(() =>
      Promise.resolve(this.mp2Module!)
    );
    await this.mp2Decoder.ready;
    this.currentDecoder = this.mp2Decoder;
  }

  /**
   * Initialize AC3 decoder
   */
  private async initAc3Decoder(): Promise<void> {
    if (!this.ac3Module) {
      // Load WASM module in Worker
      const url = `${this.wasmPath}ac3_decoder.js`;
      Log.i(TAG, `Loading AC3 WASM module from ${url}`);
      this.ac3Module = await loadWasmModuleInWorker(url);
    }

    this.ac3Decoder = new AC3Decoder(() => Promise.resolve(this.ac3Module!));
    await this.ac3Decoder.ready;
    this.currentDecoder = this.ac3Decoder;
  }

  /**
   * Decode audio data
   *
   * @param data - Raw compressed audio data
   * @param pts - Presentation timestamp in milliseconds
   * @returns Decoded PCM data or null if decoding failed
   */
  decode(data: Uint8Array, pts: number): PCMAudioData | null {
    if (!this.currentDecoder || !this.currentDecoder.isReady) {
      return null;
    }

    const result = this.currentDecoder.decode(data);
    if (!result) {
      return null;
    }

    return {
      pcm: result.pcm,
      channels: result.info.channels,
      sampleRate: result.info.sampleRate,
      pts: pts,
    };
  }

  /**
   * Get current codec
   */
  getCurrentCodec(): SoftDecodeAudioCodec | null {
    return this.currentCodec;
  }

  /**
   * Check if decoder is active
   */
  isActive(): boolean {
    return this.isInitialized && this.currentDecoder?.isReady === true;
  }

  /**
   * Reset decoder state (call on seek)
   */
  reset(): void {
    if (this.currentDecoder) {
      this.currentDecoder.reset();
    }
  }

  /**
   * Destroy current decoder
   */
  private destroyCurrentDecoder(): void {
    if (this.mp2Decoder) {
      this.mp2Decoder.destroy();
      this.mp2Decoder = null;
    }
    if (this.ac3Decoder) {
      this.ac3Decoder.destroy();
      this.ac3Decoder = null;
    }
    this.currentDecoder = null;
    this.currentCodec = null;
    this.isInitialized = false;
  }

  /**
   * Destroy decoder and release resources
   */
  destroy(): void {
    this.destroyCurrentDecoder();
    // Note: We keep the WASM modules loaded for potential reuse
    // They will be garbage collected when the worker is terminated
  }
}
