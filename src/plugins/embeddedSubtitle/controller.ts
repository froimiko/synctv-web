import {
  createSubtitleCueStage,
  finalizeSubtitleCue,
  flushSubtitleCueStage,
  isValidMatroskaDemuxReadProgress,
  openMatroskaDemux,
  stageSubtitleCue,
  subtitleCueIdentity
} from "./matroskaDemuxer";
import type { EmbeddedSubtitleAddResult, EmbeddedSubtitleRenderer } from "./render";
import type {
  EmbeddedSubtitleCue,
  EmbeddedSubtitleCueDraft,
  EmbeddedSubtitleCueStage,
  EmbeddedSubtitlePacket,
  EmbeddedSubtitleTrack,
  MatroskaDemuxSession,
  OpenMatroskaDemuxOptions
} from "./types";

export interface EmbeddedSubtitleSource {
  url: string;
  sourceKey: string;
}

export type EmbeddedSubtitleFailureCode =
  | "open-failed"
  | "read-failed"
  | "scan-budget"
  | "seek-failed";

export interface EmbeddedSubtitleFailure {
  code: EmbeddedSubtitleFailureCode;
  message: string;
}

export type EmbeddedSubtitleSessionOpener = (
  options: OpenMatroskaDemuxOptions
) => Promise<MatroskaDemuxSession>;

export interface EmbeddedSubtitleControllerOptions {
  source?: EmbeddedSubtitleSource | null;
  openSession?: EmbeddedSubtitleSessionOpener;
  renderer: EmbeddedSubtitleRenderer;
  getCurrentTime: () => number;
  isPaused?: () => boolean;
  onTracksChanged?: (tracks: readonly EmbeddedSubtitleTrack[]) => void;
  onSelectionChanged?: (track: EmbeddedSubtitleTrack | null) => void;
  onFailure?: (failure: EmbeddedSubtitleFailure) => void;
  prefetchSeconds?: number;
  lowWaterSeconds?: number;
  retainBehindSeconds?: number;
  /** Maximum subtitle packets produced by one pump. */
  maxPacketsPerPump?: number;
  /** Hard logical IOReader byte budget across all session.read calls in one pump. */
  maxBytesScannedPerPump?: number;
  /** Hard all-packet demux budget across all session.read calls in one pump. */
  maxPacketsScannedPerPump?: number;
  /**
   * Cumulative logical IOReader byte budget across every pump of one demux
   * session. Per-pump exhaustion only ends the current pump; this cumulative
   * cap is the fatal runaway-download guard and resets whenever a new session
   * is established or the source is invalidated.
   */
  maxBytesScannedPerSession?: number;
}

export interface EmbeddedSubtitleController {
  readonly tracks: readonly EmbeddedSubtitleTrack[];
  readonly selectedTrack: EmbeddedSubtitleTrack | null;
  discover(): Promise<readonly EmbeddedSubtitleTrack[]>;
  updateSource(source: EmbeddedSubtitleSource | null): Promise<readonly EmbeddedSubtitleTrack[]>;
  selectTrack(trackId: string): Promise<boolean>;
  disable(): Promise<void>;
  handleTimeUpdate(): Promise<void>;
  handleSeek(timestampSeconds?: number): Promise<boolean>;
  destroy(): Promise<void>;
}

interface SessionRecord {
  session: MatroskaDemuxSession;
  abortController: AbortController;
  source: EmbeddedSubtitleSource;
}

interface PendingOpen {
  token: number;
  abortController: AbortController;
  source: EmbeddedSubtitleSource;
  promise: Promise<SessionRecord | null>;
}

interface ActivePump {
  token: number;
  promise: Promise<void>;
}

type EmbeddedSubtitleFailureKind = "open" | "read" | "scanBudget" | "seek";

const FAILURE_DETAILS: Record<EmbeddedSubtitleFailureKind, EmbeddedSubtitleFailure> = {
  open: {
    code: "open-failed",
    message: "Embedded subtitles are unavailable for this source."
  },
  read: {
    code: "read-failed",
    message: "Embedded subtitle data could not be read."
  },
  scanBudget: {
    code: "scan-budget",
    message: "Embedded subtitles were disabled because this file requires too much scanning."
  },
  seek: {
    code: "seek-failed",
    message: "Embedded subtitles could not be positioned."
  }
};

const DEFAULT_PREFETCH_SECONDS = 30;
const DEFAULT_LOW_WATER_SECONDS = 10;
const DEFAULT_RETAIN_BEHIND_SECONDS = 30;
const DEFAULT_MAX_PACKETS_PER_PUMP = 128;
// Matroska interleaves subtitle packets between video Clusters, so a sparse
// dialogue stretch can legitimately separate two subtitle packets by many
// megabytes of video data. Per-pump budgets only bound the work of one pump;
// exhausting them is normal and non-fatal. For 4K sources a single video packet
// can be hundreds of KB, so packet count is a poor cost proxy - bytes are the
// meaningful boundary, and DEFAULT_MAX_BYTES_SCANNED_PER_SESSION below is the
// actual runaway-download guard.
const DEFAULT_MAX_BYTES_SCANNED_PER_PUMP = 24 * 1024 * 1024;
const DEFAULT_MAX_PACKETS_SCANNED_PER_PUMP = 16384;
const DEFAULT_MAX_BYTES_SCANNED_PER_SESSION = 512 * 1024 * 1024;

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function sourcesEqual(
  first: EmbeddedSubtitleSource | null,
  second: EmbeddedSubtitleSource | null
): boolean {
  return first?.url === second?.url && first?.sourceKey === second?.sourceKey;
}

function seekMilliseconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(seconds * 1000));
}

export function createEmbeddedSubtitleController(
  options: EmbeddedSubtitleControllerOptions
): EmbeddedSubtitleController {
  const openSession = options.openSession ?? openMatroskaDemux;
  const prefetchSeconds = positiveFinite(options.prefetchSeconds, DEFAULT_PREFETCH_SECONDS);
  const lowWaterSeconds = Math.min(
    prefetchSeconds,
    positiveFinite(options.lowWaterSeconds, DEFAULT_LOW_WATER_SECONDS)
  );
  const retainBehindSeconds = nonNegativeFinite(
    options.retainBehindSeconds,
    DEFAULT_RETAIN_BEHIND_SECONDS
  );
  const maxPacketsPerPump = Math.max(
    1,
    Math.floor(positiveFinite(options.maxPacketsPerPump, DEFAULT_MAX_PACKETS_PER_PUMP))
  );
  const maxBytesScannedPerPump = Math.max(
    1,
    Math.floor(positiveFinite(options.maxBytesScannedPerPump, DEFAULT_MAX_BYTES_SCANNED_PER_PUMP))
  );
  const maxPacketsScannedPerPump = Math.max(
    1,
    Math.floor(
      positiveFinite(options.maxPacketsScannedPerPump, DEFAULT_MAX_PACKETS_SCANNED_PER_PUMP)
    )
  );
  const maxBytesScannedPerSession = Math.max(
    1,
    Math.floor(
      positiveFinite(options.maxBytesScannedPerSession, DEFAULT_MAX_BYTES_SCANNED_PER_SESSION)
    )
  );

  let source = options.source ?? null;
  let tracks: EmbeddedSubtitleTrack[] = [];
  let selectedTrack: EmbeddedSubtitleTrack | null = null;
  let sessionRecord: SessionRecord | null = null;
  let pendingOpen: PendingOpen | null = null;
  let activePump: ActivePump | null = null;
  let destroyPromise: Promise<void> | null = null;
  let generation = 0;
  let destroyed = false;
  let cueStage: EmbeddedSubtitleCueStage = createSubtitleCueStage();
  let decodedCues = new Map<string, EmbeddedSubtitleCue>();
  let rendererResidentCueKeys = new Set<string>();
  let authoritativeDurationKeys = new Set<string>();
  let scanHorizonSeconds = 0;
  let sessionBytesScanned = 0;

  let reachedEnd = false;

  const isCurrent = (token: number): boolean => !destroyed && token === generation;

  const currentTime = (): number => {
    try {
      const value = options.getCurrentTime();
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  };

  const isPaused = (): boolean => {
    try {
      return options.isPaused?.() ?? false;
    } catch {
      return true;
    }
  };

  const notifyTracksChanged = (): void => {
    try {
      options.onTracksChanged?.(tracks.slice());
    } catch {
      // Consumer notifications must not affect playback.
    }
  };

  const notifySelectionChanged = (): void => {
    try {
      options.onSelectionChanged?.(selectedTrack);
    } catch {
      // Consumer notifications must not affect playback.
    }
  };

  const notifyFailure = (kind: EmbeddedSubtitleFailureKind): void => {
    try {
      options.onFailure?.({ ...FAILURE_DETAILS[kind] });
    } catch {
      // Consumer notifications must not affect playback.
    }
  };

  const rendererClear = (): void => {
    try {
      options.renderer.clear();
    } catch {
      // Rendering failures must not affect video playback.
    }
  };

  const rendererSetActive = (active: boolean): void => {
    try {
      options.renderer.setActive(active);
    } catch {
      // Rendering failures must not affect video playback.
    }
  };

  const rendererRemoveByKey = (key: string): void => {
    try {
      options.renderer.removeByKey(key);
    } catch {
      // Rendering failures must not affect video playback.
    }
  };

  const rendererDestroy = (): void => {
    try {
      options.renderer.destroy();
    } catch {
      // Rendering failures must not affect video playback.
    }
  };

  const rendererRemoveOutsideWindow = (startSeconds: number, endSeconds: number): void => {
    try {
      options.renderer.removeOutsideWindow(startSeconds, endSeconds);
    } catch {
      // Rendering failures must not affect video playback.
    }
  };

  const rendererAdd = (cue: EmbeddedSubtitleCue, token: number): EmbeddedSubtitleAddResult => {
    if (!isCurrent(token)) return "unavailable";
    try {
      const result = options.renderer.add(cue);
      if (
        result === "added" ||
        result === "duplicate" ||
        result === "unavailable" ||
        result === "invalid"
      ) {
        return result;
      }
    } catch {
      // Rendering failures are retryable and must not affect video playback.
    }
    return "unavailable";
  };

  const resetCueState = (timestampSeconds = currentTime()): void => {
    cueStage = createSubtitleCueStage();
    decodedCues = new Map<string, EmbeddedSubtitleCue>();
    rendererResidentCueKeys = new Set<string>();
    authoritativeDurationKeys = new Set<string>();
    scanHorizonSeconds = timestampSeconds;
    reachedEnd = false;
  };

  const reconcileDelivery = (referenceTimeSeconds: number, token: number): void => {
    if (!isCurrent(token) || !selectedTrack) return;
    const windowStartSeconds = Math.max(0, referenceTimeSeconds - retainBehindSeconds);
    const windowEndSeconds = Math.min(Number.MAX_VALUE, referenceTimeSeconds + prefetchSeconds * 2);
    const overlapsWindow = (cue: EmbeddedSubtitleCue): boolean =>
      cue.endSeconds > windowStartSeconds && cue.startSeconds < windowEndSeconds;

    rendererRemoveOutsideWindow(windowStartSeconds, windowEndSeconds);
    if (!isCurrent(token)) return;

    for (const key of Array.from(rendererResidentCueKeys)) {
      const cue = decodedCues.get(key);
      if (!cue || !overlapsWindow(cue)) rendererResidentCueKeys.delete(key);
    }

    for (const [key, cue] of Array.from(decodedCues.entries())) {
      if (!isCurrent(token)) return;
      if (cue.endSeconds <= windowStartSeconds) {
        decodedCues.delete(key);
        rendererResidentCueKeys.delete(key);
        continue;
      }
      if (cue.startSeconds >= windowEndSeconds) {
        rendererResidentCueKeys.delete(key);
        continue;
      }

      const result = rendererAdd(cue, token);
      if (!isCurrent(token)) return;
      if (result === "added" || result === "duplicate") {
        rendererResidentCueKeys.add(key);
      } else if (result === "invalid") {
        decodedCues.delete(key);
        rendererResidentCueKeys.delete(key);
      } else {
        rendererResidentCueKeys.delete(key);
      }
    }
  };

  const safelyDestroySession = async (session: MatroskaDemuxSession): Promise<void> => {
    try {
      await session.destroy();
    } catch {
      // Destruction is best-effort and never user-visible.
    }
  };

  const cancelPendingOpen = (): Promise<SessionRecord | null> | null => {
    const opening = pendingOpen;
    if (!opening) return null;
    pendingOpen = null;
    opening.abortController.abort();
    return opening.promise;
  };

  const detachSession = (): Promise<void> => {
    const record = sessionRecord;
    sessionRecord = null;
    if (!record) return Promise.resolve();
    record.abortController.abort();
    return safelyDestroySession(record.session);
  };

  const invalidateWork = (
    destroySession: boolean,
    timestampSeconds = currentTime()
  ): { token: number; cleanup: Promise<void> } => {
    generation += 1;
    const pendingPromise = cancelPendingOpen();
    const sessionCleanup = destroySession ? detachSession() : Promise.resolve();
    resetCueState(timestampSeconds);
    sessionBytesScanned = 0;
    rendererClear();
    const pendingCleanup = pendingPromise
      ? pendingPromise.then(() => undefined).catch(() => undefined)
      : Promise.resolve();
    return {
      token: generation,
      cleanup: Promise.all([sessionCleanup, pendingCleanup]).then(() => undefined)
    };
  };

  const replaceTracks = (nextTracks: readonly EmbeddedSubtitleTrack[]): void => {
    const normalized = Array.from(nextTracks);
    const changed =
      tracks.length !== normalized.length ||
      tracks.some((track, index) => track.id !== normalized[index]?.id);
    tracks = normalized;
    if (selectedTrack) {
      selectedTrack = tracks.find((track) => track.id === selectedTrack?.id) ?? null;
    }
    if (changed) notifyTracksChanged();
  };

  const clearCapability = (notify: boolean): void => {
    const hadTracks = tracks.length > 0;
    const hadSelection = selectedTrack !== null;
    tracks = [];
    selectedTrack = null;
    rendererSetActive(false);
    if (hadTracks) notifyTracksChanged();
    if (hadSelection) notifySelectionChanged();
    if (notify && !hadTracks) notifyTracksChanged();
  };

  const disableForFailure = async (
    kind: EmbeddedSubtitleFailureKind,
    token: number
  ): Promise<void> => {
    if (!isCurrent(token)) return;
    const invalidation = invalidateWork(true);
    clearCapability(true);
    notifyFailure(kind);
    await invalidation.cleanup;
  };

  const disableAfterAbort = async (token: number): Promise<void> => {
    if (!isCurrent(token)) return;
    const invalidation = invalidateWork(true);
    clearCapability(true);
    await invalidation.cleanup;
  };

  const syncTracksFromSession = (record: SessionRecord): void => {
    const nextTracks = record.session.tracks.filter(
      (track) => track.sourceKey === record.source.sourceKey
    );
    replaceTracks(nextTracks);
  };

  const ensureSession = async (token: number): Promise<SessionRecord | null> => {
    if (!isCurrent(token) || !source) return null;
    if (sessionRecord && sourcesEqual(sessionRecord.source, source)) return sessionRecord;
    if (pendingOpen && pendingOpen.token === token && sourcesEqual(pendingOpen.source, source)) {
      return pendingOpen.promise;
    }

    const openingSource = { ...source };
    const abortController = new AbortController();
    const opening = {} as PendingOpen;
    opening.token = token;
    opening.source = openingSource;
    opening.abortController = abortController;
    opening.promise = (async () => {
      try {
        const session = await openSession({
          url: openingSource.url,
          sourceKey: openingSource.sourceKey,
          signal: abortController.signal
        });
        if (
          !isCurrent(token) ||
          abortController.signal.aborted ||
          !sourcesEqual(source, openingSource)
        ) {
          await safelyDestroySession(session);
          return null;
        }
        const record = { session, abortController, source: openingSource };
        sessionRecord = record;
        sessionBytesScanned = 0;
        return record;
      } catch (error) {
        // Failure cleanup must not await the promise currently executing this catch.
        if (pendingOpen === opening) pendingOpen = null;
        if (!isCurrent(token) || abortController.signal.aborted || isAbortError(error)) {
          if (isCurrent(token)) await disableAfterAbort(token);
          return null;
        }
        await disableForFailure("open", token);
        return null;
      } finally {
        if (pendingOpen === opening) pendingOpen = null;
      }
    })();
    pendingOpen = opening;
    return opening.promise;
  };

  const addFinalCue = (cue: EmbeddedSubtitleCue | null, token: number): void => {
    if (!cue || !isCurrent(token)) return;
    decodedCues.set(cue.key, cue);
  };

  const stageWithoutIdentity = (
    stage: EmbeddedSubtitleCueStage,
    identity: string
  ): EmbeddedSubtitleCueStage => {
    const seenKeys = new Set(stage.seenKeys);
    seenKeys.delete(identity);
    return {
      pending:
        stage.pending && subtitleCueIdentity(stage.pending) === identity ? null : stage.pending,
      seenKeys
    };
  };

  const replaceWithAuthoritativeCue = (identity: string, draft: EmbeddedSubtitleCueDraft): void => {
    const hadResidentCue = rendererResidentCueKeys.delete(identity);
    cueStage = stageWithoutIdentity(cueStage, identity);
    decodedCues.set(identity, finalizeSubtitleCue(draft));
    authoritativeDurationKeys.add(identity);
    if (hadResidentCue) rendererRemoveByKey(identity);
  };

  const processPacket = (packet: EmbeddedSubtitlePacket, token: number): void => {
    if (
      !isCurrent(token) ||
      !selectedTrack ||
      packet.sourceKey !== selectedTrack.sourceKey ||
      packet.trackId !== selectedTrack.id ||
      !Number.isFinite(packet.ptsSeconds) ||
      packet.ptsSeconds < 0
    ) {
      return;
    }

    const hasDuration =
      packet.durationSeconds !== undefined &&
      Number.isFinite(packet.durationSeconds) &&
      packet.durationSeconds > 0;
    scanHorizonSeconds = Math.max(
      scanHorizonSeconds,
      packet.ptsSeconds + (hasDuration ? packet.durationSeconds! : 0)
    );
    if (typeof packet.text !== "string" || packet.text.length === 0) return;

    const draft: EmbeddedSubtitleCueDraft = {
      sourceKey: packet.sourceKey,
      trackId: packet.trackId,
      startSeconds: packet.ptsSeconds,
      durationSeconds: packet.durationSeconds,
      text: packet.text
    };
    const identity = subtitleCueIdentity(draft);

    if (hasDuration) {
      if (authoritativeDurationKeys.has(identity)) return;
      if (decodedCues.has(identity) || cueStage.seenKeys.has(identity)) {
        replaceWithAuthoritativeCue(identity, draft);
        return;
      }

      if (cueStage.pending) {
        addFinalCue(finalizeSubtitleCue(cueStage.pending, draft.startSeconds), token);
        cueStage = createSubtitleCueStage();
      }
      addFinalCue(finalizeSubtitleCue(draft), token);
      authoritativeDurationKeys.add(identity);
      return;
    }

    if (
      authoritativeDurationKeys.has(identity) ||
      decodedCues.has(identity) ||
      cueStage.seenKeys.has(identity)
    ) {
      return;
    }

    const staged = stageSubtitleCue(cueStage, draft);
    cueStage = staged.stage;
    addFinalCue(staged.cue, token);
  };

  const flushPendingCue = (token: number): void => {
    if (!isCurrent(token)) return;
    const flushed = flushSubtitleCueStage(cueStage);
    cueStage = flushed.stage;
    addFinalCue(flushed.cue, token);
  };

  const pumpLoop = async (token: number, referenceTimeSeconds: number): Promise<void> => {
    const trackId = selectedTrack?.id;
    if (!trackId || !isCurrent(token)) return;

    reconcileDelivery(referenceTimeSeconds, token);
    if (!isCurrent(token) || selectedTrack?.id !== trackId || reachedEnd || isPaused()) return;

    const record = await ensureSession(token);
    if (!record || !isCurrent(token) || selectedTrack?.id !== trackId) return;
    reconcileDelivery(referenceTimeSeconds, token);

    let packetCount = 0;
    let bytesScanned = 0;
    let packetsScanned = 0;
    while (packetCount < maxPacketsPerPump) {
      if (!isCurrent(token) || selectedTrack?.id !== trackId || reachedEnd || isPaused()) return;
      if (scanHorizonSeconds >= referenceTimeSeconds + prefetchSeconds) return;

      const remainingBytes = maxBytesScannedPerPump - bytesScanned;
      const remainingPackets = maxPacketsScannedPerPump - packetsScanned;
      if (remainingBytes <= 0 || remainingPackets <= 0) {
        // Per-pump budget exhaustion is a normal sparse-dialogue event: end this
        // pump only and let the next timeupdate resume from the demux position.
        reconcileDelivery(referenceTimeSeconds, token);
        return;
      }

      let result;
      try {
        result = await record.session.read(trackId, {
          maxBytesScanned: remainingBytes,
          maxPacketsScanned: remainingPackets
        });
      } catch (error) {
        if (!isCurrent(token) || record.abortController.signal.aborted || isAbortError(error))
          return;
        await disableForFailure("read", token);
        return;
      }

      if (!isCurrent(token) || selectedTrack?.id !== trackId) return;
      if (!isValidMatroskaDemuxReadProgress(result)) {
        await disableForFailure("read", token);
        return;
      }

      const accumulatedProgress = {
        bytesScanned: bytesScanned + result.bytesScanned,
        packetsScanned: packetsScanned + result.packetsScanned
      };
      if (!isValidMatroskaDemuxReadProgress(accumulatedProgress)) {
        await disableForFailure("read", token);
        return;
      }
      bytesScanned = accumulatedProgress.bytesScanned;
      packetsScanned = accumulatedProgress.packetsScanned;
      sessionBytesScanned += result.bytesScanned;

      if (result.status === "aborted") {
        await disableAfterAbort(token);
        return;
      }
      if (result.status === "end") {
        flushPendingCue(token);
        reachedEnd = true;
        reconcileDelivery(referenceTimeSeconds, token);
        return;
      }
      if (sessionBytesScanned >= maxBytesScannedPerSession) {
        // Cumulative session scanning is the real runaway-download guard and is
        // the only scan-budget condition that disables embedded subtitles.
        await disableForFailure("scanBudget", token);
        return;
      }
      if (result.status === "limit") {
        // Non-fatal: the demux session keeps its reader position, so the next
        // pump continues forward instead of restarting.
        reconcileDelivery(referenceTimeSeconds, token);
        return;
      }

      packetCount += 1;
      processPacket(result.packet, token);
      reconcileDelivery(referenceTimeSeconds, token);
    }
  };

  const runPump = async (token: number, referenceTimeSeconds = currentTime()): Promise<void> => {
    if (!isCurrent(token)) return;
    reconcileDelivery(referenceTimeSeconds, token);
    if (!isCurrent(token)) return;

    if (activePump?.token === token) {
      await activePump.promise;
      reconcileDelivery(referenceTimeSeconds, token);
      return;
    }

    const pump = {} as ActivePump;
    pump.token = token;
    pump.promise = pumpLoop(token, referenceTimeSeconds).finally(() => {
      if (activePump === pump) activePump = null;
    });
    activePump = pump;
    await pump.promise;
    reconcileDelivery(referenceTimeSeconds, token);
  };

  const seekSession = async (
    record: SessionRecord,
    trackId: string,
    timestampSeconds: number,
    token: number
  ): Promise<boolean> => {
    try {
      const result = await record.session.seek(trackId, seekMilliseconds(timestampSeconds), {
        backward: true,
        anyFrame: true
      });
      if (!isCurrent(token)) return false;
      if (result.status === "aborted") {
        await disableAfterAbort(token);
        return false;
      }
      return true;
    } catch (error) {
      if (!isCurrent(token) || record.abortController.signal.aborted || isAbortError(error))
        return false;
      await disableForFailure("seek", token);
      return false;
    }
  };

  const controller: EmbeddedSubtitleController = {
    get tracks() {
      return tracks.slice();
    },

    get selectedTrack() {
      return selectedTrack;
    },

    async discover() {
      if (destroyed || !source) return [];
      const token = generation;
      const record = await ensureSession(token);
      if (!record || !isCurrent(token)) return [];
      syncTracksFromSession(record);
      return tracks.slice();
    },

    async updateSource(nextSource) {
      if (destroyed) return [];
      // Invalidation-only calls must never route through discover(): the
      // synchronous block below is the sole contract that guarantees generation
      // bump, abort, and renderer clear happen before the first `await`.
      if (nextSource) {
        if (sourcesEqual(source, nextSource)) return controller.discover();
      } else if (source === null && !sessionRecord) {
        return [];
      }

      const hadSelection = selectedTrack !== null;
      const hadTracks = tracks.length > 0;
      const invalidation = invalidateWork(true, 0);
      source = nextSource ? { ...nextSource } : null;
      selectedTrack = null;
      tracks = [];
      rendererSetActive(false);
      if (hadSelection) notifySelectionChanged();
      if (hadTracks) notifyTracksChanged();
      await invalidation.cleanup;
      if (!source || destroyed) return [];
      return controller.discover();
    },

    async selectTrack(trackId) {
      if (destroyed || !source || !trackId) return false;
      let track = tracks.find((item) => item.id === trackId) ?? null;
      if (!track) {
        await controller.discover();
        track = tracks.find((item) => item.id === trackId) ?? null;
      }
      if (!track || destroyed) return false;

      if (selectedTrack?.id === track.id) {
        rendererSetActive(true);
        await controller.handleTimeUpdate();
        return selectedTrack?.id === track.id;
      }

      const invalidation = invalidateWork(selectedTrack !== null);
      const token = invalidation.token;
      selectedTrack = track;
      rendererSetActive(true);
      notifySelectionChanged();
      await invalidation.cleanup;
      if (!isCurrent(token)) return false;

      const record = await ensureSession(token);
      if (!record || !isCurrent(token)) return false;
      syncTracksFromSession(record);
      const reopenedTrack = tracks.find((item) => item.id === trackId) ?? null;
      if (!reopenedTrack) {
        await disableAfterAbort(token);
        return false;
      }
      selectedTrack = reopenedTrack;

      if (!(await seekSession(record, trackId, currentTime(), token))) return false;
      await runPump(token);
      return isCurrent(token) && selectedTrack?.id === trackId;
    },

    async disable() {
      if (destroyed) return;
      const hadSelection = selectedTrack !== null;
      const invalidation = invalidateWork(true);
      selectedTrack = null;
      rendererSetActive(false);
      if (hadSelection) notifySelectionChanged();
      await invalidation.cleanup;
    },

    async handleTimeUpdate() {
      if (destroyed || !selectedTrack) return;
      const token = generation;
      const now = currentTime();
      reconcileDelivery(now, token);
      if (!isCurrent(token) || isPaused() || reachedEnd) return;
      if (scanHorizonSeconds - now > lowWaterSeconds) return;
      await runPump(token, now);
    },

    async handleSeek(timestampSeconds = currentTime()) {
      if (destroyed || !source) return false;
      const trackId = selectedTrack?.id ?? null;
      const normalizedTimestamp =
        Number.isFinite(timestampSeconds) && timestampSeconds >= 0 ? timestampSeconds : 0;
      const invalidation = invalidateWork(true, normalizedTimestamp);
      const token = invalidation.token;
      await invalidation.cleanup;
      if (!trackId || !isCurrent(token)) return false;

      rendererSetActive(true);
      const record = await ensureSession(token);
      if (!record || !isCurrent(token)) return false;
      syncTracksFromSession(record);
      const reopenedTrack = tracks.find((item) => item.id === trackId) ?? null;
      if (!reopenedTrack) {
        await disableAfterAbort(token);
        return false;
      }
      selectedTrack = reopenedTrack;

      if (!(await seekSession(record, trackId, normalizedTimestamp, token))) return false;
      await runPump(token, normalizedTimestamp);
      return isCurrent(token) && selectedTrack?.id === trackId;
    },

    destroy() {
      if (destroyPromise) return destroyPromise;
      destroyed = true;
      generation += 1;
      destroyPromise = Promise.resolve().then(async () => {
        const pendingPromise = cancelPendingOpen();
        const sessionCleanup = detachSession();
        resetCueState(0);
        rendererClear();
        rendererDestroy();
        const hadSelection = selectedTrack !== null;
        const hadTracks = tracks.length > 0;
        selectedTrack = null;
        tracks = [];
        source = null;
        if (hadSelection) notifySelectionChanged();
        if (hadTracks) notifyTracksChanged();
        const pendingCleanup = pendingPromise
          ? pendingPromise.then(() => undefined).catch(() => undefined)
          : Promise.resolve();
        await Promise.all([sessionCleanup, pendingCleanup]);
      });
      return destroyPromise;
    }
  };

  return controller;
}
