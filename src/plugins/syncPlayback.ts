export interface PlaybackSnapshot {
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
}

interface PlaybackCoordinatorOptions {
  currentStatus: () => PlaybackSnapshot;
  play: () => Promise<boolean>;
  pause: () => void;
  publish: (status: PlaybackSnapshot) => void;
}

type PlaybackEvent = "play" | "pause";

export const createPlaybackCoordinator = (
  options: PlaybackCoordinatorOptions,
  debounceTime = 500
) => {
  let generation = 0;
  let latestIsPlaying = options.currentStatus().isPlaying;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activePlayGeneration: number | undefined;
  let latestRemotePlayGeneration: number | undefined;
  let destroyed = false;
  const expectedEvents: { event: PlaybackEvent; generation: number }[] = [];

  const cancelPublication = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const expectEvent = (event: PlaybackEvent, eventGeneration: number) => {
    expectedEvents.push({ event, generation: eventGeneration });
  };

  const removeExpectedEvent = (event: PlaybackEvent, eventGeneration: number) => {
    const index = expectedEvents.findIndex(
      (expected) => expected.event === event && expected.generation === eventGeneration
    );
    if (index !== -1) expectedEvents.splice(index, 1);
  };

  const removeExpectedEventsThrough = (eventGeneration: number) => {
    for (let index = expectedEvents.length - 1; index >= 0; index -= 1) {
      if (expectedEvents[index].generation <= eventGeneration) expectedEvents.splice(index, 1);
    }
  };

  const removeSettledExpectedEvents = (event: PlaybackEvent) => {
    for (let index = expectedEvents.length - 1; index >= 0; index -= 1) {
      const expected = expectedEvents[index];
      const isActivePlay =
        expected.event === "play" && expected.generation === activePlayGeneration;
      if (expected.event === event && !isActivePlay) expectedEvents.splice(index, 1);
    }
  };

  const handleMediaEvent = (isPlaying: boolean) => {
    if (destroyed) return;

    const event: PlaybackEvent = isPlaying ? "play" : "pause";
    const expectedIndex = expectedEvents.findIndex((expected) => expected.event === event);
    if (expectedIndex !== -1) {
      removeExpectedEventsThrough(expectedEvents[expectedIndex].generation);
      return;
    }

    generation += 1;
    latestIsPlaying = isPlaying;
    expectedEvents.length = 0;
    cancelPublication();
    timer = setTimeout(() => {
      timer = undefined;
      if (destroyed) return;
      options.publish({ ...options.currentStatus(), isPlaying: latestIsPlaying });
    }, debounceTime);
  };

  const pauseForGeneration = (operationGeneration: number) => {
    removeSettledExpectedEvents("pause");
    if (!options.currentStatus().isPlaying) return;

    expectEvent("pause", operationGeneration);
    options.pause();
  };

  const startPlayAttempt = async (operationGeneration: number) => {
    if (destroyed || activePlayGeneration !== undefined) return;

    activePlayGeneration = operationGeneration;
    expectEvent("play", operationGeneration);
    try {
      await options.play();
    } catch {
      // Playback rejection is an expected browser failure; remote application remains fail-safe.
    } finally {
      removeExpectedEvent("play", operationGeneration);
      activePlayGeneration = undefined;
    }

    if (destroyed) return;
    if (!latestIsPlaying) {
      pauseForGeneration(generation);
      return;
    }

    if (
      latestRemotePlayGeneration !== undefined &&
      latestRemotePlayGeneration > operationGeneration &&
      !options.currentStatus().isPlaying
    ) {
      await startPlayAttempt(latestRemotePlayGeneration);
    }
  };

  const applyRemote = async (isPlaying: boolean) => {
    if (destroyed) return;

    generation += 1;
    const operationGeneration = generation;
    latestIsPlaying = isPlaying;
    if (isPlaying) latestRemotePlayGeneration = operationGeneration;
    cancelPublication();
    removeSettledExpectedEvents(isPlaying ? "play" : "pause");

    if (!isPlaying) {
      pauseForGeneration(operationGeneration);
      return;
    }

    if (options.currentStatus().isPlaying || activePlayGeneration !== undefined) return;
    await startPlayAttempt(operationGeneration);
  };

  const destroy = () => {
    destroyed = true;
    generation += 1;
    cancelPublication();
    expectedEvents.length = 0;
  };

  return {
    applyRemote,
    destroy,
    handleMediaEvent
  };
};
