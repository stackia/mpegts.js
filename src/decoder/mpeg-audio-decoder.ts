/*
 * MPEG Audio Decoder (MP1/MP2/MP3)
 *
 * TypeScript wrapper for minimp3 WASM decoder
 */

import {
  AudioDecoder,
  AudioDecoderInfo,
  WasmModule,
  int16ToFloat32,
} from "./wasm-audio-decoder";

// Maximum samples per frame for MPEG audio
const MINIMP3_MAX_SAMPLES_PER_FRAME = 1152 * 2; // 1152 samples * 2 channels

// Frame info array indices
const INFO_SAMPLES = 0;
const INFO_SAMPLE_RATE = 1;
const INFO_CHANNELS = 2;
const INFO_LAYER = 3;
const INFO_BITRATE = 4;
const INFO_FRAME_BYTES = 5;
const INFO_SIZE = 6;

export class MpegAudioDecoder implements AudioDecoder {
  readonly name = "MpegAudioDecoder";

  private module: WasmModule | null = null;
  private decoderPtr: number = 0;
  private inputPtr: number = 0;
  private outputPtr: number = 0;
  private infoPtr: number = 0;
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
    const create = this.module.cwrap(
      "mpeg_audio_decoder_create",
      "number",
      [],
    );
    this.decoderPtr = create();

    if (!this.decoderPtr) {
      throw new Error("Failed to create MPEG audio decoder");
    }

    // Allocate output buffer (max samples * 2 bytes per sample)
    const outputSize = MINIMP3_MAX_SAMPLES_PER_FRAME * 2;
    this.outputPtr = this.module._malloc(outputSize);

    // Allocate info buffer (6 * 4 bytes for int32 values)
    this.infoPtr = this.module._malloc(INFO_SIZE * 4);

    // Input buffer allocated on demand
    this.inputBufferSize = 0;
    this.inputPtr = 0;

    this._isReady = true;
  }

  /**
   * Decode MPEG audio frame(s) from input data
   *
   * @param input - Input buffer containing MPEG audio data
   * @returns Decoded PCM data and frame info, or null if no frame found
   */
  decode(input: Uint8Array): { pcm: Float32Array; info: AudioDecoderInfo } | null {
    if (!this._isReady || !this.module) {
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

    // Decode frame
    const decode = this.module.cwrap(
      "mpeg_audio_decode_frame",
      "number",
      ["number", "number", "number", "number", "number"],
    );

    const samples = decode(
      this.decoderPtr,
      this.inputPtr,
      input.length,
      this.outputPtr,
      this.infoPtr,
    );

    if (samples <= 0) {
      return null;
    }

    // Read frame info
    const infoSamples = this.module.getValue(this.infoPtr + INFO_SAMPLES * 4, "i32");
    const sampleRate = this.module.getValue(this.infoPtr + INFO_SAMPLE_RATE * 4, "i32");
    const channels = this.module.getValue(this.infoPtr + INFO_CHANNELS * 4, "i32");
    const layer = this.module.getValue(this.infoPtr + INFO_LAYER * 4, "i32");
    const frameBytes = this.module.getValue(this.infoPtr + INFO_FRAME_BYTES * 4, "i32");

    // Read output samples (int16)
    const outputSamples = infoSamples * channels;
    const int16Samples = new Int16Array(
      this.module.HEAP16.buffer,
      this.outputPtr,
      outputSamples,
    );

    // Convert to Float32
    const pcm = int16ToFloat32(int16Samples, infoSamples, channels);

    return {
      pcm,
      info: {
        samples: infoSamples,
        sampleRate,
        channels,
      },
    };
  }

  /**
   * Decode multiple frames from a buffer
   * Returns all decoded PCM data concatenated
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
      const result = this.decode(remaining);

      if (!result) {
        break;
      }

      pcmChunks.push(result.pcm);
      totalSamples += result.info.samples;
      lastInfo = result.info;

      // Get frame size from info
      const frameBytes = this.module.getValue(this.infoPtr + INFO_FRAME_BYTES * 4, "i32");
      if (frameBytes <= 0) {
        break;
      }
      offset += frameBytes;
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
   * Reset decoder state (call when seeking or switching streams)
   */
  reset(): void {
    if (!this._isReady || !this.module || !this.decoderPtr) {
      return;
    }

    const reset = this.module.cwrap("mpeg_audio_decoder_reset", null, ["number"]);
    reset(this.decoderPtr);
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
        "mpeg_audio_decoder_destroy",
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

    if (this.infoPtr) {
      this.module._free(this.infoPtr);
      this.infoPtr = 0;
    }

    this.module = null;
    this._isReady = false;
  }
}
