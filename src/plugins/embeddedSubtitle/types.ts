export interface RangeSourceOptions {
  url: string;
  maxCacheBytes?: number;
  fetch?: typeof fetch;
}

export interface ContentRangeInfo {
  start: number;
  end: number;
  total: number;
}

export interface CachedRange {
  start: number;
  end: number;
  data: Uint8Array;
  lastAccessed: number;
}

export interface SubtitleTimeBase {
  num: number;
  den: number;
}

export interface MatroskaTrackPrivateData {
  number?: number;
  uid?: bigint | number;
  codecId?: string;
  language?: string;
  name?: string;
  default?: boolean;
  flagForced?: bigint | number;
  defaultDuration?: bigint | number;
}

export interface EmbeddedSubtitleTrack {
  id: string;
  sourceKey: string;
  streamIndex: number;
  trackNumber?: number;
  trackUid?: string;
  codecId: "S_TEXT/UTF8";
  language?: string;
  name?: string;
  isDefault: boolean;
  isForced: boolean;
  defaultDuration?: string;
  timeBase: SubtitleTimeBase;
}

export interface EmbeddedSubtitlePacket {
  sourceKey: string;
  trackId: string;
  streamIndex: number;
  ptsSeconds: number;
  durationSeconds?: number;
  payload: Uint8Array;
  text: string;
}

export interface EmbeddedSubtitleCueDraft {
  sourceKey: string;
  trackId: string;
  startSeconds: number;
  durationSeconds?: number;
  text: string;
}

export interface EmbeddedSubtitleCue {
  key: string;
  sourceKey: string;
  trackId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface EmbeddedSubtitleCueStage {
  readonly pending: EmbeddedSubtitleCueDraft | null;
  readonly seenKeys: ReadonlySet<string>;
}

export interface SubtitleCueTimingOptions {
  defaultDurationSeconds?: number;
  maxDefaultDurationSeconds?: number;
  minimumDurationSeconds?: number;
}

export interface MatroskaDemuxReadOptions {
  /**
   * Maximum logical IOReader byte progress for one read call. The demuxer may
   * consume the remainder of the current IOReader buffer before observing the
   * limit, so actual progress can exceed this value by at most one reader buffer.
   */
  maxBytesScanned?: number;
  /** Maximum number of all demuxed packets, including non-subtitle packets. */
  maxPacketsScanned?: number;
}

export interface MatroskaDemuxReadProgress {
  /** Non-negative safe integer logical IOReader byte progress for this read call. */
  bytesScanned: number;
  /** Non-negative safe integer count of all packets demuxed by this read call. */
  packetsScanned: number;
}

export interface MatroskaDiscoveryLimits {
  /** Maximum bytes fetched while parsing the Matroska header and Tracks. */
  maxBytes: number;
  /** Maximum wall-clock time spent opening the Matroska header. */
  maxMilliseconds: number;
}

export type MatroskaDemuxReadResult =
  | ({ status: "packet"; packet: EmbeddedSubtitlePacket } & MatroskaDemuxReadProgress)
  | ({ status: "end" } & MatroskaDemuxReadProgress)
  | ({ status: "aborted" } & MatroskaDemuxReadProgress)
  | ({ status: "limit" } & MatroskaDemuxReadProgress);

export interface MatroskaSeekOptions {
  backward?: boolean;
  anyFrame?: boolean;
}

export type MatroskaSeekResult = { status: "ok" } | { status: "aborted" };

export interface OpenMatroskaDemuxOptions {
  url: string;
  sourceKey: string;
  source?: import("./rangeSource").RangeSource;
  signal?: AbortSignal;
  readerBufferBytes?: number;
  /** Header/Tracks discovery byte budget; invalid values fall back to a finite default. */
  maxDiscoveryBytes?: number;
  /** Header/Tracks discovery wall-clock budget; invalid values fall back to a finite default. */
  maxDiscoveryMilliseconds?: number;
}

export interface MatroskaDemuxSession {
  readonly tracks: readonly EmbeddedSubtitleTrack[];
  readonly readPosition: number;
  read(trackId: string, options?: MatroskaDemuxReadOptions): Promise<MatroskaDemuxReadResult>;
  seek(
    trackId: string,
    timestampMilliseconds: number,
    options?: MatroskaSeekOptions
  ): Promise<MatroskaSeekResult>;
  destroy(): Promise<void>;
}
