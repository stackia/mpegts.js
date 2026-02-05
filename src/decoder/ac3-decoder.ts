/*
 * AC-3 (Dolby Digital) Audio Decoder
 *
 * TypeScript wrapper for liba52 WASM decoder
 */

import {
  AudioDecoder,
  AudioDecoderInfo,
  WasmModule,
} from "./wasm-audio-decoder";

// AC-3 constants
const AC3_SAMPLES_PER_FRAME = 1536; // 6 blocks * 256 samples
const AC3_MAX_CHANNELS = 6;
const AC3_HEADER_SIZE = 7; // Minimum bytes needed for syncinfo

// Sync info array indices
const SYNC_FLAGS = 0;
const SYNC_SAMPLE_RATE = 1;
const SYNC_BIT_RATE = 2;
const SYNC_FRAME_SIZE = 3;
const SYNC_INFO_SIZE = 4;

// Decode info array indices
const DECODE_SAMPLES = 0;
const DECODE_SAMPLE_RATE = 1;
const DECODE_CHANNELS = 2;
const DECODE_INFO_SIZE = 3;

export class AC3Decoder implements AudioDecoder {
  readonly name = "AC3Decoder";

  private module: WasmModule | null = null;
  private decoderPtr: number = 0;
  private inputPtr: number = 0;
  private outputPtr: number = 0;
  private syncInfoPtr: number = 0;
  private decodeInfoPtr: number = 0;
  private inputBufferSize: number = 0;
  private _ready: Promise<void>;
  private _isReady: boolean = false;

  constructor(wasmModuleFactory: () => Promise<WasmModule>) {
    this._ready = this.init(wasmModuleFactory);
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  private async init(wasmModuleFactory: () => Promise<WasmModule>): Promise<void> {
    this.module = await wasmModuleFactory();

    // Create decoder instance
    const create = this.module.cwrap("ac3_decoder_create", "number", []);
    this.decoderPtr = create();

    if (!this.decoderPtr) {
      throw new Error("Failed to create AC-3 decoder");
    }

    // Allocate output buffer (max samples * max channels * 4 bytes per float)
    const outputSize = AC3_SAMPLES_PER_FRAME * AC3_MAX_CHANNELS * 4;
    this.outputPtr = this.module._malloc(outputSize);

    // Allocate info buffers
    this.syncInfoPtr = this.module._malloc(SYNC_INFO_SIZE * 4);
    this.decodeInfoPtr = this.module._malloc(DECODE_INFO_SIZE * 4);

    // Input buffer allocated on demand
    this.inputBufferSize = 0;
    this.inputPtr = 0;

    this._isReady = true;
  }

  /**
   * Get sync info from AC-3 frame header
   *
   * @param input - Input buffer (needs at least 7 bytes)
   * @returns Frame info or null if not a valid AC-3 sync
   */
  getSyncInfo(input: Uint8Array): {
    flags: number;
    sampleRate: number;
    bitRate: number;
    frameSize: number;
  } | null {
    if (!this._isReady || !this.module || input.length < AC3_HEADER_SIZE) {
      return null;
    }

    // Ensure input buffer is large enough
    if (input.length > this.inputBufferSize) {
      if (this.inputPtr) {
        this.module._free(this.inputPtr);
      }
      this.inputBufferSize = Math.max(input.length, 4096);
      this.inputPtr = this.module._malloc(this.inputBufferSize);
    }

    // Copy input data to WASM memory
    this.module.HEAPU8.set(input, this.inputPtr);

    // Get sync info
    const syncinfo = this.module.cwrap(
      "ac3_syncinfo",
      "number",
      ["number", "number"],
    );

    const frameSize = syncinfo(this.inputPtr, this.syncInfoPtr);

    if (frameSize <= 0) {
      return null;
    }

    return {
      flags: this.module.getValue(this.syncInfoPtr + SYNC_FLAGS * 4, "i32"),
      sampleRate: this.module.getValue(this.syncInfoPtr + SYNC_SAMPLE_RATE * 4, "i32"),
      bitRate: this.module.getValue(this.syncInfoPtr + SYNC_BIT_RATE * 4, "i32"),
      frameSize: this.module.getValue(this.syncInfoPtr + SYNC_FRAME_SIZE * 4, "i32"),
    };
  }

  /**
   * Decode AC-3 frame
   *
   * @param input - Input buffer containing complete AC-3 frame
   * @returns Decoded PCM data and frame info, or null on error
   */
  decode(input: Uint8Array): { pcm: Float32Array; info: AudioDecoderInfo } | null {
    if (!this._isReady || !this.module) {
      return null;
    }

    // Check for valid sync
    const syncInfo = this.getSyncInfo(input);
    if (!syncInfo || input.length < syncInfo.frameSize) {
      return null;
    }

    // Copy input data to WASM memory (may have been resized in getSyncInfo)
    this.module.HEAPU8.set(input, this.inputPtr);

    // Decode frame
    const decode = this.module.cwrap(
      "ac3_decode_frame",
      "number",
      ["number", "number", "number", "number", "number"],
    );

    const samples = decode(
      this.decoderPtr,
      this.inputPtr,
      input.length,
      this.outputPtr,
      this.decodeInfoPtr,
    );

    if (samples <= 0) {
      return null;
    }

    // Read decode info
    const decodedSamples = this.module.getValue(
      this.decodeInfoPtr + DECODE_SAMPLES * 4,
      "i32",
    );
    const sampleRate = this.module.getValue(
      this.decodeInfoPtr + DECODE_SAMPLE_RATE * 4,
      "i32",
    );
    const channels = this.module.getValue(
      this.decodeInfoPtr + DECODE_CHANNELS * 4,
      "i32",
    );

    // Read output samples (float32, already interleaved)
    const outputSamples = decodedSamples * channels;
    const pcm = new Float32Array(
      this.module.HEAPF32.buffer,
      this.outputPtr,
      outputSamples,
    ).slice(); // Copy to avoid referencing WASM memory

    return {
      pcm,
      info: {
        samples: decodedSamples,
        sampleRate,
        channels,
      },
    };
  }

  /**
   * Decode multiple frames from a buffer
   */
  decodeAll(input: Uint8Array): { pcm: Float32Array; info: AudioDecoderInfo } | null {
    if (!this._isReady || !this.module) {
      return null;
    }

    const pcmChunks: Float32Array[] = [];
    let totalSamples = 0;
    let lastInfo: AudioDecoderInfo | null = null;
    let offset = 0;

    while (offset < input.length) {
      const remaining = input.subarray(offset);

      // Get frame size
      const syncInfo = this.getSyncInfo(remaining);
      if (!syncInfo) {
        // Try to find next sync word
        offset++;
        continue;
      }

      if (remaining.length < syncInfo.frameSize) {
        break;
      }

      const frameData = remaining.subarray(0, syncInfo.frameSize);
      const result = this.decode(frameData);

      if (!result) {
        offset += syncInfo.frameSize;
        continue;
      }

      pcmChunks.push(result.pcm);
      totalSamples += result.info.samples;
      lastInfo = result.info;
      offset += syncInfo.frameSize;
    }

    if (pcmChunks.length === 0 || !lastInfo) {
      return null;
    }

    // Concatenate all PCM chunks
    const pcm = new Float32Array(totalSamples * lastInfo.channels);
    let writeOffset = 0;
    for (const chunk of pcmChunks) {
      pcm.set(chunk, writeOffset);
      writeOffset += chunk.length;
    }

    return {
      pcm,
      info: {
        samples: totalSamples,
        sampleRate: lastInfo.sampleRate,
        channels: lastInfo.channels,
      },
    };
  }

  /**
   * Reset decoder state
   */
  reset(): void {
    // AC-3 decoder doesn't have persistent state that needs reset
    // Each frame is independently decodable
  }

  /**
   * Destroy decoder and free all resources
   */
  destroy(): void {
    if (!this.module) {
      return;
    }

    if (this.decoderPtr) {
      const destroy = this.module.cwrap(
        "ac3_decoder_destroy",
        null,
        ["number"],
      );
      destroy(this.decoderPtr);
      this.decoderPtr = 0;
    }

    if (this.inputPtr) {
      this.module._free(this.inputPtr);
      this.inputPtr = 0;
    }

    if (this.outputPtr) {
      this.module._free(this.outputPtr);
      this.outputPtr = 0;
    }

    if (this.syncInfoPtr) {
      this.module._free(this.syncInfoPtr);
      this.syncInfoPtr = 0;
    }

    if (this.decodeInfoPtr) {
      this.module._free(this.decodeInfoPtr);
      this.decodeInfoPtr = 0;
    }

    this.module = null;
    this._isReady = false;
  }
}
