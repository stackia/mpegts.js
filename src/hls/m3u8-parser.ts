export interface M3U8Segment {
	url: string;
	duration: number;
}

export interface M3U8Playlist {
	targetDuration: number;
	mediaSequence: number;
	segments: M3U8Segment[];
	ended: boolean;
}

export function parseM3U8(text: string, baseURL: string): M3U8Playlist | null {
	const cleaned = text.replace(/^\uFEFF/, "");
	if (!cleaned.startsWith("#EXTM3U")) {
		return null;
	}

	let targetDuration = 0;
	let mediaSequence = 0;
	let ended = false;
	const segments: M3U8Segment[] = [];
	let pendingDuration = -1;

	const lines = cleaned.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		if (trimmed.startsWith("#EXT-X-TARGETDURATION:")) {
			targetDuration = parseFloat(trimmed.slice("#EXT-X-TARGETDURATION:".length));
		} else if (trimmed.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
			mediaSequence = parseInt(trimmed.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10);
		} else if (trimmed === "#EXT-X-ENDLIST") {
			ended = true;
		} else if (trimmed.startsWith("#EXTINF:")) {
			const commaIdx = trimmed.indexOf(",", 8);
			const durStr = commaIdx >= 0 ? trimmed.slice(8, commaIdx) : trimmed.slice(8);
			pendingDuration = parseFloat(durStr);
		} else if (!trimmed.startsWith("#") && pendingDuration >= 0) {
			segments.push({
				url: new URL(trimmed, baseURL).href,
				duration: pendingDuration,
			});
			pendingDuration = -1;
		}
	}

	return { targetDuration, mediaSequence, segments, ended };
}
