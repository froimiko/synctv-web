import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MATROSKA_DISCOVERY_MAX_BYTES,
  DEFAULT_MATROSKA_DISCOVERY_MAX_MILLISECONDS,
  LIBMEDIA_AV_NOPTS_VALUE,
  LIBMEDIA_CODEC_ID_SUBRIP,
  LIBMEDIA_DISPOSITION_DEFAULT,
  LIBMEDIA_DISPOSITION_FORCED,
  LIBMEDIA_IO_ERROR_ABORT,
  LIBMEDIA_MEDIA_TYPE_SUBTITLE,
  MATROSKA_DISCOVERY_LIMIT_ERROR,
  cleanUtf8SubtitleText,
  createEmbeddedSubtitlePacket,
  createMatroskaDemuxDestroyGate,
  createSubtitleCueStage,
  durationToSeconds,
  extractEmbeddedSubtitleTrack,
  extractEmbeddedSubtitleTracks,
  finalizeSubtitleCue,
  flushSubtitleCueStage,
  isValidMatroskaDemuxReadProgress,
  openMatroskaDemuxWithRuntime,
  resolveMatroskaDiscoveryLimits,
  stageSubtitleCue,
  subtitleCueKey,
  subtitleTrackIdentity,
  timestampToSeconds,
  type MatroskaDemuxRuntime
} from "../matroskaDemuxer";
import type { RangeSource } from "../rangeSource";
import type { EmbeddedSubtitleCueDraft, EmbeddedSubtitleTrack } from "../types";

function stream(overrides: Record<string, unknown> = {}) {
  return {
    index: 2,
    codecpar: {
      codecType: LIBMEDIA_MEDIA_TYPE_SUBTITLE,
      codecId: LIBMEDIA_CODEC_ID_SUBRIP
    },
    metadata: {},
    disposition: 0,
    privData: {
      number: 3,
      uid: 42n,
      codecId: "S_TEXT/UTF8",
      language: "chi",
      name: "简体中文",
      default: true,
      flagForced: 0n,
      defaultDuration: 3_000_000_000n
    },
    timeBase: { num: 1, den: 1000 },
    ...overrides
  } as any;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface FakeReader {
  flags: number;
  onFlush: (buffer: Uint8Array) => Promise<number> | number;
  onSeek: (position: bigint) => Promise<number> | number;
  onSize: () => Promise<bigint> | bigint;
  abort: ReturnType<typeof vi.fn>;
  getPos(): bigint;
}

function discoveryHarness(
  options: {
    open?: MatroskaDemuxRuntime["open"];
    analyzeStreamsCount?: number;
    streams?: unknown[];
  } = {}
) {
  let position = 0n;
  const reader: FakeReader = {
    flags: 0,
    onFlush: () => 0,
    onSeek: () => 0,
    onSize: () => 0n,
    abort: vi.fn(),
    getPos: () => position
  };
  const destroyContext = vi.fn(async () => undefined);
  const context = {
    streams: (options.streams ?? [stream()]) as any[],
    ioReader: reader,
    iformat: null,
    destroy: destroyContext
  } as any;
  const readPacket = vi.fn(async () => LIBMEDIA_IO_ERROR_ABORT);
  const destroyPacket = vi.fn();
  const runtime: MatroskaDemuxRuntime = {
    createContext: () => context,
    createReader: () => reader as any,
    createInputFormat: () => ({
      getAnalyzeStreamsCount: () => options.analyzeStreamsCount ?? 0
    }),
    createPacket: () => ({}),
    destroyPacket,
    open:
      options.open ??
      vi.fn(async (openContext) => {
        const buffer = new Uint8Array(32);
        const supplied = await openContext.ioReader.onFlush(buffer);
        if (supplied > 0) position += BigInt(supplied);
        return supplied < 0 ? supplied : 0;
      }),
    readPacket,
    seek: vi.fn(async () => 0n),
    viewPacket: () => ({
      streamIndex: 2,
      pts: 0n,
      duration: 0n,
      timeBase: { num: 1, den: 1000 }
    }),
    getPacketData: () => new Uint8Array()
  };
  return { runtime, reader, context, readPacket, destroyPacket, destroyContext };
}

function sourceFromRead(
  read: (start: number, end: number, signal?: AbortSignal) => Promise<ArrayBuffer>,
  totalLength = 1024
): RangeSource {
  return {
    getTotalLength: () => totalLength,
    read
  } as RangeSource;
}

describe("Matroska discovery", () => {
  const url = "https://secret.example/video.mkv?token=hidden";

  it("resolves finite defaults and falls back for invalid values", () => {
    expect(resolveMatroskaDiscoveryLimits()).toEqual({
      maxBytes: DEFAULT_MATROSKA_DISCOVERY_MAX_BYTES,
      maxMilliseconds: DEFAULT_MATROSKA_DISCOVERY_MAX_MILLISECONDS
    });
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveMatroskaDiscoveryLimits({
          maxDiscoveryBytes: invalid,
          maxDiscoveryMilliseconds: invalid
        })
      ).toEqual({
        maxBytes: DEFAULT_MATROSKA_DISCOVERY_MAX_BYTES,
        maxMilliseconds: DEFAULT_MATROSKA_DISCOVERY_MAX_MILLISECONDS
      });
    }
  });

  it("opens once, extracts header streams, and performs no packet reads", async () => {
    const sourceRead = vi.fn(
      async (start: number, end: number) => new Uint8Array(end - start + 1).buffer
    );
    const harness = discoveryHarness();
    const session = await openMatroskaDemuxWithRuntime(
      { url, sourceKey: "source-a", source: sourceFromRead(sourceRead) },
      harness.runtime
    );

    expect(harness.runtime.open).toHaveBeenCalledTimes(1);
    expect(harness.readPacket).not.toHaveBeenCalled();
    expect(session.tracks).toEqual([expect.objectContaining({ codecId: "S_TEXT/UTF8" })]);
    expect(sourceRead).toHaveBeenCalledTimes(1);

    await Promise.all([session.destroy(), session.destroy()]);
    expect(harness.reader.abort).toHaveBeenCalledTimes(1);
    expect(harness.destroyPacket).toHaveBeenCalledTimes(1);
    expect(harness.destroyContext).toHaveBeenCalledTimes(1);
  });

  it("rejects a format that requires public stream analysis", async () => {
    const harness = discoveryHarness({ analyzeStreamsCount: 1 });
    const source = sourceFromRead(async (start, end) => new Uint8Array(end - start + 1).buffer);

    await expect(
      openMatroskaDemuxWithRuntime({ url, sourceKey: "source-a", source }, harness.runtime)
    ).rejects.toThrow("header-complete stream metadata");
    expect(harness.readPacket).not.toHaveBeenCalled();
    expect(harness.reader.abort).toHaveBeenCalledTimes(1);
    expect(harness.destroyPacket).toHaveBeenCalledTimes(1);
    expect(harness.destroyContext).toHaveBeenCalledTimes(1);
  });

  it("clamps requests to the remaining byte budget and returns a fixed limit error", async () => {
    const requests: Array<[number, number]> = [];
    const source = sourceFromRead(async (start, end) => {
      requests.push([start, end]);
      return new Uint8Array(end - start + 1).buffer;
    });
    const harness = discoveryHarness({
      open: vi.fn(async (context) => {
        const first = await context.ioReader.onFlush(new Uint8Array(16));
        const second = await context.ioReader.onFlush(new Uint8Array(16));
        return second < 0 ? second : first;
      })
    });

    const opening = openMatroskaDemuxWithRuntime(
      { url, sourceKey: "source-a", source, maxDiscoveryBytes: 6 },
      harness.runtime
    );
    await expect(opening).rejects.toThrow(MATROSKA_DISCOVERY_LIMIT_ERROR);
    await expect(opening).rejects.not.toThrow(url);
    expect(requests).toEqual([[0, 5]]);
    expect(harness.reader.abort).toHaveBeenCalledTimes(1);
    expect(harness.destroyPacket).toHaveBeenCalledTimes(1);
    expect(harness.destroyContext).toHaveBeenCalledTimes(1);
  });

  it("fails an impossibly small discovery budget before misclassifying EBML", async () => {
    const sourceRead = vi.fn(async () => new ArrayBuffer(0));
    const harness = discoveryHarness();

    await expect(
      openMatroskaDemuxWithRuntime(
        {
          url,
          sourceKey: "source-a",
          source: sourceFromRead(sourceRead),
          maxDiscoveryBytes: 3
        },
        harness.runtime
      )
    ).rejects.toThrow(MATROSKA_DISCOVERY_LIMIT_ERROR);
    expect(harness.runtime.open).not.toHaveBeenCalled();
    expect(sourceRead).not.toHaveBeenCalled();
    expect(harness.reader.abort).toHaveBeenCalledTimes(1);
    expect(harness.destroyPacket).toHaveBeenCalledTimes(1);
    expect(harness.destroyContext).toHaveBeenCalledTimes(1);
  });

  it("times out a hanging source read, awaits open settlement, then cleans once", async () => {
    let openSettled = false;
    let fetchAborted = false;
    const source = sourceFromRead(
      (_start, _end, signal) =>
        new Promise<ArrayBuffer>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              fetchAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true }
          );
        })
    );
    const harness = discoveryHarness({
      open: vi.fn(async (context) => {
        const result = await context.ioReader.onFlush(new Uint8Array(16));
        openSettled = true;
        return result;
      })
    });
    harness.destroyContext.mockImplementation(async () => {
      expect(openSettled).toBe(true);
    });

    await expect(
      openMatroskaDemuxWithRuntime(
        {
          url,
          sourceKey: "source-a",
          source,
          maxDiscoveryMilliseconds: 10
        },
        harness.runtime
      )
    ).rejects.toThrow(MATROSKA_DISCOVERY_LIMIT_ERROR);
    expect(fetchAborted).toBe(true);
    expect(harness.reader.abort).toHaveBeenCalledTimes(1);
    expect(harness.destroyPacket).toHaveBeenCalledTimes(1);
    expect(harness.destroyContext).toHaveBeenCalledTimes(1);
  });

  it("preserves external AbortError semantics instead of reporting a limit", async () => {
    const controller = new AbortController();
    const source = sourceFromRead(
      (_start, _end, signal) =>
        new Promise<ArrayBuffer>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        })
    );
    const harness = discoveryHarness({
      open: vi.fn(async (context) => context.ioReader.onFlush(new Uint8Array(16)))
    });
    const opening = openMatroskaDemuxWithRuntime(
      { url, sourceKey: "source-a", source, signal: controller.signal },
      harness.runtime
    );
    await Promise.resolve();
    controller.abort();

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    await expect(opening).rejects.not.toThrow(MATROSKA_DISCOVERY_LIMIT_ERROR);
    expect(harness.reader.abort).toHaveBeenCalledTimes(1);
    expect(harness.destroyPacket).toHaveBeenCalledTimes(1);
    expect(harness.destroyContext).toHaveBeenCalledTimes(1);
  });

  it("cleans a normal open failure through the same exactly-once gate", async () => {
    const harness = discoveryHarness({ open: vi.fn(async () => -123) });
    const source = sourceFromRead(async () => new ArrayBuffer(0));

    await expect(
      openMatroskaDemuxWithRuntime({ url, sourceKey: "source-a", source }, harness.runtime)
    ).rejects.toThrow("Matroska demux open failed (-123)");
    expect(harness.reader.abort).toHaveBeenCalledTimes(1);
    expect(harness.destroyPacket).toHaveBeenCalledTimes(1);
    expect(harness.destroyContext).toHaveBeenCalledTimes(1);
  });

  it("does not leak an external abort listener when runtime setup fails", async () => {
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const runtime = discoveryHarness().runtime;
    runtime.createContext = vi.fn(() => {
      throw new Error("runtime setup failed");
    });

    await expect(
      openMatroskaDemuxWithRuntime(
        {
          url,
          sourceKey: "source-a",
          source: sourceFromRead(async () => new ArrayBuffer(0)),
          signal: controller.signal
        },
        runtime
      )
    ).rejects.toThrow("runtime setup failed");
    expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("destroys the created context exactly once when createReader throws", async () => {
    const harness = discoveryHarness();
    harness.runtime.createReader = vi.fn(() => {
      throw new Error("reader init failed");
    });

    await expect(
      openMatroskaDemuxWithRuntime(
        {
          url,
          sourceKey: "source-a",
          source: sourceFromRead(async () => new ArrayBuffer(0))
        },
        harness.runtime
      )
    ).rejects.toThrow("reader init failed");
    expect(harness.destroyContext).toHaveBeenCalledTimes(1);
    expect(harness.reader.abort).not.toHaveBeenCalled();
    expect(harness.destroyPacket).not.toHaveBeenCalled();
  });

  it("aborts the reader and destroys the context exactly once when createPacket throws", async () => {
    const harness = discoveryHarness();
    harness.runtime.createPacket = vi.fn(() => {
      throw new Error("packet init failed");
    });

    await expect(
      openMatroskaDemuxWithRuntime(
        {
          url,
          sourceKey: "source-a",
          source: sourceFromRead(async () => new ArrayBuffer(0))
        },
        harness.runtime
      )
    ).rejects.toThrow("packet init failed");
    expect(harness.destroyContext).toHaveBeenCalledTimes(1);
    expect(harness.reader.abort).toHaveBeenCalledTimes(1);
    expect(harness.destroyPacket).not.toHaveBeenCalled();
  });

  it("falls back to a finite default reader buffer for invalid sizes", async () => {
    const harness = discoveryHarness();
    const bufferSizes: number[] = [];
    const baseCreateReader = harness.runtime.createReader;
    harness.runtime.createReader = (bytes: number) => {
      bufferSizes.push(bytes);
      return baseCreateReader(bytes);
    };

    const session = await openMatroskaDemuxWithRuntime(
      {
        url,
        sourceKey: "source-a",
        source: sourceFromRead(async (start, end) => new Uint8Array(end - start + 1).buffer),
        readerBufferBytes: Number.NaN
      },
      harness.runtime
    );

    expect(bufferSizes).toHaveLength(1);
    expect(Number.isFinite(bufferSizes[0])).toBe(true);
    expect(bufferSizes[0]).toBe(4 * 1024 * 1024);
    await session.destroy();
  });

  it("reports known length from onSize without reading when the total is unknown", async () => {
    const sourceRead = vi.fn(
      async (start: number, end: number) => new Uint8Array(end - start + 1).buffer
    );
    const source = sourceFromRead(sourceRead, -1);
    const harness = discoveryHarness({ open: vi.fn(async () => 0) });

    const session = await openMatroskaDemuxWithRuntime(
      { url, sourceKey: "source-a", source },
      harness.runtime
    );

    expect(sourceRead).not.toHaveBeenCalled();

    const size = await harness.reader.onSize();
    expect(size).toBe(0n);
    expect(sourceRead).not.toHaveBeenCalled();
    expect(session.readPosition).toBe(0);

    const supplied = await harness.reader.onFlush(new Uint8Array(16));
    expect(supplied).toBe(16);
    expect(sourceRead).toHaveBeenCalledTimes(1);
    expect(sourceRead.mock.calls[0][0]).toBe(0);

    await session.destroy();
  });
});

describe("Matroska demux read progress", () => {
  it("accepts only non-negative safe integer counters", () => {
    expect(isValidMatroskaDemuxReadProgress({ bytesScanned: 0, packetsScanned: 0 })).toBe(true);
    expect(
      isValidMatroskaDemuxReadProgress({
        bytesScanned: Number.MAX_SAFE_INTEGER,
        packetsScanned: Number.MAX_SAFE_INTEGER
      })
    ).toBe(true);

    for (const progress of [
      { bytesScanned: undefined, packetsScanned: 0 },
      { bytesScanned: Number.NaN, packetsScanned: 0 },
      { bytesScanned: -1, packetsScanned: 0 },
      { bytesScanned: 0.5, packetsScanned: 0 },
      { bytesScanned: Number.MAX_SAFE_INTEGER + 1, packetsScanned: 0 },
      { bytesScanned: 0, packetsScanned: undefined },
      { bytesScanned: 0, packetsScanned: Number.NaN },
      { bytesScanned: 0, packetsScanned: -1 },
      { bytesScanned: 0, packetsScanned: 0.5 },
      { bytesScanned: 0, packetsScanned: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      expect(isValidMatroskaDemuxReadProgress(progress)).toBe(false);
    }
  });
});

describe("Matroska demux resource lifecycle", () => {
  it("waits for the active operation and destroys resources exactly once", async () => {
    const activeOperation = deferred<void>();
    const abort = vi.fn();
    const destroyPacket = vi.fn();
    const destroyContext = vi.fn(async () => undefined);
    const gate = createMatroskaDemuxDestroyGate(() => activeOperation.promise, {
      abort,
      destroyPacket,
      destroyContext
    });

    const firstDestroy = gate.destroy();
    const secondDestroy = gate.destroy();
    expect(secondDestroy).toBe(firstDestroy);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(destroyPacket).not.toHaveBeenCalled();
    expect(destroyContext).not.toHaveBeenCalled();

    activeOperation.resolve();
    await Promise.all([firstDestroy, secondDestroy]);

    expect(destroyPacket).toHaveBeenCalledTimes(1);
    expect(destroyContext).toHaveBeenCalledTimes(1);
  });
});

describe("Matroska embedded subtitle track extraction", () => {
  it("extracts S_TEXT/UTF8 identity and metadata", () => {
    expect(extractEmbeddedSubtitleTrack(stream(), "source-a")).toEqual({
      id: "source-a:uid:42",
      sourceKey: "source-a",
      streamIndex: 2,
      trackNumber: 3,
      trackUid: "42",
      codecId: "S_TEXT/UTF8",
      language: "chi",
      name: "简体中文",
      isDefault: true,
      isForced: false,
      defaultDuration: "3000000000",
      timeBase: { num: 1, den: 1000 }
    });
  });

  it("rejects non-subtitle, non-SubRip, and non-S_TEXT/UTF8 streams", () => {
    expect(
      extractEmbeddedSubtitleTrack(
        stream({ codecpar: { codecType: 0, codecId: LIBMEDIA_CODEC_ID_SUBRIP } }),
        "source-a"
      )
    ).toBeNull();
    expect(
      extractEmbeddedSubtitleTrack(
        stream({ codecpar: { codecType: LIBMEDIA_MEDIA_TYPE_SUBTITLE, codecId: 94230 } }),
        "source-a"
      )
    ).toBeNull();
    expect(
      extractEmbeddedSubtitleTrack(stream({ privData: { codecId: "S_TEXT/ASS" } }), "source-a")
    ).toBeNull();
  });

  it("keeps subrip streams whose TrackEntry was not populated", () => {
    // Regression: fastOpen does not guarantee a parsed TrackEntry on privData,
    // and codecpar.codecId is authoritative (IMatroskaFormat maps only
    // S_TEXT/UTF8 onto AV_CODEC_ID_SUBRIP). A missing or partial entry must not
    // silently drop a real subrip track, which produced an empty subtitle menu
    // on a real Emby MKV whose tracks MediaInfo confirmed as subrip.
    const cases: unknown[] = [undefined, null, {}, { number: 3, uid: 42n }];
    for (const privData of cases) {
      const track = extractEmbeddedSubtitleTrack(stream({ privData }), "source-a");
      expect(track).not.toBeNull();
      expect(track?.codecId).toBe("S_TEXT/UTF8");
    }
  });

  it("uses stream metadata and disposition when TrackEntry fields are absent", () => {
    const result = extractEmbeddedSubtitleTrack(
      stream({
        metadata: { language: "eng", title: "English" },
        disposition: LIBMEDIA_DISPOSITION_DEFAULT | LIBMEDIA_DISPOSITION_FORCED,
        privData: { number: 9, codecId: "S_TEXT/UTF8" }
      }),
      "source-b"
    );

    expect(result).toMatchObject({
      id: "source-b:track:9",
      language: "eng",
      name: "English",
      isDefault: true,
      isForced: true
    });
  });

  it("falls back to stream index only when Matroska identity is unavailable", () => {
    expect(subtitleTrackIdentity("source-c", 7)).toBe("source-c:stream:7");
  });

  it("filters a mixed stream list", () => {
    const tracks = extractEmbeddedSubtitleTracks(
      [stream(), stream({ index: 4, codecpar: { codecType: 1, codecId: 0 } })],
      "source-a"
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0].streamIndex).toBe(2);
  });
});

const track: EmbeddedSubtitleTrack = {
  id: "source-a:track:3",
  sourceKey: "source-a",
  streamIndex: 2,
  trackNumber: 3,
  codecId: "S_TEXT/UTF8",
  isDefault: true,
  isForced: false,
  timeBase: { num: 1, den: 1000 }
};

function cue(overrides: Partial<EmbeddedSubtitleCueDraft> = {}): EmbeddedSubtitleCueDraft {
  return {
    sourceKey: "source-a",
    trackId: track.id,
    startSeconds: 1,
    text: "Hello",
    ...overrides
  };
}

describe("Matroska subtitle packet conversion", () => {
  it("normalizes BOM, NUL and CRLF without trimming visible text", () => {
    const payload = new TextEncoder().encode("\uFEFF first\r\nsec\0ond\rthird ");
    expect(cleanUtf8SubtitleText(payload)).toBe(" first\nsecond\nthird ");
    expect(cleanUtf8SubtitleText(new Uint8Array())).toBeNull();
    expect(cleanUtf8SubtitleText(new TextEncoder().encode("\0\r\n  "))).toBeNull();
  });

  it("converts PTS and duration with the packet time base", () => {
    expect(timestampToSeconds(2_500n, { num: 1, den: 1000 })).toBe(2.5);
    expect(durationToSeconds(750n, { num: 1, den: 1000 })).toBe(0.75);
    expect(durationToSeconds(0n, { num: 1, den: 1000 })).toBeUndefined();
  });

  it("ignores AV_NOPTS_VALUE and empty subtitle text", () => {
    const payload = new TextEncoder().encode("hello");
    expect(timestampToSeconds(LIBMEDIA_AV_NOPTS_VALUE, track.timeBase)).toBeNull();
    expect(
      createEmbeddedSubtitlePacket({
        sourceKey: track.sourceKey,
        track,
        streamIndex: track.streamIndex,
        pts: LIBMEDIA_AV_NOPTS_VALUE,
        duration: 1_000n,
        timeBase: track.timeBase,
        payload
      })
    ).toBeNull();
    expect(
      createEmbeddedSubtitlePacket({
        sourceKey: track.sourceKey,
        track,
        streamIndex: track.streamIndex,
        pts: 1_000n,
        duration: 1_000n,
        timeBase: track.timeBase,
        payload: new TextEncoder().encode("\0  \r\n")
      })
    ).toBeNull();
  });

  it("copies packet payload before returning it", () => {
    const payload = new TextEncoder().encode("hello");
    const packet = createEmbeddedSubtitlePacket({
      sourceKey: track.sourceKey,
      track,
      streamIndex: track.streamIndex,
      pts: 1_500n,
      duration: 500n,
      timeBase: track.timeBase,
      payload
    });

    expect(packet).toMatchObject({ ptsSeconds: 1.5, durationSeconds: 0.5, text: "hello" });
    expect(packet?.payload).not.toBe(payload);
    payload[0] = 0;
    expect(new TextDecoder().decode(packet?.payload)).toBe("hello");
  });
});

describe("Matroska subtitle cue staging", () => {
  it("prefers packet duration over the next cue start", () => {
    const result = finalizeSubtitleCue(cue({ durationSeconds: 2 }), 10);
    expect(result.endSeconds).toBe(3);
  });

  it("backfills missing duration from the next cue start", () => {
    let stage = createSubtitleCueStage();
    const first = stageSubtitleCue(stage, cue({ startSeconds: 1 }));
    stage = first.stage;
    expect(first.cue).toBeNull();

    const second = stageSubtitleCue(stage, cue({ startSeconds: 4, text: "Next" }));
    expect(second.cue).toMatchObject({ startSeconds: 1, endSeconds: 4, text: "Hello" });
  });

  it("uses a capped default duration for the final cue", () => {
    const staged = stageSubtitleCue(createSubtitleCueStage(), cue({ startSeconds: 9 }));
    const flushed = flushSubtitleCueStage(staged.stage, {
      defaultDurationSeconds: 30,
      maxDefaultDurationSeconds: 5
    });
    expect(flushed.cue).toMatchObject({ startSeconds: 9, endSeconds: 14 });
    expect(flushed.stage.pending).toBeNull();
  });

  it("prevents end <= start", () => {
    const result = finalizeSubtitleCue(cue({ durationSeconds: -1 }), undefined, {
      defaultDurationSeconds: 0,
      maxDefaultDurationSeconds: 0,
      minimumDurationSeconds: 0.01
    });
    expect(result.endSeconds).toBeCloseTo(1.01);
  });

  it("deduplicates only when source, track, start and text all match", () => {
    const firstCue = cue();
    const first = stageSubtitleCue(createSubtitleCueStage(), firstCue);
    const duplicate = stageSubtitleCue(first.stage, firstCue);
    expect(duplicate.stage).toBe(first.stage);
    expect(duplicate.cue).toBeNull();

    expect(subtitleCueKey(cue({ trackId: "other-track" }))).not.toBe(subtitleCueKey(firstCue));
    expect(subtitleCueKey(cue({ sourceKey: "source-b" }))).not.toBe(subtitleCueKey(firstCue));
    expect(subtitleCueKey(cue({ startSeconds: 2 }))).not.toBe(subtitleCueKey(firstCue));
    expect(subtitleCueKey(cue({ text: "Different" }))).not.toBe(subtitleCueKey(firstCue));
  });
});
