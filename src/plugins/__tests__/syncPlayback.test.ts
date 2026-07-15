import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlaybackCoordinator, type PlaybackSnapshot } from "../syncPlayback";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

const setup = (initialPlaying = false) => {
  let status: PlaybackSnapshot = {
    isPlaying: initialPlaying,
    currentTime: 10,
    playbackRate: 1
  };
  const published: PlaybackSnapshot[] = [];
  let coordinator: ReturnType<typeof createPlaybackCoordinator>;

  coordinator = createPlaybackCoordinator({
    currentStatus: () => ({ ...status }),
    play: async () => {
      status.isPlaying = true;
      coordinator.handleMediaEvent(true);
      return true;
    },
    pause: () => {
      status.isPlaying = false;
      coordinator.handleMediaEvent(false);
    },
    publish: (playbackStatus) => published.push(playbackStatus)
  });

  return {
    coordinator,
    published,
    setStatus: (next: Partial<PlaybackSnapshot>) => {
      status = { ...status, ...next };
    }
  };
};

describe("playback coordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("publishes local play and pause symmetrically with execution-time media values", () => {
    const { coordinator, published, setStatus } = setup();

    coordinator.handleMediaEvent(true);
    setStatus({ currentTime: 12, playbackRate: 1.25 });
    vi.advanceTimersByTime(500);
    coordinator.handleMediaEvent(false);
    setStatus({ currentTime: 14, playbackRate: 1.5 });
    vi.advanceTimersByTime(500);

    expect(published).toEqual([
      { isPlaying: true, currentTime: 12, playbackRate: 1.25 },
      { isPlaying: false, currentTime: 14, playbackRate: 1.5 }
    ]);
  });

  it.each([
    [true, false],
    [false, true]
  ])("publishes only the latest state for %s -> %s within 500ms", (first, latest) => {
    const { coordinator, published } = setup(!first);

    coordinator.handleMediaEvent(first);
    vi.advanceTimersByTime(250);
    coordinator.handleMediaEvent(latest);
    vi.advanceTimersByTime(500);

    expect(published).toEqual([{ isPlaying: latest, currentTime: 10, playbackRate: 1 }]);
  });

  it("does not echo remote play or pause events", async () => {
    const { coordinator, published } = setup();

    await coordinator.applyRemote(true);
    await coordinator.applyRemote(false);
    vi.advanceTimersByTime(500);

    expect(published).toEqual([]);
  });

  it("keeps a delayed remote play from overriding a newer remote pause", async () => {
    let status: PlaybackSnapshot = { isPlaying: false, currentTime: 10, playbackRate: 1 };
    const playResult = deferred<boolean>();
    const published: PlaybackSnapshot[] = [];
    let coordinator: ReturnType<typeof createPlaybackCoordinator>;

    coordinator = createPlaybackCoordinator({
      currentStatus: () => ({ ...status }),
      play: () => playResult.promise,
      pause: () => {
        status.isPlaying = false;
        coordinator.handleMediaEvent(false);
      },
      publish: (playbackStatus) => published.push(playbackStatus)
    });

    const remotePlay = coordinator.applyRemote(true);
    await coordinator.applyRemote(false);
    status.isPlaying = true;
    coordinator.handleMediaEvent(true);
    playResult.resolve(true);
    await remotePlay;
    vi.advanceTimersByTime(500);

    expect(status.isPlaying).toBe(false);
    expect(published).toEqual([]);
  });

  it("publishes a real user event after a remote event", async () => {
    const { coordinator, published, setStatus } = setup();

    await coordinator.applyRemote(true);
    setStatus({ isPlaying: false, currentTime: 20 });
    coordinator.handleMediaEvent(false);
    vi.advanceTimersByTime(500);

    expect(published).toEqual([{ isPlaying: false, currentTime: 20, playbackRate: 1 }]);
  });

  it("retries only the newer remote play after an in-flight play fails", async () => {
    let status: PlaybackSnapshot = { isPlaying: false, currentTime: 10, playbackRate: 1 };
    const firstPlayResult = deferred<boolean>();
    const published: PlaybackSnapshot[] = [];
    let playCalls = 0;
    let coordinator: ReturnType<typeof createPlaybackCoordinator>;

    coordinator = createPlaybackCoordinator({
      currentStatus: () => ({ ...status }),
      play: async () => {
        playCalls += 1;
        if (playCalls === 1) return firstPlayResult.promise;
        status.isPlaying = true;
        coordinator.handleMediaEvent(true);
        return true;
      },
      pause: () => {
        status.isPlaying = false;
        coordinator.handleMediaEvent(false);
      },
      publish: (playbackStatus) => published.push(playbackStatus)
    });

    const firstRemotePlay = coordinator.applyRemote(true);
    await coordinator.applyRemote(false);
    await coordinator.applyRemote(true);
    expect(playCalls).toBe(1);
    firstPlayResult.resolve(false);
    await firstRemotePlay;
    await Promise.resolve();
    vi.advanceTimersByTime(500);

    expect(playCalls).toBe(2);
    expect(status.isPlaying).toBe(true);
    expect(published).toEqual([]);
  });

  it("absorbs a rejected play without retrying when there is no newer request", async () => {
    const play = vi.fn().mockRejectedValue(new Error("play failed"));
    const coordinator = createPlaybackCoordinator({
      currentStatus: () => ({ isPlaying: false, currentTime: 10, playbackRate: 1 }),
      play,
      pause: vi.fn(),
      publish: vi.fn()
    });

    await expect(coordinator.applyRemote(true)).resolves.toBeUndefined();
    await Promise.resolve();

    expect(play).toHaveBeenCalledTimes(1);
  });

  it("retries only the latest remote play generation after an in-flight play rejects", async () => {
    let status: PlaybackSnapshot = { isPlaying: false, currentTime: 10, playbackRate: 1 };
    const firstPlayResult = deferred<boolean>();
    const published: PlaybackSnapshot[] = [];
    let playCalls = 0;
    let coordinator: ReturnType<typeof createPlaybackCoordinator>;

    coordinator = createPlaybackCoordinator({
      currentStatus: () => ({ ...status }),
      play: async () => {
        playCalls += 1;
        if (playCalls === 1) return firstPlayResult.promise;
        status.isPlaying = true;
        coordinator.handleMediaEvent(true);
        return true;
      },
      pause: () => {
        status.isPlaying = false;
        coordinator.handleMediaEvent(false);
      },
      publish: (playbackStatus) => published.push(playbackStatus)
    });

    const firstRemotePlay = coordinator.applyRemote(true);
    await coordinator.applyRemote(false);
    await coordinator.applyRemote(true);
    firstPlayResult.reject(new Error("play failed"));

    await expect(firstRemotePlay).resolves.toBeUndefined();
    await Promise.resolve();
    vi.advanceTimersByTime(500);

    expect(playCalls).toBe(2);
    expect(status.isPlaying).toBe(true);
    expect(published).toEqual([]);
  });

  it("does not let a completed play expectation swallow a later real play", async () => {
    let status: PlaybackSnapshot = { isPlaying: false, currentTime: 10, playbackRate: 1 };
    const published: PlaybackSnapshot[] = [];
    const coordinator = createPlaybackCoordinator({
      currentStatus: () => ({ ...status }),
      play: async () => {
        status.isPlaying = true;
        return true;
      },
      pause: () => {
        status.isPlaying = false;
      },
      publish: (playbackStatus) => published.push(playbackStatus)
    });

    await coordinator.applyRemote(true);
    status = { ...status, isPlaying: false };
    status = { ...status, isPlaying: true, currentTime: 30 };
    coordinator.handleMediaEvent(true);
    vi.advanceTimersByTime(500);

    expect(published).toEqual([{ isPlaying: true, currentTime: 30, playbackRate: 1 }]);
  });

  it("clears an unobserved pause expectation when remote pause is already satisfied", async () => {
    let status: PlaybackSnapshot = { isPlaying: true, currentTime: 10, playbackRate: 1 };
    const published: PlaybackSnapshot[] = [];
    const coordinator = createPlaybackCoordinator({
      currentStatus: () => ({ ...status }),
      play: async () => true,
      pause: () => {
        status.isPlaying = false;
      },
      publish: (playbackStatus) => published.push(playbackStatus)
    });

    await coordinator.applyRemote(false);
    await coordinator.applyRemote(false);
    status = { ...status, isPlaying: true };
    status = { ...status, isPlaying: false, currentTime: 40 };
    coordinator.handleMediaEvent(false);
    vi.advanceTimersByTime(500);

    expect(published).toEqual([{ isPlaying: false, currentTime: 40, playbackRate: 1 }]);
  });

  it("clears older opposite expectations after observing a newer remote event", async () => {
    let status: PlaybackSnapshot = { isPlaying: true, currentTime: 10, playbackRate: 1 };
    const published: PlaybackSnapshot[] = [];
    let coordinator: ReturnType<typeof createPlaybackCoordinator>;

    coordinator = createPlaybackCoordinator({
      currentStatus: () => ({ ...status }),
      play: async () => {
        status.isPlaying = true;
        coordinator.handleMediaEvent(true);
        return true;
      },
      pause: () => {
        status.isPlaying = false;
      },
      publish: (playbackStatus) => published.push(playbackStatus)
    });

    await coordinator.applyRemote(false);
    await coordinator.applyRemote(true);
    status = { ...status, isPlaying: false, currentTime: 50 };
    coordinator.handleMediaEvent(false);
    vi.advanceTimersByTime(500);

    expect(published).toEqual([{ isPlaying: false, currentTime: 50, playbackRate: 1 }]);
  });

  it("keeps the latest remote pause when play rejects after play-pause-play-pause", async () => {
    let status: PlaybackSnapshot = { isPlaying: false, currentTime: 10, playbackRate: 1 };
    const playResult = deferred<boolean>();
    const published: PlaybackSnapshot[] = [];
    const pause = vi.fn(() => {
      status.isPlaying = false;
    });
    const play = vi.fn(() => playResult.promise);
    const coordinator = createPlaybackCoordinator({
      currentStatus: () => ({ ...status }),
      play,
      pause,
      publish: (playbackStatus) => published.push(playbackStatus)
    });

    const firstRemotePlay = coordinator.applyRemote(true);
    await coordinator.applyRemote(false);
    await coordinator.applyRemote(true);
    await coordinator.applyRemote(false);
    playResult.reject(new Error("play failed"));

    await expect(firstRemotePlay).resolves.toBeUndefined();
    await Promise.resolve();
    vi.advanceTimersByTime(500);

    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
    expect(status.isPlaying).toBe(false);
    expect(published).toEqual([]);
  });

  it("does not continue an in-flight play after destroy", async () => {
    let status: PlaybackSnapshot = { isPlaying: false, currentTime: 10, playbackRate: 1 };
    const playResult = deferred<boolean>();
    const pause = vi.fn();
    const publish = vi.fn();
    const coordinator = createPlaybackCoordinator({
      currentStatus: () => ({ ...status }),
      play: () => playResult.promise,
      pause,
      publish
    });

    const remotePlay = coordinator.applyRemote(true);
    coordinator.destroy();
    status.isPlaying = true;
    coordinator.handleMediaEvent(true);
    playResult.resolve(true);
    await remotePlay;
    vi.advanceTimersByTime(500);

    expect(pause).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not publish a delayed state after destroy", () => {
    const { coordinator, published } = setup();

    coordinator.handleMediaEvent(true);
    coordinator.destroy();
    vi.advanceTimersByTime(500);

    expect(published).toEqual([]);
  });
});
