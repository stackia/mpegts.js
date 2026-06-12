import type { PlayerConfig } from "../config";
import { createDefaultConfig } from "../config";
import MediaInfo from "../core/media-info";
import { WorkerAudioDecoder } from "../decoder/worker-audio-decoder";
import DemuxErrors from "../demux/demux-errors";
import TSDemuxer from "../demux/ts-demuxer";
import { parseM3U8 } from "../hls/m3u8-parser";
import FetchLoader from "../io/fetch-loader";
import MP4Remuxer from "../remux/mp4-remuxer";
import type { PlayerSegment } from "../types";
import Log from "../utils/logger";

export interface PipelineCallbacks {
	onInitSegment: (
		type: string,
		initSegment: {
			type: string;
			container: string;
			codec?: string;
			data?: ArrayBuffer;
			[key: string]: unknown;
		},
	) => void;
	onMediaSegment: (
		type: string,
		mediaSegment: {
			type: string;
			data?: ArrayBuffer;
			[key: string]: unknown;
		},
	) => void;
	onLoadingComplete: () => void;
	onMediaInfo: (mediaInfo: unknown) => void;
	onIOError: (type: string, info: { code: number; msg: string }) => void;
	onDemuxError: (type: string, info: string) => void;
	onPCMAudioData: (pcm: Float32Array, channels: number, sampleRate: number, pts: number) => void;
}

interface InternalSegment {
	duration: number;
	url: string;
	timestampBase: number;
	cors: boolean;
	withCredentials: boolean;
	referrerPolicy?: ReferrerPolicy;
}

class Pipeline {
	private readonly TAG = "Pipeline";

	private _config: PlayerConfig;
	private _callbacks: PipelineCallbacks;

	private _segments: InternalSegment[];
	private _currentSegmentIndex: number;

	private _mediaInfo: MediaInfo | null;
	private _demuxer: TSDemuxer | null;
	private _remuxer: MP4Remuxer | null;
	private _ioctl: FetchLoader | null;
	private _workerAudioDecoder: WorkerAudioDecoder | null = null;
	private _workerAudioDecoderInitPromise: Promise<boolean> | null = null;

	// HLS state
	private _isHLS = false;
	private _hlsLive = false;
	private _hlsManifestURL = "";
	private _hlsTargetDuration = 0;
	private _hlsNextSequence = 0;
	private _hlsPollTimer: ReturnType<typeof setTimeout> | null = null;
	private _hlsWaiting = false;
	private _hlsCors = true;
	private _hlsCredentials = false;
	private _hlsReferrerPolicy?: ReferrerPolicy;

	constructor(segments: PlayerSegment[], config: PlayerConfig, callbacks: PipelineCallbacks) {
		this._callbacks = callbacks;
		this._config = { ...createDefaultConfig(), ...config };

		this._segments = this._buildSegments(segments);
		this._currentSegmentIndex = 0;

		this._mediaInfo = null;
		this._demuxer = null;
		this._remuxer = null;
		this._ioctl = null;
	}

	private _buildSegments(playerSegments: PlayerSegment[]): InternalSegment[] {
		let totalDuration = 0;
		const segments: InternalSegment[] = playerSegments.map((seg) => {
			const duration = seg.duration ?? 0;
			const internal: InternalSegment = {
				duration,
				url: seg.url,
				timestampBase: totalDuration,
				cors: true,
				withCredentials: false,
			};
			if (this._config.referrerPolicy) {
				internal.referrerPolicy = this._config.referrerPolicy as ReferrerPolicy;
			}
			totalDuration += duration;
			return internal;
		});
		return segments;
	}

	start(): void {
		this._loadSegment(0);
	}

	stop(): void {
		this._stopHLSPoll();
		this._internalAbort();
	}

	pause(): void {
		if (this._ioctl?.isWorking()) {
			this._ioctl.pause();
		}
	}

	resume(): void {
		if (this._ioctl?.isPaused()) {
			this._ioctl.resume();
		}
	}

	loadSegments(newSegments: PlayerSegment[]): void {
		// Stop current loading
		this._stopHLSPoll();
		this._internalAbort();

		// Reset HLS state
		this._isHLS = false;
		this._hlsLive = false;
		this._hlsManifestURL = "";
		this._hlsTargetDuration = 0;
		this._hlsNextSequence = 0;
		this._hlsWaiting = false;

		// Reset internal state
		this._mediaInfo = null;

		// Setup new segments
		this._segments = this._buildSegments(newSegments);
		this._currentSegmentIndex = 0;

		// Destroy demuxer and remuxer for clean state (handles codec/container changes)
		this._resetDemuxPipeline();

		// Start from segment 0 — will re-probe format and recreate demuxer+remuxer
		this._loadSegment(0);
	}

	seek(seconds: number): boolean {
		if (!this._isHLS) return false;

		let accum = 0;
		let targetIndex = 0;
		for (let i = 0; i < this._segments.length; i++) {
			if (accum + this._segments[i].duration > seconds) {
				targetIndex = i;
				break;
			}
			accum += this._segments[i].duration;
			if (i === this._segments.length - 1) {
				targetIndex = i;
			}
		}

		this._internalAbort();
		this._hlsWaiting = false;
		this._resetDemuxPipeline();

		this._loadSegment(targetIndex);
		return true;
	}

	destroy(): void {
		this._stopHLSPoll();
		this._mediaInfo = null;

		if (this._ioctl) {
			this._ioctl.destroy();
			this._ioctl = null;
		}
		if (this._demuxer) {
			this._demuxer.destroy();
			this._demuxer = null;
		}
		if (this._remuxer) {
			this._remuxer.destroy();
			this._remuxer = null;
		}
		if (this._workerAudioDecoder) {
			this._workerAudioDecoder.destroy();
			this._workerAudioDecoder = null;
		}
		this._workerAudioDecoderInitPromise = null;
	}

	// ---- Private methods ----

	private _loadSegment(segmentIndex: number): void {
		this._currentSegmentIndex = segmentIndex;
		const segment = this._segments[segmentIndex];

		const dataSource = {
			url: segment.url,
			cors: segment.cors,
			withCredentials: segment.withCredentials,
			referrerPolicy: segment.referrerPolicy,
		};

		const ioctl = new FetchLoader(dataSource, this._config, segmentIndex);
		this._ioctl = ioctl;

		ioctl.onError = this._onIOException.bind(this);
		ioctl.onSeeked = this._onIOSeeked.bind(this);
		ioctl.onComplete = this._onIOComplete.bind(this) as (extraData: unknown) => void;
		ioctl.onHLSManifest = (text, resolvedURL) => {
			this._handleHLSManifest(text, resolvedURL, segment);
		};

		ioctl.onDataArrival = this._onInitChunkArrival.bind(this);
		ioctl.open();
	}

	private _resetDemuxPipeline(): void {
		if (this._demuxer) {
			this._demuxer.destroy();
			this._demuxer = null;
		}
		if (this._remuxer) {
			this._remuxer.destroy();
			this._remuxer = null;
		}
		this._workerAudioDecoder?.reset();
	}

	private _hlsSegment(seg: { url: string; duration: number }): InternalSegment {
		return {
			duration: seg.duration,
			url: seg.url,
			timestampBase: 0,
			cors: this._hlsCors,
			withCredentials: this._hlsCredentials,
			referrerPolicy: this._hlsReferrerPolicy,
		};
	}

	private _internalAbort(): void {
		if (this._ioctl) {
			this._ioctl.destroy();
			this._ioctl = null;
		}
	}

	private _onInitChunkArrival(data: ArrayBuffer, byteStart: number): number {
		const probeData = TSDemuxer.probe(data);

		if (!(probeData as Record<string, unknown>).match) {
			if (!(probeData as Record<string, unknown>).needMoreData) {
				Log.e(this.TAG, "Non MPEG-TS, Unsupported media type!");
				Promise.resolve().then(() => {
					this._internalAbort();
				});
				this._callbacks.onDemuxError(DemuxErrors.FORMAT_UNSUPPORTED, "Non MPEG-TS, Unsupported media type!");
			}
			return 0;
		}

		this._setupTSDemuxerRemuxer(probeData);

		// Set timestampBase for multi-segment time continuity
		const segment = this._segments[this._currentSegmentIndex];
		if (segment && this._demuxer) {
			this._demuxer.timestampBase = segment.timestampBase * 90000; // seconds → 90kHz ticks
		}

		// Switch from probe handler to direct demuxer parsing for subsequent chunks
		if (this._ioctl && this._demuxer) {
			(this._ioctl as unknown as Record<string, unknown>).onDataArrival = this._demuxer.parseChunks.bind(this._demuxer);
		}

		return this._demuxer?.parseChunks(data, byteStart) ?? 0;
	}

	private _setupTSDemuxerRemuxer(probeData: unknown): void {
		if (this._demuxer) {
			this._demuxer.destroy();
		}
		const demuxer = new TSDemuxer(probeData as Record<string, unknown>, this._config);
		this._demuxer = demuxer;

		if (!this._remuxer) {
			this._remuxer = new MP4Remuxer(this._config);
		}

		demuxer.onError = this._onDemuxException.bind(this);
		demuxer.onMediaInfo = this._onMediaInfo.bind(this);

		// Metadata event callbacks: ignored (not forwarded to web-ui)
		demuxer.onTimedID3Metadata = () => {};
		demuxer.onPGSSubtitleData = () => {};
		demuxer.onSynchronousKLVMetadata = () => {};
		demuxer.onAsynchronousKLVMetadata = () => {};
		demuxer.onSMPTE2038Metadata = () => {};
		demuxer.onSCTE35Metadata = () => {};
		demuxer.onPESPrivateDataDescriptor = () => {};
		demuxer.onPESPrivateData = () => {};

		// Set up software audio decode callback when MP2 WASM URL is configured
		if (this._config.wasmDecoders.mp2) {
			demuxer.onRawAudioData = (frame) => {
				this._handleRawAudioFrame(frame);
			};
		}

		(this._remuxer as MP4Remuxer).bindDataSource(
			this._demuxer as unknown as {
				onDataAvailable: (...args: unknown[]) => void;
				onTrackMetadata: (...args: unknown[]) => void;
			},
		);
		(this._demuxer as TSDemuxer).bindDataSource(this._ioctl as unknown as Record<string, unknown>);

		this._remuxer.onInitSegment = this._onRemuxerInitSegmentArrival.bind(this);
		this._remuxer.onMediaSegment = this._onRemuxerMediaSegmentArrival.bind(
			this,
		) as unknown as typeof this._remuxer.onMediaSegment;
	}

	private _onMediaInfo(mediaInfo: MediaInfo): void {
		if (this._mediaInfo == null) {
			// Store first segment's mediainfo as global mediaInfo
			this._mediaInfo = Object.assign({}, mediaInfo) as MediaInfo;
			this._mediaInfo.segments = [];
			this._mediaInfo.segmentCount = this._segments.length;
			Object.setPrototypeOf(this._mediaInfo, MediaInfo.prototype);
		}

		const segmentInfo = Object.assign({}, mediaInfo) as MediaInfo;
		Object.setPrototypeOf(segmentInfo, MediaInfo.prototype);
		(this._mediaInfo.segments as MediaInfo[])[this._currentSegmentIndex] = segmentInfo;

		// Notify mediaInfo update
		this._reportSegmentMediaInfo(this._currentSegmentIndex);
	}

	private _onIOSeeked(): void {
		(this._remuxer as MP4Remuxer).insertDiscontinuity();
	}

	private _onIOComplete(_extraData: number): void {
		const segmentIndex = this._currentSegmentIndex;
		const nextSegmentIndex = segmentIndex + 1;

		if (nextSegmentIndex < this._segments.length) {
			this._internalAbort();
			if (this._remuxer) {
				this._remuxer.flushStashedSamples();
			}
			this._loadSegment(nextSegmentIndex);
		} else if (this._hlsLive) {
			this._remuxer?.flushStashedSamples();
			this._hlsWaiting = true;
		} else {
			if (this._remuxer) {
				this._remuxer.flushStashedSamples();
			}
			this._callbacks.onLoadingComplete();
		}
	}

	private _onIOException(type: string, info: { code: number; msg: string }): void {
		Log.e(this.TAG, `IOException: type = ${type}, code = ${info.code}, msg = ${info.msg}`);
		this._callbacks.onIOError(type, info);
	}

	private _onDemuxException(type: string, info: string): void {
		Log.e(this.TAG, `DemuxException: type = ${type}, info = ${info}`);
		this._callbacks.onDemuxError(type, info);
	}

	private _onRemuxerInitSegmentArrival(type: string, initSegment: unknown): void {
		this._callbacks.onInitSegment(
			type,
			initSegment as {
				type: string;
				container: string;
				codec?: string;
				data?: ArrayBuffer;
			},
		);
	}

	private _onRemuxerMediaSegmentArrival(type: string, mediaSegment: Record<string, unknown>): void {
		this._callbacks.onMediaSegment(type, mediaSegment as { type: string; data?: ArrayBuffer });
	}

	private _reportSegmentMediaInfo(segmentIndex: number): void {
		const segmentInfo = this._mediaInfo?.segments?.[segmentIndex];
		const exportInfo: Record<string, unknown> = Object.assign({}, segmentInfo) as unknown as Record<string, unknown>;

		exportInfo.duration = this._mediaInfo?.duration;
		exportInfo.segmentCount = this._mediaInfo?.segmentCount;
		delete exportInfo.segments;

		this._callbacks.onMediaInfo(exportInfo);
	}

	// ---- HLS methods ----

	private _handleHLSManifest(text: string, resolvedURL: string, originSegment: InternalSegment): void {
		const playlist = parseM3U8(text, resolvedURL);
		if (!playlist) {
			this._callbacks.onDemuxError(DemuxErrors.FORMAT_UNSUPPORTED, "Invalid M3U8 playlist");
			return;
		}

		this._isHLS = true;
		this._hlsLive = !playlist.ended;
		this._hlsManifestURL = resolvedURL;
		this._hlsTargetDuration = playlist.targetDuration;
		this._hlsCors = originSegment.cors;
		this._hlsCredentials = originSegment.withCredentials;
		this._hlsReferrerPolicy = originSegment.referrerPolicy;

		this._segments = playlist.segments.map((seg) => this._hlsSegment(seg));

		this._hlsNextSequence = playlist.mediaSequence + playlist.segments.length;

		// Destroy the loader that fetched the manifest
		this._internalAbort();

		if (this._hlsLive) {
			this._scheduleHLSPoll();
		}

		if (this._segments.length > 0) {
			this._loadSegment(0);
		}
	}

	private _scheduleHLSPoll(): void {
		if (this._hlsPollTimer) return;
		const interval = Math.max(this._hlsTargetDuration, 1) * 1000;
		this._hlsPollTimer = setTimeout(() => {
			this._hlsPollTimer = null;
			this._pollHLSManifest();
		}, interval);
	}

	private _stopHLSPoll(): void {
		if (this._hlsPollTimer) {
			clearTimeout(this._hlsPollTimer);
			this._hlsPollTimer = null;
		}
	}

	private _pruneOldSegments(): void {
		// Keep at most 2 segments before the current one to limit memory growth
		const keepFrom = Math.max(0, this._currentSegmentIndex - 2);
		if (keepFrom > 0) {
			this._segments.splice(0, keepFrom);
			this._currentSegmentIndex -= keepFrom;
		}
	}

	private _pollHLSManifest(): void {
		const params: RequestInit = {
			method: "GET",
			mode: this._hlsCors ? "cors" : "same-origin",
			cache: "no-cache",
		};
		if (this._hlsCredentials) {
			params.credentials = "include";
		}
		if (this._hlsReferrerPolicy) {
			params.referrerPolicy = this._hlsReferrerPolicy;
		}

		self
			.fetch(this._hlsManifestURL, params)
			.then((res) => res.text())
			.then((text) => {
				if (!this._isHLS) return; // destroyed or reset while fetch was in-flight

				const playlist = parseM3U8(text, this._hlsManifestURL);
				if (!playlist) {
					this._scheduleHLSPoll();
					return;
				}

				const firstNewIndex = this._hlsNextSequence - playlist.mediaSequence;
				if (firstNewIndex < playlist.segments.length) {
					const newSegs = playlist.segments.slice(firstNewIndex);
					for (const seg of newSegs) {
						this._segments.push(this._hlsSegment(seg));
					}
					this._hlsNextSequence = playlist.mediaSequence + playlist.segments.length;

					// Prune old segments to avoid unbounded growth
					this._pruneOldSegments();

					if (this._hlsWaiting) {
						this._hlsWaiting = false;
						const nextIndex = this._currentSegmentIndex + 1;
						if (nextIndex < this._segments.length) {
							this._internalAbort();
							this._loadSegment(nextIndex);
						}
					}
				}

				if (playlist.ended) {
					this._hlsLive = false;
					if (this._hlsWaiting) {
						// Stream ended and we've loaded all segments
						this._hlsWaiting = false;
						this._remuxer?.flushStashedSamples();
						this._callbacks.onLoadingComplete();
					}
				} else {
					this._scheduleHLSPoll();
				}
			})
			.catch(() => {
				if (!this._isHLS) return;
				// Fetch failed, retry on next poll
				this._scheduleHLSPoll();
			});
	}

	private _handleRawAudioFrame(frame: { codec: "mp2"; data: Uint8Array; pts: number }): void {
		// Lazily create WorkerAudioDecoder on first raw audio frame
		if (!this._workerAudioDecoder) {
			const mp2Url = this._config.wasmDecoders.mp2;
			if (!mp2Url) return;
			this._workerAudioDecoder = new WorkerAudioDecoder(mp2Url);
			this._workerAudioDecoderInitPromise = this._workerAudioDecoder.initDecoder();
		}

		// Queue decode after init completes
		this._workerAudioDecoderInitPromise?.then((ready) => {
			if (!ready || !this._workerAudioDecoder) return;

			const result = this._workerAudioDecoder.decode(frame.data, frame.pts);
			if (result) {
				this._callbacks.onPCMAudioData(result.pcm, result.channels, result.sampleRate, result.pts);
			}
		});
	}
}

export default Pipeline;
