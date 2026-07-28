import { describe, expect, it, vi } from "vitest";

import { createEmbeddedSubtitleController, type EmbeddedSubtitleFailure } from "../controller";
import type { EmbeddedSubtitleRenderer } from "../render";
import type {
  EmbeddedSubtitlePacket,
  EmbeddedSubtitleTrack,
  MatroskaDemuxReadProgress,
  MatroskaDemuxReadResult,
  MatroskaDemuxSession,
  MatroskaSeekResult
} from "../types";

const SOURCE_A = {
  url: "https://secret.example/private-a.mkv?token=hidden",
  sourceKey: "source-a"
};
const SOURCE_B = {
  url: "https://secret.example/private-b.mkv?token=hidden",
  sourceKey: "source-b"
};

function track(sourceKey = SOURCE_A.sourceKey): EmbeddedSubtitleTrack {
  return {
    id: `${sourceKey}:track:3`,
    sourceKey,
    streamIndex: 2,
    trackNumber: 3,
    codecId: "S_TEXT/UTF8",
    isDefault: true,
    isForced: false,
    timeBase: { num: 1, den: 1000 }
  };
}

function packet(
  subtitleTrack = track(),
  overrides: Partial<EmbeddedSubtitlePacket> = {}
): EmbeddedSubtitlePacket {
  return {
    sourceKey: subtitleTrack.sourceKey,
    trackId: subtitleTrack.id,
    streamIndex: subtitleTrack.streamIndex,
    ptsSeconds: 1,
    durationSeconds: 2,
    payload: new TextEncoder().encode("Hello"),
    text: "Hello",
    ...overrides
  };
}

function renderer(): EmbeddedSubtitleRenderer & {
  setActive: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  removeByKey: ReturnType<typeof vi.fn>;
  removeOutsideWindow: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  return {
    size: 0,
    setActive: vi.fn(),
    add: vi.fn(() => "added" as const),
    clear: vi.fn(),
    removeByKey: vi.fn(),
    removeOutsideWindow: vi.fn(),
    destroy: vi.fn()
  };
}

const NO_SCAN_PROGRESS: MatroskaDemuxReadProgress = {
  bytesScanned: 0,
  packetsScanned: 0
};

function endResult(progress: Partial<MatroskaDemuxReadProgress> = {}): MatroskaDemuxReadResult {
  return { status: "end", ...NO_SCAN_PROGRESS, ...progress };
}

function packetResult(
  subtitlePacket: EmbeddedSubtitlePacket,
  progress: Partial<MatroskaDemuxReadProgress> = {}
): MatroskaDemuxReadResult {
  return { status: "packet", packet: subtitlePacket, ...NO_SCAN_PROGRESS, ...progress };
}

function limitResult(progress: Partial<MatroskaDemuxReadProgress> = {}): MatroskaDemuxReadResult {
  return { status: "limit", ...NO_SCAN_PROGRESS, ...progress };
}

function fakeSession(
  subtitleTrack = track(),
  reads: MatroskaDemuxReadResult[] = [endResult()]
): MatroskaDemuxSession & {
  read: ReturnType<typeof vi.fn<MatroskaDemuxSession["read"]>>;
  seek: ReturnType<typeof vi.fn<MatroskaDemuxSession["seek"]>>;
  destroy: ReturnType<typeof vi.fn<MatroskaDemuxSession["destroy"]>>;
} {
  const queue = [...reads];
  return {
    tracks: [subtitleTrack],
    readPosition: 0,
    read: vi.fn<MatroskaDemuxSession["read"]>(async () => queue.shift() ?? endResult()),
    seek: vi.fn<MatroskaDemuxSession["seek"]>(
      async (): Promise<MatroskaSeekResult> => ({ status: "ok" })
    ),
    destroy: vi.fn<MatroskaDemuxSession["destroy"]>(async () => undefined)
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached");
}

async function settleWithin<T>(promise: Promise<T>, timeoutMilliseconds = 250): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Promise did not settle within ${timeoutMilliseconds}ms`)),
      timeoutMilliseconds
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

describe("embedded subtitle controller", () => {
  it("discovers tracks without reading Cluster packets", async () => {
    const session = fakeSession();
    const openSession = vi.fn(async () => session);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0
    });

    await expect(controller.discover()).resolves.toEqual([track()]);
    expect(session.read).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        url: SOURCE_A.url,
        sourceKey: SOURCE_A.sourceKey,
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("seeks and reads only after selecting an embedded track", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [packetResult(packet(subtitleTrack)), endResult()]);
    const output = renderer();
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => 12
    });

    await controller.discover();
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(true);

    expect(session.seek).toHaveBeenCalledWith(subtitleTrack.id, 12000, {
      backward: true,
      anyFrame: true
    });
    expect(session.read).toHaveBeenCalledTimes(2);
    expect(output.setActive).toHaveBeenCalledWith(true);
    expect(output.add).toHaveBeenCalledWith(
      expect.objectContaining({ startSeconds: 1, endSeconds: 3, text: "Hello" })
    );
  });

  it("disable invalidates an in-flight read and prevents stale cue writes", async () => {
    const subtitleTrack = track();
    const pendingRead = deferred<MatroskaDemuxReadResult>();
    const session = fakeSession(subtitleTrack);
    session.read.mockImplementationOnce(() => pendingRead.promise);
    const output = renderer();
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => 0
    });

    await controller.discover();
    const selecting = controller.selectTrack(subtitleTrack.id);
    await waitFor(() => session.read.mock.calls.length === 1);
    await controller.disable();
    pendingRead.resolve(packetResult(packet(subtitleTrack)));
    await selecting;

    expect(output.add).not.toHaveBeenCalled();
    expect(output.setActive).toHaveBeenLastCalledWith(false);
    expect(session.destroy).toHaveBeenCalledTimes(1);
    expect(controller.selectedTrack).toBeNull();
  });

  it("accumulates scan progress and passes remaining byte and packet budgets", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      packetResult(packet(subtitleTrack, { ptsSeconds: 1 }), {
        bytesScanned: 11,
        packetsScanned: 2
      }),
      packetResult(packet(subtitleTrack, { ptsSeconds: 3, text: "Second" }), {
        bytesScanned: 7,
        packetsScanned: 3
      }),
      endResult({ bytesScanned: 5, packetsScanned: 1 })
    ]);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: renderer(),
      getCurrentTime: () => 0,
      maxBytesScannedPerPump: 50,
      maxPacketsScannedPerPump: 10
    });

    await controller.discover();
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(true);

    expect(session.read.mock.calls).toEqual([
      [subtitleTrack.id, { maxBytesScanned: 50, maxPacketsScanned: 10 }],
      [subtitleTrack.id, { maxBytesScanned: 39, maxPacketsScanned: 8 }],
      [subtitleTrack.id, { maxBytesScanned: 32, maxPacketsScanned: 5 }]
    ]);
  });

  it.each([
    ["undefined bytes", { bytesScanned: undefined, packetsScanned: 0 }],
    ["undefined packets", { bytesScanned: 0, packetsScanned: undefined }],
    ["NaN bytes", { bytesScanned: Number.NaN, packetsScanned: 0 }],
    ["NaN packets", { bytesScanned: 0, packetsScanned: Number.NaN }],
    ["negative bytes", { bytesScanned: -1, packetsScanned: 0 }],
    ["negative packets", { bytesScanned: 0, packetsScanned: -1 }],
    ["fractional packets", { bytesScanned: 0, packetsScanned: 0.5 }]
  ])(
    "treats malformed %s progress as a sanitized terminal read failure",
    async (_label, progress) => {
      const subtitleTrack = track();
      const malformedResult = {
        status: "packet",
        packet: packet(subtitleTrack),
        ...progress
      } as MatroskaDemuxReadResult;
      const session = fakeSession(subtitleTrack, [malformedResult]);
      const output = renderer();
      const failures: EmbeddedSubtitleFailure[] = [];
      const openSession = vi.fn(async () => session);
      const controller = createEmbeddedSubtitleController({
        source: SOURCE_A,
        openSession,
        renderer: output,
        getCurrentTime: () => 0,
        onFailure: (failure) => failures.push(failure)
      });

      await controller.discover();
      await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(false);

      expect(failures).toEqual([
        { code: "read-failed", message: "Embedded subtitle data could not be read." }
      ]);
      expect(JSON.stringify(failures)).not.toContain(SOURCE_A.url);
      expect(session.read).toHaveBeenCalledTimes(1);
      expect(session.destroy).toHaveBeenCalledTimes(1);
      expect(output.add).not.toHaveBeenCalled();
      expect(controller.tracks).toEqual([]);
      expect(controller.selectedTrack).toBeNull();

      await controller.handleTimeUpdate();
      expect(openSession).toHaveBeenCalledTimes(1);
      expect(session.read).toHaveBeenCalledTimes(1);
    }
  );

  it("turns a demux scan limit into a terminal sanitized read-limit failure", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      limitResult({ bytesScanned: 64, packetsScanned: 6 })
    ]);
    const failures: EmbeddedSubtitleFailure[] = [];
    const openSession = vi.fn(async () => session);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0,
      maxBytesScannedPerPump: 64,
      maxPacketsScannedPerPump: 6,
      onFailure: (failure) => failures.push(failure)
    });

    await controller.discover();
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(false);

    expect(session.read).toHaveBeenCalledWith(subtitleTrack.id, {
      maxBytesScanned: 64,
      maxPacketsScanned: 6
    });
    expect(failures).toEqual([
      {
        code: "read-limit",
        message: "Embedded subtitles were disabled because this file requires too much scanning."
      }
    ]);
    expect(JSON.stringify(failures)).not.toContain(SOURCE_A.url);
    expect(session.destroy).toHaveBeenCalledTimes(1);
    expect(controller.tracks).toEqual([]);
    expect(controller.selectedTrack).toBeNull();

    await controller.handleTimeUpdate();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(session.read).toHaveBeenCalledTimes(1);
  });

  it("disables when accumulated progress exhausts the pump budget", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      packetResult(packet(subtitleTrack), { bytesScanned: 16, packetsScanned: 4 })
    ]);
    const failures: EmbeddedSubtitleFailure[] = [];
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: renderer(),
      getCurrentTime: () => 0,
      maxBytesScannedPerPump: 16,
      maxPacketsScannedPerPump: 4,
      onFailure: (failure) => failures.push(failure)
    });

    await controller.discover();
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(false);

    expect(session.read).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([
      {
        code: "read-limit",
        message: "Embedded subtitles were disabled because this file requires too much scanning."
      }
    ]);
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not continue pumping while paused and resumes on timeupdate", async () => {
    const subtitleTrack = track();
    let paused = false;
    const session = fakeSession(subtitleTrack);
    session.read
      .mockImplementationOnce(async () => {
        paused = true;
        return packetResult(packet(subtitleTrack));
      })
      .mockResolvedValueOnce(endResult());
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: renderer(),
      getCurrentTime: () => now,
      isPaused: () => paused
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    expect(session.read).toHaveBeenCalledTimes(1);

    now = 2;
    await controller.handleTimeUpdate();
    expect(session.read).toHaveBeenCalledTimes(1);

    paused = false;
    await controller.handleTimeUpdate();
    expect(session.read).toHaveBeenCalledTimes(2);
  });

  it("reopens and seeks safely for forward and backward seeks", async () => {
    const subtitleTrack = track();
    const first = fakeSession(subtitleTrack);
    const forward = fakeSession(subtitleTrack);
    const backward = fakeSession(subtitleTrack);
    const sessions = [first, forward, backward];
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => sessions.shift()!),
      renderer: renderer(),
      getCurrentTime: () => 0
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    await expect(controller.handleSeek(40)).resolves.toBe(true);
    await expect(controller.handleSeek(5)).resolves.toBe(true);

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(forward.destroy).toHaveBeenCalledTimes(1);
    expect(forward.seek).toHaveBeenCalledWith(subtitleTrack.id, 40000, expect.any(Object));
    expect(forward.read).toHaveBeenCalledTimes(1);
    expect(backward.seek).toHaveBeenCalledWith(subtitleTrack.id, 5000, expect.any(Object));
    expect(backward.read).toHaveBeenCalledTimes(1);
  });

  it("rapid seeks prevent an older deferred read from adding cues", async () => {
    const subtitleTrack = track();
    const initial = fakeSession(subtitleTrack);
    const stale = fakeSession(subtitleTrack);
    const latest = fakeSession(subtitleTrack);
    const staleRead = deferred<MatroskaDemuxReadResult>();
    stale.read.mockImplementationOnce(() => staleRead.promise);
    const sessions = [initial, stale, latest];
    const output = renderer();
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => sessions.shift()!),
      renderer: output,
      getCurrentTime: () => now
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    now = 30;
    const firstSeek = controller.handleSeek(30);
    await waitFor(() => stale.read.mock.calls.length === 1);
    now = 2;
    const secondSeek = controller.handleSeek(2);
    await secondSeek;
    staleRead.resolve(packetResult(packet(subtitleTrack, { ptsSeconds: 30, text: "Stale" })));
    await firstSeek;

    expect(output.add).not.toHaveBeenCalledWith(expect.objectContaining({ text: "Stale" }));
    expect(stale.destroy).toHaveBeenCalledTimes(1);
    expect(latest.seek).toHaveBeenCalledWith(subtitleTrack.id, 2000, expect.any(Object));
  });

  it("a stale rejected open cannot disable a newer source", async () => {
    const staleOpen = deferred<MatroskaDemuxSession>();
    const secondTrack = track(SOURCE_B.sourceKey);
    const second = fakeSession(secondTrack);
    const failures: EmbeddedSubtitleFailure[] = [];
    const openSession = vi
      .fn<() => Promise<MatroskaDemuxSession>>()
      .mockImplementationOnce(() => staleOpen.promise)
      .mockResolvedValueOnce(second);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0,
      onFailure: (failure) => failures.push(failure)
    });

    const firstDiscovery = controller.discover();
    await waitFor(() => openSession.mock.calls.length === 1);
    const sourceUpdate = controller.updateSource(SOURCE_B);
    staleOpen.reject(new Error(`Late open failure at ${SOURCE_A.url}`));

    await expect(settleWithin(firstDiscovery)).resolves.toEqual([]);
    await expect(settleWithin(sourceUpdate)).resolves.toEqual([secondTrack]);
    expect(failures).toEqual([]);
    expect(controller.tracks).toEqual([secondTrack]);
    expect(JSON.stringify(failures)).not.toContain(SOURCE_A.url);
  });

  it("source updates release the previous session and discover the new source", async () => {
    const first = fakeSession(track(SOURCE_A.sourceKey));
    const secondTrack = track(SOURCE_B.sourceKey);
    const second = fakeSession(secondTrack);
    const sessions = [first, second];
    const openSession = vi.fn(async () => sessions.shift()!);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0
    });

    await controller.discover();
    await expect(controller.updateSource(SOURCE_B)).resolves.toEqual([secondTrack]);

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: SOURCE_B.url, sourceKey: SOURCE_B.sourceKey })
    );
  });

  it("destroyed controllers never reopen sessions or write cues", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack);
    const output = renderer();
    const openSession = vi.fn(async () => session);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: output,
      getCurrentTime: () => 0
    });

    await controller.discover();
    await controller.destroy();
    output.add.mockClear();

    await expect(controller.discover()).resolves.toEqual([]);
    await expect(controller.updateSource(SOURCE_B)).resolves.toEqual([]);
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(false);
    await expect(controller.handleSeek(5)).resolves.toBe(false);
    await controller.handleTimeUpdate();
    await controller.disable();

    expect(openSession).toHaveBeenCalledTimes(1);
    expect(session.seek).not.toHaveBeenCalled();
    expect(session.read).not.toHaveBeenCalled();
    expect(output.add).not.toHaveBeenCalled();
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it("concurrent destroy calls share deferred cleanup and release resources exactly once", async () => {
    const session = fakeSession();
    const sessionCleanup = deferred<void>();
    session.destroy.mockImplementationOnce(() => sessionCleanup.promise);
    const output = renderer();
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => 0
    });

    await controller.discover();
    const firstDestroy = controller.destroy();
    const secondDestroy = controller.destroy();
    expect(secondDestroy).toBe(firstDestroy);
    await waitFor(() => session.destroy.mock.calls.length === 1);

    let secondSettled = false;
    void secondDestroy.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(output.destroy).toHaveBeenCalledTimes(1);

    sessionCleanup.resolve();
    await settleWithin(Promise.all([firstDestroy, secondDestroy]));

    expect(session.destroy).toHaveBeenCalledTimes(1);
    expect(output.destroy).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending duration-less cue when reading reaches end", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      packetResult(packet(subtitleTrack, { durationSeconds: undefined, ptsSeconds: 7 })),
      endResult()
    ]);
    const output = renderer();
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => 0
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);

    expect(output.add).toHaveBeenCalledWith(
      expect.objectContaining({ startSeconds: 7, endSeconds: 11, text: "Hello" })
    );
    expect(new Set(output.add.mock.calls.map(([cue]) => cue.key))).toHaveLength(1);
  });

  it("upgrades a resident duration-less cue when a later packet provides authoritative duration", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      packetResult(packet(subtitleTrack, { durationSeconds: undefined, ptsSeconds: 1 })),
      packetResult(packet(subtitleTrack, { ptsSeconds: 3, text: "Following cue" })),
      packetResult(packet(subtitleTrack, { durationSeconds: 9, ptsSeconds: 1 })),
      endResult()
    ]);
    const output = renderer();

    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);

    const logicalCueCalls = output.add.mock.calls.filter(
      ([cue]) => cue.startSeconds === 1 && cue.text === "Hello"
    );
    expect(logicalCueCalls).not.toHaveLength(0);
    expect(new Set(logicalCueCalls.map(([cue]) => cue.key))).toHaveLength(1);
    expect(logicalCueCalls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ startSeconds: 1, endSeconds: 10, text: "Hello" })
    );
    expect(output.removeByKey).toHaveBeenCalledTimes(1);
    expect(output.removeByKey).toHaveBeenCalledWith(logicalCueCalls[0]![0].key);
  });

  it("preserves duration-less staging across interleaved duration packets", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      packetResult(
        packet(subtitleTrack, {
          durationSeconds: undefined,
          ptsSeconds: 1,
          text: "First pending"
        })
      ),
      packetResult(packet(subtitleTrack, { ptsSeconds: 3, durationSeconds: 1, text: "Timed" })),
      packetResult(
        packet(subtitleTrack, {
          durationSeconds: undefined,
          ptsSeconds: 5,
          text: "Second pending"
        })
      ),
      packetResult(
        packet(subtitleTrack, {
          durationSeconds: undefined,
          ptsSeconds: 8,
          text: "Third pending"
        })
      ),
      endResult()
    ]);
    const output = renderer();
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => 0
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);

    const delivered = new Map(output.add.mock.calls.map(([cue]) => [cue.key, cue]));
    expect(Array.from(delivered.values())).toEqual([
      expect.objectContaining({ startSeconds: 1, endSeconds: 3, text: "First pending" }),
      expect.objectContaining({ startSeconds: 3, endSeconds: 4, text: "Timed" }),
      expect.objectContaining({ startSeconds: 5, endSeconds: 8, text: "Second pending" }),
      expect.objectContaining({ startSeconds: 8, endSeconds: 12, text: "Third pending" })
    ]);
  });

  it("retries unavailable delivery after EOF on a later timeupdate", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [packetResult(packet(subtitleTrack)), endResult()]);
    const output = renderer();
    let rendererReady = false;
    output.add.mockImplementation(() => (rendererReady ? "added" : "unavailable"));
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => now
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    expect(session.read).toHaveBeenCalledTimes(2);
    expect(output.add).toHaveReturnedWith("unavailable");

    output.add.mockClear();
    rendererReady = true;
    now = 1;
    await controller.handleTimeUpdate();

    expect(session.read).toHaveBeenCalledTimes(2);
    expect(output.add).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello" }));
    expect(output.add).toHaveReturnedWith("added");
  });

  it("keeps a sparse future cue cached until its delivery window reaches it", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      packetResult(
        packet(subtitleTrack, {
          ptsSeconds: 1000,
          durationSeconds: 2,
          text: "Far future"
        })
      ),
      endResult()
    ]);
    const output = renderer();
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => now,
      prefetchSeconds: 30,
      retainBehindSeconds: 30
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    expect(session.read).toHaveBeenCalledTimes(1);
    expect(output.add).not.toHaveBeenCalled();

    now = 500;
    await controller.handleTimeUpdate();
    expect(output.add).not.toHaveBeenCalled();

    now = 971;
    await controller.handleTimeUpdate();
    expect(output.add).toHaveBeenCalledWith(
      expect.objectContaining({ startSeconds: 1000, endSeconds: 1002, text: "Far future" })
    );
    expect(session.read).toHaveBeenCalledTimes(1);
  });

  it("drops invalid decoded cues instead of retrying them forever", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [packetResult(packet(subtitleTrack)), endResult()]);
    const output = renderer();
    output.add.mockReturnValue("invalid");
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => now
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    output.add.mockClear();
    now = 1;
    await controller.handleTimeUpdate();

    expect(output.add).not.toHaveBeenCalled();
  });

  it("reconfirms cached cues so renderer ownership can recover after replacement", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [packetResult(packet(subtitleTrack)), endResult()]);
    const output = renderer();
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => now
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    output.add.mockClear();
    now = 1;
    await controller.handleTimeUpdate();

    expect(output.add).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello" }));
  });

  it("treats renderer exceptions as unavailable and retries fail-open", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [packetResult(packet(subtitleTrack)), endResult()]);
    const output = renderer();
    let rendererReady = false;
    output.add.mockImplementation(() => {
      if (!rendererReady) throw new Error("TextTrack is not ready");
      return "added";
    });
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => now
    });

    await controller.discover();
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(true);
    output.add.mockClear();
    rendererReady = true;
    now = 1;
    await controller.handleTimeUpdate();

    expect(output.add).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello" }));
  });

  it("settles rejected opens with a fixed sanitized failure", async () => {
    const failures: EmbeddedSubtitleFailure[] = [];
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => {
        throw new Error(`CORS failure at ${SOURCE_A.url}`);
      }),
      renderer: renderer(),
      getCurrentTime: () => 0,
      onFailure: (failure) => failures.push(failure)
    });

    await expect(settleWithin(controller.discover())).resolves.toEqual([]);

    expect(failures).toEqual([
      {
        code: "open-failed",
        message: "Embedded subtitles are unavailable for this source."
      }
    ]);
    expect(JSON.stringify(failures)).not.toContain(SOURCE_A.url);
    expect(controller.tracks).toEqual([]);
  });

  it("settles spontaneous AbortError opens without reporting or self-waiting", async () => {
    const failures: EmbeddedSubtitleFailure[] = [];
    const output = renderer();
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => {
        const error = new Error(`Aborted while opening ${SOURCE_A.url}`);
        error.name = "AbortError";
        throw error;
      }),
      renderer: output,
      getCurrentTime: () => 0,
      onFailure: (failure) => failures.push(failure)
    });

    await expect(settleWithin(controller.discover())).resolves.toEqual([]);

    expect(failures).toEqual([]);
    expect(controller.tracks).toEqual([]);
    expect(output.setActive).toHaveBeenLastCalledWith(false);
  });

  it("reports fixed read and seek failure types without exposing source URLs", async () => {
    const subtitleTrack = track();
    const readFailure = fakeSession(subtitleTrack);
    readFailure.read.mockRejectedValueOnce(new Error(`Read failed for ${SOURCE_A.url}`));
    const seekFailure = fakeSession(subtitleTrack);
    seekFailure.seek.mockRejectedValueOnce(new Error(`Seek failed for ${SOURCE_A.url}`));
    const failures: EmbeddedSubtitleFailure[] = [];
    const sessions = [readFailure, seekFailure];
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => sessions.shift()!),
      renderer: renderer(),
      getCurrentTime: () => 0,
      onFailure: (failure) => failures.push(failure)
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);

    expect(failures).toEqual([
      { code: "read-failed", message: "Embedded subtitle data could not be read." },
      { code: "seek-failed", message: "Embedded subtitles could not be positioned." }
    ]);
    expect(JSON.stringify(failures)).not.toContain(SOURCE_A.url);
  });
});
