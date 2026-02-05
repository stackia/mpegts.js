/*
 * WASM Audio Decoder - Base interface and loader
 *
 * Provides common interface for loading and using WASM audio decoders
 */

export interface AudioDecoderInfo {
  samples: number; // samples per channel
  sampleRate: number;
  channels: number;
}

export interface AudioDecoder {
  readonly name: string;
  readonly ready: Promise<void>;
  readonly isReady: boolean;

  decode(input: Uint8Array): { pcm: Float32Array; info: AudioDecoderInfo } | null;
  reset(): void;
  destroy(): void;
}

export interface WasmModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAPF32: Float32Array;
  HEAP32: Int32Array;
  ccall: (name: string, returnType: string, argTypes: string[], args: any[]) => any;
  cwrap: (name: string, returnType: string, argTypes: string[]) => (...args: any[]) => any;
  getValue: (ptr: number, type: string) => number;
  setValue: (ptr: number, value: number, type: string) => void;
}

/**
 * Load a WASM module from a URL or inline data
 */
export async function loadWasmModule(
  moduleFactory: () => Promise<WasmModule>,
): Promise<WasmModule> {
  return await moduleFactory();
}

/**
 * Convert Int16 PCM samples to Float32
 */
export function int16ToFloat32(
  input: Int16Array,
  samples: number,
  channels: number,
): Float32Array {
  const output = new Float32Array(samples * channels);
  const scale = 1.0 / 32768.0;

  for (let i = 0; i < samples * channels; i++) {
    output[i] = input[i] * scale;
  }

  return output;
}

/**
 * Interleave multi-channel samples
 * Input: [ch0_s0, ch0_s1, ..., ch1_s0, ch1_s1, ...]
 * Output: [ch0_s0, ch1_s0, ch0_s1, ch1_s1, ...]
 */
export function interleaveChannels(
  input: Float32Array,
  samples: number,
  channels: number,
): Float32Array {
  if (channels === 1) {
    return input;
  }

  const output = new Float32Array(samples * channels);

  for (let s = 0; s < samples; s++) {
    for (let c = 0; c < channels; c++) {
      output[s * channels + c] = input[c * samples + s];
    }
  }

  return output;
}
