import { describe, expect, it, vi } from "vitest";

import {
  createEmbeddedSubtitleController,
  type EmbeddedSubtitleFailure,
  type EmbeddedSubtitleSessionOpener
} from "../controller";
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
const SOURCE_A_REFRESHED = {
  url: "https://secret.example/private-a.mkv?token=refreshed",
  sourceKey: SOURCE_A.sourceKey
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

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
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

  it("lets a pending discovery settle stale after disable without leaking its session", async () => {
    const pendingSession = deferred<MatroskaDemuxSession>();
    const session = fakeSession();
    const openSession = vi.fn<EmbeddedSubtitleSessionOpener>(({ signal }) => {
      signal.addEventListener("abort", () => pendingSession.reject(abortError()), { once: true });
      return pendingSession.promise;
    });
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0
    });

    const discovery = controller.discover();
    await waitFor(() => openSession.mock.calls.length === 1);
    const discoverySignal = openSession.mock.calls[0]![0].signal;

    await controller.disable();
    expect(discoverySignal.aborted).toBe(false);

    pendingSession.resolve(session);
    await expect(discovery).resolves.toEqual([]);
    expect(session.destroy).toHaveBeenCalledTimes(1);
    expect(controller.tracks).toEqual([]);
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
      const recoveredSession = fakeSession(subtitleTrack);
      const output = renderer();
      const failures: EmbeddedSubtitleFailure[] = [];
      const openSession = vi
        .fn<EmbeddedSubtitleSessionOpener>()
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(recoveredSession);
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
      expect(openSession).toHaveBeenCalledTimes(2);
      expect(session.read).toHaveBeenCalledTimes(1);
      expect(controller.tracks).toEqual([subtitleTrack]);
      expect(failures).toHaveLength(1);
    }
  );

  it("keeps embedded subtitles enabled when a per-pump scan limit is reached", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      limitResult({ bytesScanned: 64, packetsScanned: 6 })
    ]);
    const failures: EmbeddedSubtitleFailure[] = [];
    const output = renderer();
    const openSession = vi.fn(async () => session);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: output,
      getCurrentTime: () => 0,
      maxBytesScannedPerPump: 64,
      maxPacketsScannedPerPump: 6,
      onFailure: (failure) => failures.push(failure)
    });

    await controller.discover();
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(true);

    expect(session.read).toHaveBeenCalledWith(subtitleTrack.id, {
      maxBytesScanned: 64,
      maxPacketsScanned: 6
    });
    expect(failures).toEqual([]);
    expect(session.destroy).not.toHaveBeenCalled();
    expect(controller.tracks).toEqual([subtitleTrack]);
    expect(controller.selectedTrack).toEqual(subtitleTrack);
    expect(output.setActive).toHaveBeenLastCalledWith(true);
  });

  it("resumes scanning on the next timeupdate after a per-pump scan limit", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      limitResult({ bytesScanned: 64, packetsScanned: 6 }),
      packetResult(packet(subtitleTrack, { ptsSeconds: 2, text: "Resumed" })),
      endResult()
    ]);
    const output = renderer();
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => now,
      maxBytesScannedPerPump: 64,
      maxPacketsScannedPerPump: 6
    });

    await controller.discover();
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(true);
    expect(session.read).toHaveBeenCalledTimes(1);
    expect(output.add).not.toHaveBeenCalled();

    now = 1;
    await controller.handleTimeUpdate();

    expect(session.read.mock.calls.length).toBeGreaterThan(1);
    expect(output.add).toHaveBeenCalledWith(
      expect.objectContaining({ startSeconds: 2, endSeconds: 4, text: "Resumed" })
    );
    expect(controller.selectedTrack).toEqual(subtitleTrack);
  });

  it("delivers a cue after a sparse stretch of exhausting reads", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      limitResult({ bytesScanned: 1000, packetsScanned: 4 }),
      limitResult({ bytesScanned: 1000, packetsScanned: 4 }),
      limitResult({ bytesScanned: 1000, packetsScanned: 4 }),
      packetResult(packet(subtitleTrack, { ptsSeconds: 4, text: "Sparse" }), {
        bytesScanned: 1000,
        packetsScanned: 4
      }),
      endResult()
    ]);
    const output = renderer();
    const failures: EmbeddedSubtitleFailure[] = [];
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => now,
      maxBytesScannedPerPump: 1000,
      maxPacketsScannedPerPump: 4,
      maxBytesScannedPerSession: 1_000_000,
      onFailure: (failure) => failures.push(failure)
    });

    await controller.discover();
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(true);

    for (let index = 1; index <= 4; index += 1) {
      now = index;
      await controller.handleTimeUpdate();
    }

    expect(failures).toEqual([]);
    expect(controller.selectedTrack).toEqual(subtitleTrack);
    expect(output.add).toHaveBeenCalledWith(
      expect.objectContaining({ startSeconds: 4, endSeconds: 6, text: "Sparse" })
    );
  });

  it("disables with a sanitized scan-budget failure when the session scan cap is exceeded", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      limitResult({ bytesScanned: 100, packetsScanned: 4 }),
      limitResult({ bytesScanned: 100, packetsScanned: 4 })
    ]);
    const failures: EmbeddedSubtitleFailure[] = [];
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: renderer(),
      getCurrentTime: () => now,
      maxBytesScannedPerPump: 100,
      maxPacketsScannedPerPump: 4,
      maxBytesScannedPerSession: 150,
      onFailure: (failure) => failures.push(failure)
    });

    await controller.discover();
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(true);
    expect(failures).toEqual([]);

    now = 1;
    await controller.handleTimeUpdate();

    expect(failures).toEqual([
      {
        code: "scan-budget",
        message: "Embedded subtitles were disabled because this file requires too much scanning."
      }
    ]);
    expect(JSON.stringify(failures)).not.toContain(SOURCE_A.url);
    expect(session.destroy).toHaveBeenCalledTimes(1);
    expect(controller.tracks).toEqual([]);
    expect(controller.selectedTrack).toBeNull();
  });

  it("resets cumulative session scanning when the source changes", async () => {
    const firstTrack = track(SOURCE_A.sourceKey);
    const secondTrack = track(SOURCE_B.sourceKey);
    const first = fakeSession(firstTrack, [limitResult({ bytesScanned: 100, packetsScanned: 4 })]);
    const second = fakeSession(secondTrack, [
      limitResult({ bytesScanned: 100, packetsScanned: 4 }),
      packetResult(packet(secondTrack, { ptsSeconds: 2, text: "Fresh" })),
      endResult()
    ]);
    const sessions = [first, second];
    const failures: EmbeddedSubtitleFailure[] = [];
    const output = renderer();
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => sessions.shift()!),
      renderer: output,
      getCurrentTime: () => now,
      maxBytesScannedPerPump: 100,
      maxPacketsScannedPerPump: 4,
      maxBytesScannedPerSession: 150,
      onFailure: (failure) => failures.push(failure)
    });

    await controller.discover();
    await expect(controller.selectTrack(firstTrack.id)).resolves.toBe(true);

    await expect(controller.updateSource(SOURCE_B)).resolves.toEqual([secondTrack]);
    await expect(controller.selectTrack(secondTrack.id)).resolves.toBe(true);
    expect(failures).toEqual([]);

    now = 1;
    await controller.handleTimeUpdate();

    expect(failures).toEqual([]);
    expect(controller.selectedTrack).toEqual(secondTrack);
    expect(output.add).toHaveBeenCalledWith(expect.objectContaining({ text: "Fresh" }));
  });

  it("ends the pump without disabling when accumulated progress exhausts the pump budget", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack, [
      packetResult(packet(subtitleTrack), { bytesScanned: 16, packetsScanned: 4 })
    ]);
    const failures: EmbeddedSubtitleFailure[] = [];
    const output = renderer();
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => session),
      renderer: output,
      getCurrentTime: () => 0,
      maxBytesScannedPerPump: 16,
      maxPacketsScannedPerPump: 4,
      onFailure: (failure) => failures.push(failure)
    });

    await controller.discover();
    await expect(controller.selectTrack(subtitleTrack.id)).resolves.toBe(true);

    expect(session.read).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
    expect(session.destroy).not.toHaveBeenCalled();
    expect(output.add).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello" }));
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

  it("does not abort an in-flight discovery when startup room sync seeks", async () => {
    const pendingSession = deferred<MatroskaDemuxSession>();
    const session = fakeSession();
    const openSession = vi.fn<EmbeddedSubtitleSessionOpener>(() => pendingSession.promise);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0
    });

    const discovery = controller.discover();
    await waitFor(() => openSession.mock.calls.length === 1);
    const discoverySignal = openSession.mock.calls[0]![0].signal;

    await expect(controller.handleSeek(30)).resolves.toBe(false);
    expect(discoverySignal.aborted).toBe(false);

    pendingSession.resolve(session);
    await expect(discovery).resolves.toEqual([track()]);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(controller.tracks).toEqual([track()]);
  });

  it("recovers tracks on timeupdate after an aborted discovery", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const session = fakeSession();
      const failures: EmbeddedSubtitleFailure[] = [];
      const openSession = vi
        .fn<EmbeddedSubtitleSessionOpener>()
        .mockRejectedValueOnce(abortError())
        .mockResolvedValueOnce(session);
      const controller = createEmbeddedSubtitleController({
        source: SOURCE_A,
        openSession,
        renderer: renderer(),
        getCurrentTime: () => 0,
        onFailure: (failure) => failures.push(failure)
      });

      await expect(controller.discover()).resolves.toEqual([]);
      vi.setSystemTime(2_000);
      await controller.handleTimeUpdate();

      expect(openSession).toHaveBeenCalledTimes(2);
      expect(controller.tracks).toEqual([track()]);
      expect(failures).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds automatic discovery recovery attempts", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const openSession = vi.fn<EmbeddedSubtitleSessionOpener>(async () => {
        throw abortError();
      });
      const controller = createEmbeddedSubtitleController({
        source: SOURCE_A,
        openSession,
        renderer: renderer(),
        getCurrentTime: () => 0
      });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        vi.setSystemTime(attempt * 2_000);
        await controller.handleTimeUpdate();
      }
      expect(openSession).toHaveBeenCalledTimes(5);

      vi.setSystemTime(60_000);
      await controller.handleTimeUpdate();
      await controller.handleTimeUpdate();
      expect(openSession).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry discovery while an open is already pending", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const pendingSession = deferred<MatroskaDemuxSession>();
      const session = fakeSession();
      const openSession = vi.fn<EmbeddedSubtitleSessionOpener>(() => pendingSession.promise);
      const controller = createEmbeddedSubtitleController({
        source: SOURCE_A,
        openSession,
        renderer: renderer(),
        getCurrentTime: () => 0
      });

      const firstUpdate = controller.handleTimeUpdate();
      await waitFor(() => openSession.mock.calls.length === 1);

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        vi.setSystemTime(attempt * 2_000);
        await controller.handleTimeUpdate();
      }
      expect(openSession).toHaveBeenCalledTimes(1);

      pendingSession.resolve(session);
      await firstUpdate;
      expect(controller.tracks).toEqual([track()]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the discovery retry budget when the real source changes", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const openSession = vi.fn<EmbeddedSubtitleSessionOpener>(async () => {
        throw abortError();
      });
      const controller = createEmbeddedSubtitleController({
        source: SOURCE_A,
        openSession,
        renderer: renderer(),
        getCurrentTime: () => 0
      });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        vi.setSystemTime(attempt * 2_000);
        await controller.handleTimeUpdate();
      }
      expect(openSession).toHaveBeenCalledTimes(5);

      vi.setSystemTime(10_000);
      await controller.updateSource(SOURCE_B);
      expect(openSession).toHaveBeenCalledTimes(6);

      vi.setSystemTime(12_000);
      await controller.handleTimeUpdate();
      expect(openSession).toHaveBeenCalledTimes(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeks an established session without destroying it", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack);
    const openSession = vi.fn(async () => session);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    session.seek.mockClear();

    await expect(controller.handleSeek(37)).resolves.toBe(true);

    expect(session.seek).toHaveBeenCalledWith(subtitleTrack.id, 37_000, {
      backward: true,
      anyFrame: true
    });
    expect(session.destroy).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledTimes(1);
  });

  it("reuses the open session across forward and backward seeks", async () => {
    const subtitleTrack = track();
    const only = fakeSession(subtitleTrack);
    const openSession = vi.fn(async () => only);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    const readsAfterSelect = only.read.mock.calls.length;

    await expect(controller.handleSeek(40)).resolves.toBe(true);
    await expect(controller.handleSeek(5)).resolves.toBe(true);

    // Subtitle tracks are file-level metadata: a seek must never destroy the
    // demux session, because re-discovering on every seek made subtitles
    // vanish after a few seconds on a real Emby MKV.
    expect(only.destroy).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(controller.tracks).toHaveLength(1);
    expect(controller.selectedTrack?.id).toBe(subtitleTrack.id);

    // Both seeks still reposition the demuxer and keep pumping.
    expect(only.seek).toHaveBeenCalledWith(subtitleTrack.id, 40000, expect.any(Object));
    expect(only.seek).toHaveBeenCalledWith(subtitleTrack.id, 5000, expect.any(Object));
    expect(only.read.mock.calls.length).toBeGreaterThan(readsAfterSelect);
  });

  it("rapid seeks prevent an older deferred read from adding cues", async () => {
    const subtitleTrack = track();
    const only = fakeSession(subtitleTrack);
    const staleRead = deferred<MatroskaDemuxReadResult>();
    const output = renderer();
    let now = 0;
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession: vi.fn(async () => only),
      renderer: output,
      getCurrentTime: () => now
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    output.add.mockClear();

    let staleReadIssued = false;
    only.read.mockImplementationOnce(() => {
      staleReadIssued = true;
      return staleRead.promise;
    });

    now = 40;
    const stalePump = controller.handleSeek(40);
    // Let the first seek actually reach session.read before superseding it.
    for (let step = 0; step < 40 && !staleReadIssued; step += 1) {
      await Promise.resolve();
    }
    expect(staleReadIssued).toBe(true);

    now = 5;
    const freshPump = controller.handleSeek(5);

    staleRead.resolve({
      status: "packet",
      bytesScanned: 1,
      packetsScanned: 1,
      packet: packet(subtitleTrack, { ptsSeconds: 41, text: "stale" })
    });

    await stalePump;
    await freshPump;

    const addedTexts = output.add.mock.calls.map((call) => call[0].text);
    expect(addedTexts).not.toContain("stale");
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

  it("keeps tracks and in-flight work alive across a token-only URL refresh", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack);
    const pendingRead = deferred<MatroskaDemuxReadResult>();
    session.read.mockImplementationOnce(() => pendingRead.promise);
    const tracksChanged = vi.fn();
    const openSession = vi.fn(async () => session);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0,
      onTracksChanged: tracksChanged
    });

    await controller.discover();
    const selecting = controller.selectTrack(subtitleTrack.id);
    await waitFor(() => session.read.mock.calls.length === 1);
    tracksChanged.mockClear();

    await expect(controller.updateSource(SOURCE_A_REFRESHED)).resolves.toEqual([subtitleTrack]);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect((openSession.mock.calls[0]?.[0].signal as AbortSignal).aborted).toBe(false);
    expect(session.destroy).not.toHaveBeenCalled();
    expect(controller.tracks).toEqual([subtitleTrack]);
    expect(controller.selectedTrack).toEqual(subtitleTrack);
    expect(tracksChanged).not.toHaveBeenCalledWith([]);

    pendingRead.resolve(endResult());
    await selecting;
    expect(controller.selectedTrack).toEqual(subtitleTrack);
  });

  it("keeps one session and a stable selection across repeated token refreshes", async () => {
    const subtitleTrack = track();
    const session = fakeSession(subtitleTrack);
    const openSession = vi.fn(async () => session);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0
    });

    await controller.discover();
    await controller.selectTrack(subtitleTrack.id);
    for (let index = 1; index <= 5; index += 1) {
      await expect(
        controller.updateSource({
          url: `https://secret.example/private-a.mkv?token=refresh-${index}`,
          sourceKey: SOURCE_A.sourceKey
        })
      ).resolves.toEqual([subtitleTrack]);
    }

    expect(openSession).toHaveBeenCalledTimes(1);
    expect(session.destroy).not.toHaveBeenCalled();
    expect(controller.tracks).toEqual([subtitleTrack]);
    expect(controller.selectedTrack).toEqual(subtitleTrack);
  });

  it("a different sourceKey still tears down and opens a new session", async () => {
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
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(openSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: SOURCE_B.url, sourceKey: SOURCE_B.sourceKey })
    );
  });

  it("uses the latest token URL after a later real source change", async () => {
    const first = fakeSession(track(SOURCE_A.sourceKey));
    const secondTrack = track(SOURCE_B.sourceKey);
    const second = fakeSession(secondTrack);
    const reopened = fakeSession(track(SOURCE_A.sourceKey));
    const sessions = [first, second, reopened];
    const openSession = vi.fn(async () => sessions.shift()!);
    const controller = createEmbeddedSubtitleController({
      source: SOURCE_A,
      openSession,
      renderer: renderer(),
      getCurrentTime: () => 0
    });

    await controller.discover();
    await controller.updateSource(SOURCE_A_REFRESHED);
    await controller.updateSource(SOURCE_B);
    await controller.updateSource(SOURCE_A_REFRESHED);

    expect(openSession).toHaveBeenCalledTimes(3);
    expect(openSession.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ url: SOURCE_A.url, sourceKey: SOURCE_A.sourceKey })
    );
    expect(openSession.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ url: SOURCE_B.url, sourceKey: SOURCE_B.sourceKey })
    );
    expect(openSession.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ url: SOURCE_A_REFRESHED.url, sourceKey: SOURCE_A.sourceKey })
    );
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
