/*
 * Soft Audio Decoder Manager
 *
 * Manages PCM audio playback for software decoded audio
 * Decoding is now done in Web Worker, this class only handles PCM playback
 */

import Log from "../utils/logger";
import { MpegAudioDecoder } from "./mpeg-audio-decoder";
import { AC3Decoder } from "./ac3-decoder";
import { PCMAudioPlayer } from "../audio/pcm-audio-player";
import {
  AudioDecoder,
  AudioDecoderInfo,
  WasmModule,
} from "./wasm-audio-decoder";
import { SoftDecodeAudioCodec, needsSoftwareDecode } from "./codec-support";

const TAG = "SoftAudioDecoder";

export interface SoftAudioDecoderConfig {
  /** Function to load MP2 decoder WASM module (for fallback main thread decode) */
  mp2ModuleLoader?: () => Promise<WasmModule>;
  /** Function to load AC3 decoder WASM module (for fallback main thread decode) */
  ac3ModuleLoader?: () => Promise<WasmModule>;
  /** PCM player configuration */
  playerConfig?: {
    /** Maximum backward buffer duration in seconds (default: 180) */
    maxBackwardBufferDuration?: number;
    /** Minimum backward buffer to retain after cleanup in seconds (default: 120) */
    minBackwardBufferDuration?: number;
    /** Enable buffer seek support (default: true) */
    enableBufferSeek?: boolean;
  };
}

export interface DecodedAudioCallback {
  (pcm: Float32Array, info: AudioDecoderInfo, pts: number): void;
}

/**
 * Soft Audio Decoder Manager
 *
 * Primary mode: Receives PCM data from Worker (decoded in Worker)
 * Fallback mode: Decodes in main thread if Worker decode fails
 */
export class SoftAudioDecoderManager {
  private mp2Decoder: MpegAudioDecoder | null = null;
  private ac3Decoder: AC3Decoder | null = null;
  private pcmPlayer: PCMAudioPlayer | null = null;

  private mp2ModuleLoader: (() => Promise<WasmModule>) | null = null;
  private ac3ModuleLoader: (() => Promise<WasmModule>) | null = null;

  private currentCodec: SoftDecodeAudioCodec | null = null;
  private currentDecoder: AudioDecoder | null = null;
  private isInitialized: boolean = false;
  private isPCMPlayerOnly: boolean = false; // True when using Worker decode
  private videoElement: HTMLVideoElement | null = null;

  private onDecodedAudio: DecodedAudioCallback | null = null;
  private playerConfig: SoftAudioDecoderConfig["playerConfig"];

  constructor(config?: SoftAudioDecoderConfig) {
    this.mp2ModuleLoader = config?.mp2ModuleLoader ?? null;
    this.ac3ModuleLoader = config?.ac3ModuleLoader ?? null;
    this.playerConfig = config?.playerConfig;
  }

  /**
   * Set callback for decoded audio data
   */
  setOnDecodedAudio(callback: DecodedAudioCallback | null): void {
    this.onDecodedAudio = callback;
  }

  /**
   * Check if software decoding is enabled for a codec (main thread fallback)
   */
  canDecode(codec: SoftDecodeAudioCodec): boolean {
    switch (codec) {
      case "mp2":
        return this.mp2ModuleLoader !== null;
      case "ac-3":
        return this.ac3ModuleLoader !== null;
      case "ec-3":
        return false; // E-AC3 software decode not implemented
      default:
        return false;
    }
  }

  /**
   * Initialize PCM player only (for Worker decode mode)
   * Decoding is done in Worker, this just initializes playback
   */
  async initPCMPlayer(): Promise<void> {
    if (this.pcmPlayer) {
      return;
    }

    Log.i(TAG, "Initializing PCM player for worker decode mode");

    this.pcmPlayer = new PCMAudioPlayer(this.playerConfig);
    await this.pcmPlayer.init();

    if (this.videoElement) {
      this.pcmPlayer.attachVideo(this.videoElement);
    }

    this.isPCMPlayerOnly = true;
    this.isInitialized = true;

    Log.i(TAG, "PCM player initialized successfully");
  }

  /**
   * Initialize decoder for a specific codec (fallback main thread decode)
   * Lazy loads the WASM module only when needed
   */
  async initDecoder(codec: SoftDecodeAudioCodec): Promise<boolean> {
    // Check if we need software decode for this codec
    if (!needsSoftwareDecode(codec)) {
      Log.v(
        TAG,
        `Codec ${codec} is natively supported, skipping soft decode init`
      );
      return false;
    }

    if (!this.canDecode(codec)) {
      Log.w(TAG, `No decoder available for codec ${codec}`);
      return false;
    }

    // Reuse existing decoder if same codec
    if (this.currentCodec === codec && this.currentDecoder?.isReady) {
      return true;
    }

    // Destroy previous decoder
    this.destroyCurrentDecoder();

    Log.i(
      TAG,
      `Initializing software decoder for ${codec} (main thread fallback)`
    );

    try {
      switch (codec) {
        case "mp2":
          if (this.mp2ModuleLoader) {
            this.mp2Decoder = new MpegAudioDecoder(this.mp2ModuleLoader);
            await this.mp2Decoder.ready;
            this.currentDecoder = this.mp2Decoder;
          }
          break;

        case "ac-3":
          if (this.ac3ModuleLoader) {
            this.ac3Decoder = new AC3Decoder(this.ac3ModuleLoader);
            await this.ac3Decoder.ready;
            this.currentDecoder = this.ac3Decoder;
          }
          break;
      }

      this.currentCodec = codec;

      // Initialize PCM player if needed
      if (!this.pcmPlayer) {
        this.pcmPlayer = new PCMAudioPlayer(this.playerConfig);
        await this.pcmPlayer.init();
        if (this.videoElement) {
          this.pcmPlayer.attachVideo(this.videoElement);
        }
      }

      this.isPCMPlayerOnly = false;
      this.isInitialized = true;
      Log.i(TAG, `Software decoder for ${codec} initialized successfully`);
      return true;
    } catch (err) {
      Log.e(TAG, `Failed to initialize decoder for ${codec}:`, err);
      this.destroyCurrentDecoder();
      return false;
    }
  }

  /**
   * Feed decoded PCM data directly to player (from Worker)
   *
   * @param pcm - Decoded PCM samples (Float32, interleaved)
   * @param channels - Number of audio channels
   * @param sampleRate - Sample rate in Hz
   * @param pts - Presentation timestamp in milliseconds
   */
  feedPCM(
    pcm: Float32Array,
    channels: number,
    sampleRate: number,
    pts: number
  ): void {
    if (!this.pcmPlayer) {
      return;
    }

    const ptsSeconds = pts / 1000;
    this.pcmPlayer.feed(pcm, channels, sampleRate, ptsSeconds);

    // Callback for external handling
    if (this.onDecodedAudio) {
      this.onDecodedAudio(
        pcm,
        { samples: pcm.length / channels, sampleRate, channels },
        ptsSeconds
      );
    }
  }

  /**
   * Decode audio data and feed to PCM player (fallback main thread decode)
   *
   * @param data - Raw audio frame data
   * @param pts - Presentation timestamp in milliseconds
   */
  decode(data: Uint8Array, pts: number): boolean {
    if (!this.currentDecoder || !this.currentDecoder.isReady) {
      return false;
    }

    const result = this.currentDecoder.decode(data);
    if (!result) {
      return false;
    }

    const ptsSeconds = pts / 1000;

    // Feed to PCM player
    if (this.pcmPlayer) {
      this.pcmPlayer.feed(
        result.pcm,
        result.info.channels,
        result.info.sampleRate,
        ptsSeconds
      );
    }

    // Callback for external handling
    if (this.onDecodedAudio) {
      this.onDecodedAudio(result.pcm, result.info, ptsSeconds);
    }

    return true;
  }

  /**
   * Attach video element for audio/video sync
   */
  attachVideo(video: HTMLVideoElement): void {
    this.videoElement = video;
    if (this.pcmPlayer) {
      this.pcmPlayer.attachVideo(video);
    }
  }

  /**
   * Detach video element
   */
  detachVideo(): void {
    this.videoElement = null;
    if (this.pcmPlayer) {
      this.pcmPlayer.detachVideo();
    }
  }

  /**
   * Start/resume audio playback
   */
  async play(): Promise<void> {
    if (this.pcmPlayer) {
      await this.pcmPlayer.play();
    }
  }

  /**
   * Pause audio playback
   */
  pause(): void {
    if (this.pcmPlayer) {
      this.pcmPlayer.pause();
    }
  }

  /**
   * Stop playback and clear buffers
   */
  stop(): void {
    if (this.pcmPlayer) {
      this.pcmPlayer.stop();
    }
  }

  /**
   * Flush decoder and player state (call on seek)
   */
  flush(): void {
    if (this.currentDecoder) {
      this.currentDecoder.reset();
    }
    if (this.pcmPlayer) {
      this.pcmPlayer.flush();
    }
  }

  /**
   * Set volume (0.0 to 1.0)
   */
  setVolume(volume: number): void {
    if (this.pcmPlayer) {
      this.pcmPlayer.setVolume(volume);
    }
  }

  /**
   * Get current volume
   */
  getVolume(): number {
    return this.pcmPlayer?.getVolume() ?? 1.0;
  }

  /**
   * Set muted state
   */
  setMuted(muted: boolean): void {
    if (this.pcmPlayer) {
      this.pcmPlayer.setMuted(muted);
    }
  }

  /**
   * Get muted state
   */
  isMuted(): boolean {
    return this.pcmPlayer?.isMuted() ?? false;
  }

  /**
   * Get current codec being decoded
   */
  getCurrentCodec(): SoftDecodeAudioCodec | null {
    return this.currentCodec;
  }

  /**
   * Check if soft decoding is active
   * Returns true if either Worker decode (PCM player only) or main thread decode is active
   */
  isActive(): boolean {
    if (this.isPCMPlayerOnly) {
      // Worker decode mode - active if PCM player is initialized
      return this.isInitialized && this.pcmPlayer !== null;
    }
    // Main thread decode mode - active if decoder is ready
    return this.isInitialized && this.currentDecoder?.isReady === true;
  }

  /**
   * Get player statistics
   */
  getStats() {
    return {
      codec: this.currentCodec,
      isActive: this.isActive(),
      isPCMPlayerOnly: this.isPCMPlayerOnly,
      player: this.pcmPlayer?.getStats() ?? null,
    };
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
  }

  /**
   * Destroy manager and release all resources
   */
  async destroy(): Promise<void> {
    this.destroyCurrentDecoder();

    if (this.pcmPlayer) {
      await this.pcmPlayer.destroy();
      this.pcmPlayer = null;
    }

    this.videoElement = null;
    this.isInitialized = false;
    this.isPCMPlayerOnly = false;
    this.onDecodedAudio = null;
  }
}
