import type { AVIFormatContext } from "@libmedia/avformat";
import type { IOReader } from "@libmedia/common/io";
import type { AVStream } from "@libmedia/avutil";

import { RangeSource } from "./rangeSource";
import type {
  EmbeddedSubtitleCue,
  EmbeddedSubtitleCueDraft,
  EmbeddedSubtitleCueStage,
  EmbeddedSubtitlePacket,
  EmbeddedSubtitleTrack,
  MatroskaDemuxReadOptions,
  MatroskaDemuxReadProgress,
  MatroskaDemuxSession,
  MatroskaDiscoveryLimits,
  MatroskaTrackPrivateData,
  OpenMatroskaDemuxOptions,
  SubtitleCueTimingOptions,
  SubtitleTimeBase
} from "./types";

// libmedia 1.3.1 publishes these as const enums, so they do not exist as
// runtime exports. Keep the values next to the adapter instead of reading
// undefined properties from the dynamically imported module.
export const LIBMEDIA_MEDIA_TYPE_SUBTITLE = 3;
export const LIBMEDIA_CODEC_ID_SUBRIP = 94225;
export const LIBMEDIA_IO_FLAG_SEEKABLE = 1;
export const LIBMEDIA_IO_FLAG_NETWORK = 4;
export const LIBMEDIA_DISPOSITION_DEFAULT = 1;
export const LIBMEDIA_DISPOSITION_FORCED = 64;
export const LIBMEDIA_SEEK_FLAG_BACKWARD = 1;
export const LIBMEDIA_SEEK_FLAG_ANY = 4;
export const LIBMEDIA_IO_ERROR_END = -1048576;
export const LIBMEDIA_IO_ERROR_NETWORK = -1048573;
export const LIBMEDIA_IO_ERROR_ABORT = -1048572;
export const LIBMEDIA_AV_NOPTS_VALUE = -(1n << 63n);

export const DEFAULT_SUBTITLE_CUE_DURATION_SECONDS = 4;
export const MAX_DEFAULT_SUBTITLE_CUE_DURATION_SECONDS = 10;
export const MIN_SUBTITLE_CUE_DURATION_SECONDS = 0.001;

const DEFAULT_READER_BUFFER_BYTES = 4 * 1024 * 1024;
// Discovery only needs the header and the tail index, so it keeps issuing
// small requests instead of pulling a full scanning buffer it would discard.
const DISCOVERY_READ_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_DEMUX_READ_MAX_BYTES_SCANNED = 4 * 1024 * 1024;
export const DEFAULT_DEMUX_READ_MAX_PACKETS_SCANNED = 512;
export const DEFAULT_MATROSKA_DISCOVERY_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MATROSKA_DISCOVERY_MAX_MILLISECONDS = 10_000;
export const MATROSKA_DISCOVERY_LIMIT_ERROR = "Matroska discovery scan limit exceeded";
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export interface MatroskaDemuxResourceLifecycle {
  abort(): void;
  destroyPacket(): void;
  destroyContext(): Promise<void>;
}

export interface MatroskaDemuxDestroyGate {
  destroy(): Promise<void>;
}

export interface MatroskaDemuxReader extends IOReader {}

export interface MatroskaInputFormat {
  getAnalyzeStreamsCount(): number;
}

export interface MatroskaPacketView {
  streamIndex: number;
  pts: bigint;
  duration: bigint;
  timeBase: SubtitleTimeBase;
}

export interface MatroskaDemuxRuntime {
  createContext(): AVIFormatContext;
  createReader(bufferBytes: number): MatroskaDemuxReader;
  createInputFormat(): MatroskaInputFormat;
  createPacket(): unknown;
  destroyPacket(packet: unknown): void;
  open(context: AVIFormatContext, options: { fastOpen: true }): Promise<number>;
  readPacket(context: AVIFormatContext, packet: unknown): Promise<number>;
  seek(
    context: AVIFormatContext,
    streamIndex: number,
    timestampMilliseconds: bigint,
    flags: number
  ): Promise<bigint>;
  viewPacket(packet: unknown): MatroskaPacketView;
  getPacketData(packet: unknown): Uint8Array;
}

export function createMatroskaDemuxDestroyGate(
  waitForActiveOperation: () => Promise<void>,
  resources: MatroskaDemuxResourceLifecycle
): MatroskaDemuxDestroyGate {
  let destroyPromise: Promise<void> | null = null;
  return {
    destroy() {
      if (destroyPromise) return destroyPromise;
      resources.abort();
      destroyPromise = (async () => {
        await waitForActiveOperation();
        resources.destroyPacket();
        await resources.destroyContext();
      })();
      return destroyPromise;
    }
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function resolveMatroskaDiscoveryLimits(
  options: Pick<OpenMatroskaDemuxOptions, "maxDiscoveryBytes" | "maxDiscoveryMilliseconds"> = {}
): MatroskaDiscoveryLimits {
  return {
    maxBytes: positiveInteger(options.maxDiscoveryBytes, DEFAULT_MATROSKA_DISCOVERY_MAX_BYTES),
    maxMilliseconds: positiveInteger(
      options.maxDiscoveryMilliseconds,
      DEFAULT_MATROSKA_DISCOVERY_MAX_MILLISECONDS
    )
  };
}

export function resolveMatroskaDemuxReadOptions(
  options: MatroskaDemuxReadOptions = {}
): Required<MatroskaDemuxReadOptions> {
  return {
    maxBytesScanned: positiveInteger(options.maxBytesScanned, DEFAULT_DEMUX_READ_MAX_BYTES_SCANNED),
    maxPacketsScanned: positiveInteger(
      options.maxPacketsScanned,
      DEFAULT_DEMUX_READ_MAX_PACKETS_SCANNED
    )
  };
}

export function isValidMatroskaDemuxReadProgress(
  progress: unknown
): progress is MatroskaDemuxReadProgress {
  if (typeof progress !== "object" || progress === null) return false;
  const candidate = progress as Partial<MatroskaDemuxReadProgress>;
  return (
    typeof candidate.bytesScanned === "number" &&
    Number.isSafeInteger(candidate.bytesScanned) &&
    candidate.bytesScanned >= 0 &&
    typeof candidate.packetsScanned === "number" &&
    Number.isSafeInteger(candidate.packetsScanned) &&
    candidate.packetsScanned >= 0 &&
    (candidate.scanPositionSeconds === undefined ||
      (typeof candidate.scanPositionSeconds === "number" &&
        Number.isFinite(candidate.scanPositionSeconds) &&
        candidate.scanPositionSeconds >= 0))
  );
}

export function matroskaDemuxReadLimitReached(
  progress: MatroskaDemuxReadProgress,
  limits: Required<MatroskaDemuxReadOptions>
): boolean {
  return (
    progress.bytesScanned >= limits.maxBytesScanned ||
    progress.packetsScanned >= limits.maxPacketsScanned
  );
}

export function isUsableSubtitleTimeBase(timeBase: SubtitleTimeBase): boolean {
  return (
    Number.isSafeInteger(timeBase.num) &&
    Number.isSafeInteger(timeBase.den) &&
    timeBase.num > 0 &&
    timeBase.den > 0
  );
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBigIntString(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function assertUsableTimeBase(timeBase: SubtitleTimeBase): void {
  if (!isUsableSubtitleTimeBase(timeBase)) {
    throw new Error("Invalid subtitle packet time base");
  }
}

function finiteNumberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function timingOptions(options: SubtitleCueTimingOptions = {}) {
  const minimumDurationSeconds = Math.max(
    Number.EPSILON,
    finiteNumberOr(options.minimumDurationSeconds, MIN_SUBTITLE_CUE_DURATION_SECONDS)
  );
  const maxDefaultDurationSeconds = Math.max(
    minimumDurationSeconds,
    finiteNumberOr(options.maxDefaultDurationSeconds, MAX_DEFAULT_SUBTITLE_CUE_DURATION_SECONDS)
  );
  const defaultDurationSeconds = Math.min(
    maxDefaultDurationSeconds,
    Math.max(
      minimumDurationSeconds,
      finiteNumberOr(options.defaultDurationSeconds, DEFAULT_SUBTITLE_CUE_DURATION_SECONDS)
    )
  );
  return { minimumDurationSeconds, maxDefaultDurationSeconds, defaultDurationSeconds };
}

function finalizedEndSeconds(
  cue: EmbeddedSubtitleCueDraft,
  nextStartSeconds: number | undefined,
  options: SubtitleCueTimingOptions
): number {
  if (!Number.isFinite(cue.startSeconds)) {
    throw new Error("Subtitle cue start must be finite");
  }

  const resolved = timingOptions(options);
  const hasPacketDuration =
    cue.durationSeconds !== undefined &&
    Number.isFinite(cue.durationSeconds) &&
    cue.durationSeconds > 0;
  const hasNextStart =
    nextStartSeconds !== undefined &&
    Number.isFinite(nextStartSeconds) &&
    nextStartSeconds > cue.startSeconds;
  let endSeconds = hasPacketDuration
    ? cue.startSeconds + cue.durationSeconds!
    : hasNextStart
    ? nextStartSeconds
    : cue.startSeconds + resolved.defaultDurationSeconds;

  if (!Number.isFinite(endSeconds) || endSeconds <= cue.startSeconds) {
    endSeconds = cue.startSeconds + resolved.minimumDurationSeconds;
  }
  return endSeconds;
}

export function subtitleTrackIdentity(
  sourceKey: string,
  streamIndex: number,
  trackNumber?: number,
  trackUid?: string
): string {
  if (trackUid) return `${sourceKey}:uid:${trackUid}`;
  if (trackNumber !== undefined) return `${sourceKey}:track:${trackNumber}`;
  return `${sourceKey}:stream:${streamIndex}`;
}

export function extractEmbeddedSubtitleTrack(
  stream: Pick<
    AVStream,
    "index" | "codecpar" | "metadata" | "disposition" | "privData" | "timeBase"
  >,
  sourceKey: string
): EmbeddedSubtitleTrack | null {
  if (stream.codecpar.codecType !== LIBMEDIA_MEDIA_TYPE_SUBTITLE) return null;
  if (stream.codecpar.codecId !== LIBMEDIA_CODEC_ID_SUBRIP) return null;

  // `codecpar.codecId` is authoritative: IMatroskaFormat's own table maps only
  // "S_TEXT/UTF8" onto AV_CODEC_ID_SUBRIP, so the check above already excludes
  // every other subtitle CodecID. `privData` carries the parsed TrackEntry but is
  // not guaranteed to be populated under `fastOpen`, so treating a missing or
  // partial entry as a rejection silently drops real subrip tracks. It may only
  // veto when it is present AND explicitly disagrees.
  const track = (stream.privData || {}) as MatroskaTrackPrivateData;
  const declaredCodecId = optionalString(track.codecId);
  if (declaredCodecId !== undefined && declaredCodecId !== "S_TEXT/UTF8") return null;

  const streamIndex = stream.index;
  const trackNumber = optionalNumber(track.number);
  const trackUid = optionalBigIntString(track.uid);
  const metadata = (stream.metadata || {}) as Record<string, unknown>;
  const language = optionalString(track.language) || optionalString(metadata.language);
  const name = optionalString(track.name) || optionalString(metadata.title);
  const isDefault =
    Boolean(track.default) || Boolean(stream.disposition & LIBMEDIA_DISPOSITION_DEFAULT);
  const isForced =
    Boolean(track.flagForced) || Boolean(stream.disposition & LIBMEDIA_DISPOSITION_FORCED);

  return {
    id: subtitleTrackIdentity(sourceKey, streamIndex, trackNumber, trackUid),
    sourceKey,
    streamIndex,
    trackNumber,
    trackUid,
    codecId: "S_TEXT/UTF8",
    language,
    name,
    isDefault,
    isForced,
    defaultDuration: optionalBigIntString(track.defaultDuration),
    timeBase: {
      num: stream.timeBase?.num || 0,
      den: stream.timeBase?.den || 1
    }
  };
}

export function extractEmbeddedSubtitleTracks(
  streams: Array<
    Pick<AVStream, "index" | "codecpar" | "metadata" | "disposition" | "privData" | "timeBase">
  >,
  sourceKey: string
): EmbeddedSubtitleTrack[] {
  return streams
    .map((stream) => extractEmbeddedSubtitleTrack(stream, sourceKey))
    .filter((track): track is EmbeddedSubtitleTrack => track !== null);
}

export function isValidSubtitleTimestamp(value: bigint): boolean {
  return value !== LIBMEDIA_AV_NOPTS_VALUE;
}

export function timestampToSeconds(value: bigint, timeBase: SubtitleTimeBase): number | null {
  if (!isValidSubtitleTimestamp(value)) return null;
  assertUsableTimeBase(timeBase);
  const denominator = BigInt(timeBase.den);
  const whole = value / denominator;
  const remainder = value % denominator;
  const seconds = Number(whole) * timeBase.num + (Number(remainder) * timeBase.num) / timeBase.den;
  return Number.isFinite(seconds) ? seconds : null;
}

export function durationToSeconds(value: bigint, timeBase: SubtitleTimeBase): number | undefined {
  if (!isValidSubtitleTimestamp(value) || value <= 0n) return undefined;
  const seconds = timestampToSeconds(value, timeBase);
  return seconds !== null && seconds > 0 ? seconds : undefined;
}

export function cleanUtf8SubtitleText(payload: Uint8Array): string | null {
  if (payload.length === 0) return null;
  const normalized = textDecoder
    .decode(payload)
    .replace(/^\uFEFF+/, "")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n");
  return normalized.trim().length > 0 ? normalized : null;
}

export function createEmbeddedSubtitlePacket(input: {
  sourceKey: string;
  track: EmbeddedSubtitleTrack;
  streamIndex: number;
  pts: bigint;
  duration: bigint;
  timeBase: SubtitleTimeBase;
  payload: Uint8Array;
}): EmbeddedSubtitlePacket | null {
  if (input.streamIndex !== input.track.streamIndex) return null;
  const timeBase = isUsableSubtitleTimeBase(input.timeBase)
    ? input.timeBase
    : isUsableSubtitleTimeBase(input.track.timeBase)
    ? input.track.timeBase
    : null;
  if (!timeBase) return null;
  const ptsSeconds = timestampToSeconds(input.pts, timeBase);
  if (ptsSeconds === null) return null;
  const text = cleanUtf8SubtitleText(input.payload);
  if (text === null) return null;
  return {
    sourceKey: input.sourceKey,
    trackId: input.track.id,
    streamIndex: input.streamIndex,
    ptsSeconds,
    durationSeconds: durationToSeconds(input.duration, timeBase),
    payload: input.payload.slice(),
    text
  };
}

export function subtitleCueIdentity(
  cue: Pick<EmbeddedSubtitleCueDraft, "sourceKey" | "trackId" | "startSeconds" | "text">
): string {
  return JSON.stringify([cue.sourceKey, cue.trackId, cue.startSeconds, cue.text]);
}

// Cue keys intentionally use the duration-independent canonical identity so a
// later packet with authoritative timing can replace the same logical cue.
export const subtitleCueKey = subtitleCueIdentity;

export function finalizeSubtitleCue(
  cue: EmbeddedSubtitleCueDraft,
  nextStartSeconds?: number,
  options: SubtitleCueTimingOptions = {}
): EmbeddedSubtitleCue {
  return {
    key: subtitleCueIdentity(cue),
    sourceKey: cue.sourceKey,
    trackId: cue.trackId,
    startSeconds: cue.startSeconds,
    endSeconds: finalizedEndSeconds(cue, nextStartSeconds, options),
    text: cue.text
  };
}

export function createSubtitleCueStage(): EmbeddedSubtitleCueStage {
  return { pending: null, seenKeys: new Set<string>() };
}

export function stageSubtitleCue(
  stage: EmbeddedSubtitleCueStage,
  cue: EmbeddedSubtitleCueDraft,
  options: SubtitleCueTimingOptions = {}
): { stage: EmbeddedSubtitleCueStage; cue: EmbeddedSubtitleCue | null } {
  const key = subtitleCueKey(cue);
  if (stage.seenKeys.has(key)) return { stage, cue: null };

  const seenKeys = new Set(stage.seenKeys);
  seenKeys.add(key);
  return {
    stage: { pending: cue, seenKeys },
    cue: stage.pending ? finalizeSubtitleCue(stage.pending, cue.startSeconds, options) : null
  };
}

export function flushSubtitleCueStage(
  stage: EmbeddedSubtitleCueStage,
  options: SubtitleCueTimingOptions = {}
): { stage: EmbeddedSubtitleCueStage; cue: EmbeddedSubtitleCue | null } {
  if (!stage.pending) return { stage, cue: null };
  return {
    stage: { pending: null, seenKeys: new Set(stage.seenKeys) },
    cue: finalizeSubtitleCue(stage.pending, undefined, options)
  };
}

function createAbortError(): Error {
  return new DOMException("Aborted", "AbortError");
}

function discoveryLimitError(): Error {
  return new Error(MATROSKA_DISCOVERY_LIMIT_ERROR);
}

async function loadMatroskaDemuxRuntime(): Promise<MatroskaDemuxRuntime> {
  const [{ createAVIFormatContext, demux }, matroskaModule, ioModule, avutil, cheap] =
    await Promise.all([
      import("@libmedia/avformat"),
      import("@libmedia/avformat/IMatroskaFormat"),
      import("@libmedia/common/io"),
      import("@libmedia/avutil"),
      import("@libmedia/cheap")
    ]);

  return {
    createContext: createAVIFormatContext,
    createReader: (bufferBytes) => new ioModule.IOReader(bufferBytes),
    createInputFormat: () => new matroskaModule.default(),
    createPacket: () => avutil.createAVPacket(),
    destroyPacket: (packet) =>
      avutil.destroyAVPacket(packet as ReturnType<typeof avutil.createAVPacket>),
    open: (context, openOptions) => demux.open(context, openOptions),
    readPacket: (context, packet) =>
      demux.readAVPacket(context, packet as ReturnType<typeof avutil.createAVPacket>),
    seek: (context, streamIndex, timestampMilliseconds, flags) =>
      demux.seek(context, streamIndex, timestampMilliseconds, flags),
    viewPacket: (packet) =>
      cheap.mapStruct(packet as ReturnType<typeof avutil.createAVPacket>, avutil.AVPacket),
    getPacketData: (packet) =>
      avutil.getAVPacketData(packet as ReturnType<typeof avutil.createAVPacket>)
  };
}

export async function openMatroskaDemux(
  options: OpenMatroskaDemuxOptions
): Promise<MatroskaDemuxSession> {
  return openMatroskaDemuxWithRuntime(options, await loadMatroskaDemuxRuntime());
}

export async function openMatroskaDemuxWithRuntime(
  options: OpenMatroskaDemuxOptions,
  runtime: MatroskaDemuxRuntime
): Promise<MatroskaDemuxSession> {
  const source = options.source ?? new RangeSource({ url: options.url });
  const signal = options.signal;
  const bufferBytes = Math.max(
    100 * 1024,
    positiveInteger(options.readerBufferBytes, DEFAULT_READER_BUFFER_BYTES)
  );
  const discoveryLimits = resolveMatroskaDiscoveryLimits(options);
  const discoveryController = new AbortController();
  const discoveryStartedAt = Date.now();
  let discoveryBytesSupplied = 0;
  let discoveryActive = true;
  let discoveryLimitReached = discoveryLimits.maxBytes < 4;
  let discoveryTimedOut = false;
  let readPosition = 0;
  let destroyed = false;
  let operation = Promise.resolve();

  const abortDiscoveryForCaller = () => discoveryController.abort(signal?.reason);
  if (signal?.aborted) abortDiscoveryForCaller();
  else signal?.addEventListener("abort", abortDiscoveryForCaller, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let context: AVIFormatContext | undefined;
  let reader: MatroskaDemuxReader | undefined;
  let packet: unknown;
  let destroyGate: MatroskaDemuxDestroyGate | undefined;
  let contextCreated = false;
  let readerCreated = false;
  let packetCreated = false;

  const runExclusive = async <T>(task: () => Promise<T>): Promise<T> => {
    const previous = operation;
    let release!: () => void;
    operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };

  const throwIfDestroyed = () => {
    if (destroyed) throw new Error("Matroska demux session has been destroyed");
  };
  const activeSignal = (): AbortSignal | undefined =>
    discoveryActive ? discoveryController.signal : signal;
  const discoveryExpired = (): boolean =>
    Date.now() - discoveryStartedAt >= discoveryLimits.maxMilliseconds;

  try {
    destroyGate = createMatroskaDemuxDestroyGate(() => operation, {
      abort: () => {
        if (readerCreated) reader!.abort();
      },
      destroyPacket: () => {
        if (packetCreated) runtime.destroyPacket(packet);
      },
      destroyContext: async () => {
        if (contextCreated) await context!.destroy();
      }
    });
    context = runtime.createContext();
    contextCreated = true;
    reader = runtime.createReader(bufferBytes);
    readerCreated = true;
    packet = runtime.createPacket();
    packetCreated = true;
    timeoutId = setTimeout(() => {
      discoveryTimedOut = true;
      discoveryController.abort();
    }, discoveryLimits.maxMilliseconds);

    reader.flags = LIBMEDIA_IO_FLAG_SEEKABLE | LIBMEDIA_IO_FLAG_NETWORK;
    reader.onFlush = async (buffer) => {
      const requestSignal = activeSignal();
      if (destroyed || requestSignal?.aborted) return LIBMEDIA_IO_ERROR_ABORT;
      if (discoveryActive && discoveryExpired()) {
        discoveryTimedOut = true;
        discoveryController.abort();
        return LIBMEDIA_IO_ERROR_ABORT;
      }

      const remainingDiscoveryBytes = discoveryLimits.maxBytes - discoveryBytesSupplied;
      if (discoveryActive && remainingDiscoveryBytes <= 0) {
        discoveryLimitReached = true;
        discoveryController.abort();
        return LIBMEDIA_IO_ERROR_ABORT;
      }

      const totalLength = source.getTotalLength();
      if (totalLength >= 0 && readPosition >= totalLength) return LIBMEDIA_IO_ERROR_END;

      const requestBytes = discoveryActive
        ? Math.min(buffer.length, remainingDiscoveryBytes, DISCOVERY_READ_CHUNK_BYTES)
        : buffer.length;
      const end =
        totalLength >= 0
          ? Math.min(totalLength - 1, readPosition + requestBytes - 1)
          : readPosition + requestBytes - 1;
      if (end < readPosition) return LIBMEDIA_IO_ERROR_END;

      try {
        const chunk = new Uint8Array(await source.read(readPosition, end, requestSignal));
        if (chunk.length === 0) return LIBMEDIA_IO_ERROR_END;
        const copied = Math.min(chunk.length, requestBytes);
        buffer.set(chunk.subarray(0, copied));
        readPosition += copied;
        if (discoveryActive) discoveryBytesSupplied += copied;
        return copied;
      } catch (error) {
        if (requestSignal?.aborted || isAbortError(error)) return LIBMEDIA_IO_ERROR_ABORT;
        return LIBMEDIA_IO_ERROR_NETWORK;
      }
    };
    reader.onSeek = (position) => {
      const requestSignal = activeSignal();
      if (destroyed || requestSignal?.aborted) return LIBMEDIA_IO_ERROR_ABORT;
      if (discoveryActive && discoveryExpired()) {
        discoveryTimedOut = true;
        discoveryController.abort();
        return LIBMEDIA_IO_ERROR_ABORT;
      }
      if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER)) {
        return LIBMEDIA_IO_ERROR_NETWORK;
      }
      readPosition = Number(position);
      return 0;
    };
    reader.onSize = async () => {
      const totalLength = source.getTotalLength();
      return totalLength >= 0 ? BigInt(totalLength) : 0n;
    };

    context.ioReader = reader;
    const inputFormat = runtime.createInputFormat();
    context.iformat = inputFormat as AVIFormatContext["iformat"];

    if (discoveryLimitReached) throw discoveryLimitError();
    if (signal?.aborted) throw createAbortError();

    const openResult = await runtime.open(context, { fastOpen: true });
    if (discoveryExpired()) discoveryTimedOut = true;
    if (signal?.aborted) throw createAbortError();
    if (discoveryLimitReached || discoveryTimedOut) throw discoveryLimitError();
    if (openResult !== 0) throw new Error(`Matroska demux open failed (${openResult})`);
    if (inputFormat.getAnalyzeStreamsCount() !== 0) {
      throw new Error("Matroska discovery requires header-complete stream metadata");
    }

    const tracks = extractEmbeddedSubtitleTracks(context.streams, options.sourceKey);
    const tracksById = new Map(tracks.map((track) => [track.id, track]));
    const sessionContext = context;
    const sessionReader = reader;
    const sessionPacket = packet;
    const sessionDestroyGate = destroyGate;
    discoveryActive = false;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortDiscoveryForCaller);

    return {
      tracks,
      get readPosition() {
        return readPosition;
      },
      read(trackId, readOptions) {
        return runExclusive(async () => {
          throwIfDestroyed();
          const track = tracksById.get(trackId);
          if (!track) throw new Error("Unknown embedded subtitle track");

          const limits = resolveMatroskaDemuxReadOptions(readOptions);
          const startPosition = sessionReader.getPos();
          let packetsScanned = 0;
          // Advances on ANY stream: during a silent stretch the subtitle track
          // yields nothing, so only cross-stream timestamps reveal real progress.
          let scanPositionSeconds: number | undefined;
          const notePacketPosition = (view: { pts: bigint; timeBase: SubtitleTimeBase }): void => {
            const seconds = timestampToSeconds(view.pts, view.timeBase);
            if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return;
            if (scanPositionSeconds === undefined || seconds > scanPositionSeconds) {
              scanPositionSeconds = seconds;
            }
          };
          const progress = (): MatroskaDemuxReadProgress => {
            const bytesScanned = sessionReader.getPos() - startPosition;
            if (bytesScanned < 0n || bytesScanned > BigInt(Number.MAX_SAFE_INTEGER)) {
              throw new Error("Invalid Matroska demux read progress");
            }
            const currentProgress = {
              bytesScanned: Number(bytesScanned),
              packetsScanned,
              scanPositionSeconds
            };
            if (!isValidMatroskaDemuxReadProgress(currentProgress)) {
              throw new Error("Invalid Matroska demux read progress");
            }
            return currentProgress;
          };

          for (;;) {
            const currentProgress = progress();
            if (signal?.aborted) return { status: "aborted", ...currentProgress } as const;
            if (matroskaDemuxReadLimitReached(currentProgress, limits)) {
              return { status: "limit", ...currentProgress } as const;
            }

            const result = await runtime.readPacket(sessionContext, sessionPacket);
            if (
              result !== 0 &&
              result !== LIBMEDIA_IO_ERROR_END &&
              result !== LIBMEDIA_IO_ERROR_ABORT &&
              !signal?.aborted
            ) {
              throw new Error(`Matroska packet read failed (${result})`);
            }
            const afterReadProgress = progress();
            if (result === LIBMEDIA_IO_ERROR_END)
              return { status: "end", ...afterReadProgress } as const;
            if (result === LIBMEDIA_IO_ERROR_ABORT || signal?.aborted) {
              return { status: "aborted", ...afterReadProgress } as const;
            }

            packetsScanned += 1;
            const packetView = runtime.viewPacket(sessionPacket);
            notePacketPosition(packetView);
            const packetProgress = progress();
            if (packetView.streamIndex === track.streamIndex) {
              const subtitlePacket = createEmbeddedSubtitlePacket({
                sourceKey: options.sourceKey,
                track,
                streamIndex: packetView.streamIndex,
                pts: packetView.pts,
                duration: packetView.duration,
                timeBase: packetView.timeBase,
                payload: runtime.getPacketData(sessionPacket).slice()
              });
              if (subtitlePacket) {
                return { status: "packet", packet: subtitlePacket, ...packetProgress } as const;
              }
            }

            if (matroskaDemuxReadLimitReached(packetProgress, limits)) {
              return { status: "limit", ...packetProgress } as const;
            }
          }
        });
      },
      seek(trackId, timestampMilliseconds, seekOptions = {}) {
        return runExclusive(async () => {
          throwIfDestroyed();
          const track = tracksById.get(trackId);
          if (!track) throw new Error("Unknown embedded subtitle track");
          if (!Number.isSafeInteger(timestampMilliseconds) || timestampMilliseconds < 0) {
            throw new Error("Seek timestamp must be a non-negative integer number of milliseconds");
          }
          if (signal?.aborted) return { status: "aborted" } as const;

          let flags = 0;
          if (seekOptions.backward) flags |= LIBMEDIA_SEEK_FLAG_BACKWARD;
          if (seekOptions.anyFrame) flags |= LIBMEDIA_SEEK_FLAG_ANY;
          const result = await runtime.seek(
            sessionContext,
            track.streamIndex,
            BigInt(timestampMilliseconds),
            flags
          );
          if (signal?.aborted) return { status: "aborted" } as const;
          if (result < 0n) throw new Error(`Matroska seek failed (${result})`);
          return { status: "ok" } as const;
        });
      },
      destroy() {
        destroyed = true;
        return sessionDestroyGate.destroy();
      }
    };
  } catch (error) {
    destroyed = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortDiscoveryForCaller);
    if (destroyGate) await destroyGate.destroy();
    if (signal?.aborted) throw createAbortError();
    if (discoveryLimitReached || discoveryTimedOut) throw discoveryLimitError();
    throw error;
  }
}

export type { AVIFormatContext };
