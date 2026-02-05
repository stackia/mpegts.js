/*
 * PCM Audio Player
 *
 * Plays decoded PCM audio using Web Audio API with video synchronization support
 */

import Log from "../utils/logger";

const TAG = "PCMAudioPlayer";

export interface PCMAudioPlayerConfig {
  /** Maximum backward buffer duration in seconds (default: 180) */
  maxBackwardBufferDuration?: number;
  /** Minimum backward buffer to retain after cleanup in seconds (default: 120) */
  minBackwardBufferDuration?: number;
  /** Enable buffer seek support (default: true) */
  enableBufferSeek?: boolean;
}

interface AudioChunk {
  samples: Float32Array;
  channels: number;
  sampleRate: number;
  pts: number; // presentation timestamp in seconds
}

interface BufferedAudioChunk {
  samples: Float32Array;
  channels: number;
  sampleRate: number;
  pts: number;      // start time in seconds
  duration: number; // duration in seconds
  endPts: number;   // pts + duration (computed for fast lookup)
}

interface ScheduledSource {
  source: AudioBufferSourceNode;
  startTime: number;   // AudioContext time when scheduled to start
  endTime: number;     // AudioContext time when scheduled to end
  chunkPts: number;    // Original PTS for debugging
}

export class PCMAudioPlayer {
  private context: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private pendingChunks: AudioChunk[] = [];
  private isPlaying: boolean = false;
  private isPaused: boolean = false;
  private volume: number = 1.0;
  private muted: boolean = false;

  // Sync state
  private videoElement: HTMLVideoElement | null = null;

  // Base PTS offset: audioPTS - videoPTS at the start
  // This allows us to map audio PTS to video timeline
  private basePtsOffset: number = 0;
  private basePtsEstablished: boolean = false;

  // Track the end time of the last scheduled chunk (in AudioContext time)
  // This ensures continuous playback without gaps
  private lastScheduledEndTime: number = 0;

  // iOS Silent Mode bypass: route audio through a hidden audio element
  private audioElement: HTMLAudioElement | null = null;
  private mediaStreamDestination: MediaStreamAudioDestinationNode | null = null;

  // Stats
  private samplesPlayed: number = 0;
  private chunksScheduled: number = 0;
  private chunksDropped: number = 0;

  // Buffer management for seek support
  private audioBuffer: BufferedAudioChunk[] = [];
  private maxBackwardBufferDuration: number = 180;
  private minBackwardBufferDuration: number = 120;
  private bufferSeekEnabled: boolean = true;

  // Track scheduled sources for cancellation
  private scheduledSources: ScheduledSource[] = [];

  // Seek state
  private isSeeking: boolean = false;

  // Buffer playback state (for continuing to schedule from buffer)
  private bufferPlaybackIndex: number = -1; // -1 means not in buffer playback mode
  private bufferScheduleTimer: ReturnType<typeof setTimeout> | null = null;

  // Bound event handlers for cleanup
  private boundOnVideoSeeking: (() => void) | null = null;
  private boundOnVideoSeeked: (() => void) | null = null;

  constructor(config?: PCMAudioPlayerConfig) {
    this.maxBackwardBufferDuration = config?.maxBackwardBufferDuration ?? 180;
    this.minBackwardBufferDuration = config?.minBackwardBufferDuration ?? 120;
    this.bufferSeekEnabled = config?.enableBufferSeek ?? true;
  }

  /**
   * Initialize the audio player
   * Note: On iOS Safari, AudioContext may remain suspended until user interaction
   */
  async init(): Promise<void> {
    if (this.context) {
      return;
    }

    this.context = new AudioContext();
    this.gainNode = this.context.createGain();

    // iOS Silent Mode bypass: route audio through a MediaStream to an <audio> element
    // Audio elements are treated as "media playback" and bypass Silent Mode
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (isIOS) {
      try {
        this.mediaStreamDestination = this.context.createMediaStreamDestination();
        this.gainNode.connect(this.mediaStreamDestination);

        // Create a hidden audio element to play the stream
        this.audioElement = document.createElement('audio');
        this.audioElement.srcObject = this.mediaStreamDestination.stream;
        this.audioElement.autoplay = true;
        // Set playsinline to prevent fullscreen on iOS
        this.audioElement.setAttribute('playsinline', '');
        this.audioElement.setAttribute('webkit-playsinline', '');

        Log.v(TAG, "iOS detected: using MediaStream bypass for Silent Mode");
      } catch (e) {
        Log.w(TAG, "Failed to create MediaStream destination, falling back to default output");
        this.gainNode.connect(this.context.destination);
      }
    } else {
      this.gainNode.connect(this.context.destination);
    }

    this.updateGain();

    // Listen for state changes to handle iOS Safari resume
    this.context.onstatechange = () => {
      Log.v(TAG, `AudioContext state changed to: ${this.context?.state}`);
      if (this.context?.state === "running") {
        // Context resumed, try to schedule any pending chunks
        // Reset base PTS since video may have progressed while suspended
        if (this.pendingChunks.length > 0) {
          this.basePtsEstablished = false;
          this.lastScheduledEndTime = 0;
          this.scheduleChunks();
        }
      }
    };

    // Try to resume context (may fail on iOS Safari if not in user interaction)
    if (this.context.state === "suspended") {
      try {
        await this.context.resume();
      } catch (e) {
        Log.w(TAG, "Failed to resume AudioContext, will retry on user interaction");
      }
    }

    Log.v(TAG, `AudioContext initialized, sampleRate: ${this.context.sampleRate}, state: ${this.context.state}`);
  }

  /**
   * Attach video element for audio/video sync
   */
  attachVideo(video: HTMLVideoElement): void {
    this.videoElement = video;

    // Add seek event listeners for buffer seek support
    if (this.bufferSeekEnabled) {
      this.boundOnVideoSeeking = this.onVideoSeeking.bind(this);
      this.boundOnVideoSeeked = this.onVideoSeeked.bind(this);
      video.addEventListener('seeking', this.boundOnVideoSeeking);
      video.addEventListener('seeked', this.boundOnVideoSeeked);
    }
  }

  /**
   * Detach video element
   */
  detachVideo(): void {
    // Remove seek event listeners
    if (this.videoElement && this.bufferSeekEnabled) {
      if (this.boundOnVideoSeeking) {
        this.videoElement.removeEventListener('seeking', this.boundOnVideoSeeking);
      }
      if (this.boundOnVideoSeeked) {
        this.videoElement.removeEventListener('seeked', this.boundOnVideoSeeked);
      }
    }
    this.boundOnVideoSeeking = null;
    this.boundOnVideoSeeked = null;
    this.videoElement = null;
  }

  /**
   * Feed decoded PCM audio data
   *
   * @param samples - Interleaved PCM samples (Float32)
   * @param channels - Number of audio channels
   * @param sampleRate - Sample rate in Hz
   * @param pts - Presentation timestamp in seconds
   */
  feed(
    samples: Float32Array,
    channels: number,
    sampleRate: number,
    pts: number,
  ): void {
    if (!this.context || !this.gainNode) {
      Log.w(TAG, "AudioContext not initialized, dropping audio");
      return;
    }

    // Calculate duration for buffering
    const samplesPerChannel = Math.floor(samples.length / channels);
    const duration = samplesPerChannel / sampleRate;

    // Always add to buffer (even when paused) for seek support
    if (this.bufferSeekEnabled) {
      const bufferedChunk: BufferedAudioChunk = {
        samples,
        channels,
        sampleRate,
        pts,
        duration,
        endPts: pts + duration,
      };
      this.insertToBuffer(bufferedChunk);
      this.cleanupBuffer();
    }

    // Only schedule if not paused, not seeking, and not in buffer playback mode
    // When in buffer playback mode, audio is being scheduled from buffer, not from feed()
    if (!this.isPaused && !this.isSeeking && this.bufferPlaybackIndex < 0) {
      this.pendingChunks.push({ samples, channels, sampleRate, pts });
      this.scheduleChunks();
    }
  }

  /**
   * Schedule pending audio chunks for playback
   * Uses drift-based scheduling to maintain audio/video sync
   */
  private scheduleChunks(): void {
    if (!this.context || !this.gainNode || this.pendingChunks.length === 0) {
      return;
    }

    // Ensure AudioContext is running (iOS Safari may keep it suspended)
    if (this.context.state === "suspended") {
      // Try to resume - this will succeed if called from user interaction
      this.context.resume().catch(() => {
        // Ignore errors, will retry on next scheduleChunks call
      });
      return; // Don't schedule chunks while suspended
    }

    const ctxTime = this.context.currentTime;
    const videoTime = this.videoElement?.currentTime ?? 0;

    // Establish base PTS offset on first chunk when video is ready
    if (!this.basePtsEstablished && this.videoElement && this.videoElement.readyState >= 2) {
      const firstChunk = this.pendingChunks[0];
      // basePtsOffset = audioPTS - videoPTS
      // This maps audio PTS to video timeline
      this.basePtsOffset = firstChunk.pts - videoTime;
      this.basePtsEstablished = true;
      this.isPlaying = true;
      Log.v(TAG, `Base PTS offset established: ${this.basePtsOffset.toFixed(3)}s (audioPTS=${firstChunk.pts.toFixed(3)}, videoTime=${videoTime.toFixed(3)})`);
    }

    // If base PTS not established yet, wait
    if (!this.basePtsEstablished) {
      return;
    }

    // Schedule chunks using drift-based scheduling
    while (this.pendingChunks.length > 0) {
      const chunk = this.pendingChunks[0];

      // Calculate schedule time based on drift from video
      const audioVideoTime = chunk.pts - this.basePtsOffset;
      const drift = audioVideoTime - videoTime;
      let scheduleTime = ctxTime + drift;

      // Ensure continuous playback (no gaps between chunks)
      if (this.lastScheduledEndTime > 0) {
        const gap = scheduleTime - this.lastScheduledEndTime;
        if (gap < 0 && gap > -0.05) {
          // Small overlap (<50ms), use lastScheduledEndTime for continuity
          scheduleTime = this.lastScheduledEndTime;
        } else if (gap < -0.05) {
          // Larger overlap, timing is off, reset
          this.lastScheduledEndTime = 0;
        }
      }

      // If audio is too far behind (schedule time is in the past), drop the chunk
      if (scheduleTime < ctxTime - 0.01) {
        const dropped = this.pendingChunks.shift();
        this.chunksDropped++;
        Log.v(TAG, `Dropping late chunk: pts=${dropped!.pts.toFixed(3)}, scheduleTime=${scheduleTime.toFixed(3)}, ctxTime=${ctxTime.toFixed(3)}, drift=${drift.toFixed(3)}`);
        continue;
      }

      // If audio is too far ahead, wait for video to catch up
      if (scheduleTime > ctxTime + 5.0) {
        break;
      }

      // Schedule the chunk
      this.pendingChunks.shift();
      const actualScheduleTime = Math.max(scheduleTime, ctxTime);
      const duration = this.scheduleChunk(chunk, actualScheduleTime);

      // Update last scheduled end time for continuous playback
      this.lastScheduledEndTime = actualScheduleTime + duration;
    }

    // Limit pending chunks to prevent memory accumulation
    // This can happen if basePtsEstablished never becomes true
    if (this.pendingChunks.length > 200) {
      Log.w(TAG, `Pending chunks overflow (${this.pendingChunks.length}), clearing stale chunks`);
      // Keep only recent chunks
      this.pendingChunks = this.pendingChunks.slice(-50);
    }
  }

  /**
   * Schedule a single audio chunk
   * Returns the duration of the scheduled chunk
   */
  private scheduleChunk(chunk: AudioChunk, startTime: number): number {
    if (!this.context || !this.gainNode) {
      return 0;
    }

    const { samples, channels, sampleRate } = chunk;
    const samplesPerChannel = Math.floor(samples.length / channels);

    // Create audio buffer
    const buffer = this.context.createBuffer(channels, samplesPerChannel, sampleRate);

    // Deinterleave samples into channels
    for (let ch = 0; ch < channels; ch++) {
      const channelData = buffer.getChannelData(ch);
      for (let i = 0; i < samplesPerChannel; i++) {
        channelData[i] = samples[i * channels + ch];
      }
    }

    // Create buffer source
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    source.start(startTime);

    // Track scheduled source for cancellation
    const endTime = startTime + buffer.duration;
    this.scheduledSources.push({
      source,
      startTime,
      endTime,
      chunkPts: chunk.pts,
    });

    // Cleanup completed sources periodically
    this.cleanupCompletedSources();

    this.chunksScheduled++;
    this.samplesPlayed += samplesPerChannel;

    return buffer.duration;
  }

  // ==================== Buffer Management Methods ====================

  /**
   * Insert a chunk into the audio buffer maintaining sorted order by PTS
   */
  private insertToBuffer(chunk: BufferedAudioChunk): void {
    // Binary search for insertion point
    let low = 0;
    let high = this.audioBuffer.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.audioBuffer[mid].pts < chunk.pts) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    // Check for duplicate (same PTS within 1ms tolerance)
    if (low < this.audioBuffer.length &&
        Math.abs(this.audioBuffer[low].pts - chunk.pts) < 0.001) {
      // Replace existing chunk at same PTS
      this.audioBuffer[low] = chunk;
    } else {
      // Insert at sorted position
      this.audioBuffer.splice(low, 0, chunk);
    }
  }

  /**
   * Cleanup old audio chunks based on buffer size
   * Uses maxBackwardBufferDuration to limit total buffer size
   */
  private cleanupBuffer(): void {
    if (this.audioBuffer.length === 0) {
      return;
    }

    // Calculate total buffer duration
    const first = this.audioBuffer[0];
    const last = this.audioBuffer[this.audioBuffer.length - 1];
    const totalDuration = last.endPts - first.pts;

    // If buffer exceeds max duration, remove oldest chunks
    if (totalDuration > this.maxBackwardBufferDuration) {
      const targetDuration = this.minBackwardBufferDuration;
      const cutoffPts = last.endPts - targetDuration;

      let removeCount = 0;
      for (let i = 0; i < this.audioBuffer.length; i++) {
        if (this.audioBuffer[i].endPts < cutoffPts) {
          removeCount++;
        } else {
          break;
        }
      }

      if (removeCount > 0) {
        Log.v(TAG, `Buffer cleanup: removing ${removeCount} chunks, duration ${totalDuration.toFixed(1)}s -> ${(totalDuration - (cutoffPts - first.pts)).toFixed(1)}s`);
        this.audioBuffer.splice(0, removeCount);
      }
    }
  }

  /**
   * Find the index of the chunk containing the target time
   * Returns -1 if not found
   */
  private findChunkIndexByTime(targetTime: number): number {
    if (this.audioBuffer.length === 0) {
      return -1;
    }

    // Binary search for chunk containing targetTime
    let low = 0;
    let high = this.audioBuffer.length - 1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const chunk = this.audioBuffer[mid];

      if (targetTime >= chunk.pts && targetTime < chunk.endPts) {
        // Found chunk containing target time
        return mid;
      } else if (targetTime < chunk.pts) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    // If not found exactly, return the chunk just before targetTime
    // low now points to first chunk with pts > targetTime
    if (low > 0) {
      return low - 1;
    }

    return low < this.audioBuffer.length ? low : -1;
  }

  /**
   * Check if the target time is within a buffered chunk (not in a gap)
   */
  private isTimeBuffered(time: number): boolean {
    if (this.audioBuffer.length === 0) {
      return false;
    }

    const index = this.findChunkIndexByTime(time);
    if (index < 0) {
      return false;
    }

    // Verify the chunk actually contains the time (not in a gap)
    const chunk = this.audioBuffer[index];
    return time >= chunk.pts && time < chunk.endPts;
  }

  /**
   * Get the buffered time range
   */
  getBufferRange(): { start: number; end: number } | null {
    if (this.audioBuffer.length === 0) {
      return null;
    }

    return {
      start: this.audioBuffer[0].pts,
      end: this.audioBuffer[this.audioBuffer.length - 1].endPts,
    };
  }

  // ==================== Source Tracking Methods ====================

  /**
   * Cancel all scheduled audio sources
   */
  private cancelScheduledAudio(): void {
    for (const scheduled of this.scheduledSources) {
      try {
        scheduled.source.stop();
        scheduled.source.disconnect();
      } catch (e) {
        // Source may already be stopped, ignore
      }
    }
    this.scheduledSources = [];
    this.lastScheduledEndTime = 0;
  }

  /**
   * Cleanup completed audio sources (those that have finished playing)
   */
  private cleanupCompletedSources(): void {
    if (!this.context) return;

    const ctxTime = this.context.currentTime;

    // Remove sources that have finished playing (with small buffer for safety)
    this.scheduledSources = this.scheduledSources.filter(scheduled => {
      if (scheduled.endTime < ctxTime - 0.1) {
        // Already finished playing
        try {
          scheduled.source.disconnect();
        } catch (e) {}
        return false;
      }
      return true;
    });
  }

  // ==================== Seek Event Handlers ====================

  /**
   * Handle video seeking event
   */
  private onVideoSeeking(): void {
    Log.v(TAG, 'Video seeking, canceling scheduled audio');
    this.isSeeking = true;
    this.stopBufferScheduleTimer();
    this.bufferPlaybackIndex = -1;
    this.cancelScheduledAudio();
    this.pendingChunks = [];
  }

  /**
   * Handle video seeked event
   */
  private onVideoSeeked(): void {
    if (!this.videoElement) return;

    const targetTime = this.videoElement.currentTime;
    Log.v(TAG, `Video seeked to ${targetTime.toFixed(3)}`);

    this.isSeeking = false;
    this.seekToTime(targetTime);
  }

  /**
   * Seek to a specific time from buffer or wait for new data
   */
  seekToTime(targetTime: number): void {
    // Stop buffer playback timer
    this.stopBufferScheduleTimer();
    this.bufferPlaybackIndex = -1;

    // Cancel any currently scheduled audio
    this.cancelScheduledAudio();
    this.pendingChunks = [];

    // Reset timing state (but keep basePtsOffset for time conversion)
    this.basePtsEstablished = false;
    this.lastScheduledEndTime = 0;

    // Convert video time to audio PTS for buffer lookup
    // audioPTS = videoTime + basePtsOffset
    const audioPtsTarget = targetTime + this.basePtsOffset;

    // Check if target time is in buffer (using audio PTS)
    if (this.bufferSeekEnabled && this.basePtsOffset !== 0 && this.isTimeBuffered(audioPtsTarget)) {
      const startIndex = this.findChunkIndexByTime(audioPtsTarget);

      if (startIndex >= 0) {
        Log.v(TAG, `Seek to buffered position: videoTime=${targetTime.toFixed(3)}, audioPts=${audioPtsTarget.toFixed(3)}, chunk ${startIndex}`);
        this.scheduleFromBuffer(startIndex, targetTime);
        return;
      }
    }

    // Target time not in buffer - reset basePtsOffset and wait for new data
    Log.v(TAG, `Seek target ${targetTime.toFixed(3)} (audioPts=${audioPtsTarget.toFixed(3)}) not in buffer, waiting for new data`);
    this.basePtsOffset = 0;
    // New chunks will arrive via feed() and be scheduled normally
  }

  /**
   * Schedule audio from buffer starting at a specific index
   */
  private scheduleFromBuffer(startIndex: number, targetTime: number): void {
    if (!this.context || !this.gainNode || this.audioBuffer.length === 0) {
      return;
    }

    const ctxTime = this.context.currentTime;
    const firstChunk = this.audioBuffer[startIndex];

    // Use existing basePtsOffset for time conversion (don't recalculate)
    // basePtsOffset was established when audio first started playing
    this.basePtsEstablished = true;
    this.isPlaying = true;

    // Calculate offset within first chunk using audio PTS
    // audioPtsTarget is the audio PTS corresponding to the video seek target
    const audioPtsTarget = targetTime + this.basePtsOffset;
    const offsetInChunk = Math.max(0, audioPtsTarget - firstChunk.pts);

    // Schedule chunks from buffer (up to 10 seconds ahead)
    let scheduleTime = ctxTime;
    let lastScheduledIndex = startIndex;
    let lastChunkEndPts = 0;

    for (let i = startIndex; i < this.audioBuffer.length; i++) {
      const chunk = this.audioBuffer[i];

      // Check for PTS gap (> 1 second gap means non-contiguous audio)
      if (lastChunkEndPts > 0 && chunk.pts - lastChunkEndPts > 1.0) {
        Log.v(TAG, `Buffer scheduling stopped - PTS gap detected: expected ${lastChunkEndPts.toFixed(3)}, got ${chunk.pts.toFixed(3)}`);
        break;
      }

      // Schedule up to 10 seconds ahead
      if (scheduleTime > ctxTime + 10.0) {
        break;
      }

      // For first chunk, may need to skip some samples
      let samplesToSkip = 0;
      if (i === startIndex && offsetInChunk > 0) {
        samplesToSkip = Math.floor(offsetInChunk * chunk.sampleRate);
      }

      // Schedule the chunk (possibly partial for first chunk)
      const duration = this.scheduleBufferedChunk(chunk, scheduleTime, samplesToSkip);
      scheduleTime += duration;
      lastScheduledIndex = i;
      lastChunkEndPts = chunk.endPts;
    }

    this.lastScheduledEndTime = scheduleTime;
    this.bufferPlaybackIndex = lastScheduledIndex + 1;

    Log.v(TAG, `Scheduled from buffer: lastScheduledEndTime=${scheduleTime.toFixed(3)}, nextIndex=${this.bufferPlaybackIndex}`);

    // Start timer to continue scheduling from buffer
    this.startBufferScheduleTimer();
  }

  /**
   * Start timer to continue scheduling from buffer
   */
  private startBufferScheduleTimer(): void {
    this.stopBufferScheduleTimer();

    // Schedule more from buffer every 3 seconds
    this.bufferScheduleTimer = setTimeout(() => {
      this.continueSchedulingFromBuffer();
    }, 3000);
  }

  /**
   * Stop buffer schedule timer
   */
  private stopBufferScheduleTimer(): void {
    if (this.bufferScheduleTimer) {
      clearTimeout(this.bufferScheduleTimer);
      this.bufferScheduleTimer = null;
    }
  }

  /**
   * Continue scheduling audio from buffer
   */
  private continueSchedulingFromBuffer(): void {
    if (!this.context || !this.gainNode || this.isPaused || this.isSeeking) {
      return;
    }

    // Not in buffer playback mode
    if (this.bufferPlaybackIndex < 0 || this.bufferPlaybackIndex >= this.audioBuffer.length) {
      this.bufferPlaybackIndex = -1;
      Log.v(TAG, 'Buffer playback ended - no more buffered audio');
      return;
    }

    // Don't schedule if video is paused or stalled
    if (this.videoElement && (this.videoElement.paused || this.videoElement.readyState < 3)) {
      this.startBufferScheduleTimer(); // Retry later
      return;
    }

    const ctxTime = this.context.currentTime;
    const videoTime = this.videoElement?.currentTime ?? 0;

    // Check for drift between scheduled audio and video position
    // This prevents audio from drifting out of sync during continuous playback
    if (this.lastScheduledEndTime > ctxTime) {
      const scheduledAhead = this.lastScheduledEndTime - ctxTime;
      const expectedVideoTime = videoTime + scheduledAhead;
      const expectedAudioPts = expectedVideoTime + this.basePtsOffset;

      const nextChunk = this.audioBuffer[this.bufferPlaybackIndex];
      if (nextChunk) {
        const ptsDrift = nextChunk.pts - expectedAudioPts;
        if (Math.abs(ptsDrift) > 0.5) {  // > 500ms drift
          Log.v(TAG, `Buffer playback drift detected: ${ptsDrift.toFixed(3)}s, resyncing`);
          this.cancelScheduledAudio();
          this.seekToTime(videoTime);
          return;
        }
      }
    }

    // Only schedule more if we're running low on scheduled audio
    if (this.lastScheduledEndTime > ctxTime + 5.0) {
      // Still have enough scheduled, check again later
      this.startBufferScheduleTimer();
      return;
    }

    // Get the last scheduled chunk's end PTS to detect gaps
    const prevChunk = this.audioBuffer[this.bufferPlaybackIndex - 1];
    let lastChunkEndPts = prevChunk ? prevChunk.endPts : 0;

    // Schedule more chunks from buffer
    let scheduleTime = Math.max(this.lastScheduledEndTime, ctxTime);
    let scheduledCount = 0;

    for (let i = this.bufferPlaybackIndex; i < this.audioBuffer.length; i++) {
      const chunk = this.audioBuffer[i];

      // Check for PTS gap (> 1 second gap means we've hit live edge audio)
      if (lastChunkEndPts > 0 && chunk.pts - lastChunkEndPts > 1.0) {
        Log.v(TAG, `Buffer playback stopped - PTS gap detected: expected ${lastChunkEndPts.toFixed(3)}, got ${chunk.pts.toFixed(3)}`);
        this.bufferPlaybackIndex = -1;
        return;
      }

      // Schedule up to 10 seconds ahead
      if (scheduleTime > ctxTime + 10.0) {
        break;
      }

      const duration = this.scheduleBufferedChunk(chunk, scheduleTime, 0);
      scheduleTime += duration;
      this.bufferPlaybackIndex = i + 1;
      lastChunkEndPts = chunk.endPts;
      scheduledCount++;
    }

    if (scheduledCount > 0) {
      this.lastScheduledEndTime = scheduleTime;
      Log.v(TAG, `Continued buffer playback: scheduled ${scheduledCount} chunks, nextIndex=${this.bufferPlaybackIndex}`);
    }

    // Check if we've reached the end of buffer
    if (this.bufferPlaybackIndex >= this.audioBuffer.length) {
      Log.v(TAG, 'Buffer playback complete - reached end of buffer');
      this.bufferPlaybackIndex = -1;
      return;
    }

    // Continue timer
    this.startBufferScheduleTimer();
  }

  /**
   * Schedule a single buffered chunk for playback
   */
  private scheduleBufferedChunk(
    chunk: BufferedAudioChunk,
    startTime: number,
    samplesToSkip: number = 0
  ): number {
    if (!this.context || !this.gainNode) {
      return 0;
    }

    const { samples, channels, sampleRate } = chunk;
    const totalSamplesPerChannel = Math.floor(samples.length / channels);
    const samplesPerChannel = totalSamplesPerChannel - samplesToSkip;

    if (samplesPerChannel <= 0) {
      return 0;
    }

    // Create audio buffer
    const buffer = this.context.createBuffer(channels, samplesPerChannel, sampleRate);

    // Deinterleave samples into channels, skipping initial samples if needed
    for (let ch = 0; ch < channels; ch++) {
      const channelData = buffer.getChannelData(ch);
      for (let i = 0; i < samplesPerChannel; i++) {
        const sourceIndex = (i + samplesToSkip) * channels + ch;
        channelData[i] = samples[sourceIndex];
      }
    }

    // Create buffer source
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    source.start(startTime);

    // Track scheduled source
    const endTime = startTime + buffer.duration;
    this.scheduledSources.push({
      source,
      startTime,
      endTime,
      chunkPts: chunk.pts,
    });

    return buffer.duration;
  }

  /**
   * Start or resume playback
   * This should be called from a user interaction event handler on iOS Safari
   */
  async play(): Promise<void> {
    this.isPaused = false;

    if (this.context?.state === "suspended") {
      try {
        await this.context.resume();
        Log.v(TAG, `AudioContext resumed, state: ${this.context.state}`);
      } catch (e) {
        Log.w(TAG, "Failed to resume AudioContext on play()");
      }
    }

    // Also play the hidden audio element (needed for iOS Silent Mode bypass)
    if (this.audioElement) {
      try {
        await this.audioElement.play();
      } catch (e) {
        Log.w(TAG, "Failed to play audio element");
      }
    }

    // Clear stale state and reset timing for resync
    this.pendingChunks = [];
    this.lastScheduledEndTime = 0;
    this.basePtsEstablished = false;

    Log.v(TAG, `play() called, resyncing from video position`);

    // Resync from current video position using buffer if available
    if (this.videoElement && this.basePtsOffset !== 0) {
      this.seekToTime(this.videoElement.currentTime);
    }
    // Otherwise, new chunks will arrive via feed() and establish sync
  }

  /**
   * Pause playback
   */
  pause(): void {
    this.isPaused = true;
    Log.v(TAG, `pause() called, pending chunks: ${this.pendingChunks.length}`);

    // Stop buffer playback timer
    this.stopBufferScheduleTimer();

    // Cancel all scheduled audio to prevent desync on resume
    this.cancelScheduledAudio();
    this.pendingChunks = [];

    // Suspend AudioContext
    if (this.context && this.context.state === "running") {
      this.context.suspend().catch(() => {
        // Ignore errors
      });
    }

    // Pause the hidden audio element
    if (this.audioElement) {
      this.audioElement.pause();
    }
  }

  /**
   * Stop playback and clear buffers
   */
  stop(): void {
    // Stop buffer playback timer
    this.stopBufferScheduleTimer();
    this.bufferPlaybackIndex = -1;

    // Cancel all scheduled audio
    this.cancelScheduledAudio();

    this.pendingChunks = [];
    this.audioBuffer = [];  // Clear buffer on stop
    this.isPlaying = false;
    this.isPaused = false;
    this.isSeeking = false;
    this.lastScheduledEndTime = 0;
    this.basePtsEstablished = false;
    this.basePtsOffset = 0;
    this.samplesPlayed = 0;
    this.chunksScheduled = 0;
    this.chunksDropped = 0;
  }

  /**
   * Flush pending audio and reset timing
   * Note: audioBuffer and basePtsOffset are NOT cleared to support seek
   */
  flush(): void {
    // Stop buffer playback timer
    this.stopBufferScheduleTimer();
    this.bufferPlaybackIndex = -1;

    // Cancel scheduled audio
    this.cancelScheduledAudio();

    this.pendingChunks = [];
    this.isPlaying = false;
    this.lastScheduledEndTime = 0;
    this.basePtsEstablished = false;
    // Note: basePtsOffset is retained for buffer seek time conversion
    // Note: audioBuffer is retained for seek support
  }

  /**
   * Set volume (0.0 to 1.0)
   */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.updateGain();
  }

  /**
   * Get current volume
   */
  getVolume(): number {
    return this.volume;
  }

  /**
   * Set muted state
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.updateGain();
  }

  /**
   * Get muted state
   */
  isMuted(): boolean {
    return this.muted;
  }

  /**
   * Update gain node value
   */
  private updateGain(): void {
    if (this.gainNode) {
      this.gainNode.gain.value = this.muted ? 0 : this.volume;
    }
    // Also update the hidden audio element volume (for iOS)
    if (this.audioElement) {
      this.audioElement.volume = this.muted ? 0 : this.volume;
    }
  }

  /**
   * Get audio context sample rate
   */
  getSampleRate(): number {
    return this.context?.sampleRate ?? 0;
  }

  /**
   * Get playback statistics
   */
  getStats(): {
    samplesPlayed: number;
    chunksScheduled: number;
    chunksDropped: number;
    pendingChunks: number;
    bufferedChunks: number;
    bufferRange: { start: number; end: number } | null;
    scheduledSources: number;
    isPlaying: boolean;
    isSeeking: boolean;
    contextState: AudioContextState | null;
  } {
    return {
      samplesPlayed: this.samplesPlayed,
      chunksScheduled: this.chunksScheduled,
      chunksDropped: this.chunksDropped,
      pendingChunks: this.pendingChunks.length,
      bufferedChunks: this.audioBuffer.length,
      bufferRange: this.getBufferRange(),
      scheduledSources: this.scheduledSources.length,
      isPlaying: this.isPlaying,
      isSeeking: this.isSeeking,
      contextState: this.context?.state ?? null,
    };
  }

  /**
   * Destroy player and release resources
   */
  async destroy(): Promise<void> {
    this.stop();
    this.detachVideo();

    // Clean up iOS Silent Mode bypass audio element
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }

    if (this.mediaStreamDestination) {
      this.mediaStreamDestination.disconnect();
      this.mediaStreamDestination = null;
    }

    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }

    if (this.context) {
      this.context.onstatechange = null;
      await this.context.close();
      this.context = null;
    }
  }
}
