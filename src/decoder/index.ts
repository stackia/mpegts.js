/*
 * Audio Decoder Module Exports
 *
 * Provides access to software audio decoders and related utilities
 */

export {
  AudioDecoder,
  AudioDecoderInfo,
  WasmModule,
  loadWasmModule,
  int16ToFloat32,
  interleaveChannels,
} from "./wasm-audio-decoder";

export { MpegAudioDecoder } from "./mpeg-audio-decoder";
export { AC3Decoder } from "./ac3-decoder";

export {
  SoftDecodeAudioCodec,
  isMSESupported,
  isCodecSupported,
  isMp2Supported,
  isAc3Supported,
  isEac3Supported,
  getCodecSupport,
  needsSoftwareDecode,
  identifyAudioCodec,
  getCodecSupportDescription,
} from "./codec-support";

export {
  SoftAudioDecoderManager,
  SoftAudioDecoderConfig,
  DecodedAudioCallback,
} from "./soft-audio-decoder";
