import { describe, expect, it, vi } from "vitest";

import type Artplayer from "artplayer";
import { artplayerEmbeddedSubtitle } from "../artplayerBridge";
import type { EmbeddedSubtitleController } from "../controller";
import type { EmbeddedSubtitleTrack, MatroskaDemuxSession } from "../types";

class FakeVTTCue {
  constructor(public startTime: number, public endTime: number, public text: string) {}
}

class FakeTextTrack {
  cues: FakeVTTCue[] = [];

  addCue(cue: FakeVTTCue): void {
    this.cues.push(cue);
  }

  removeCue(cue: FakeVTTCue): void {
    const index = this.cues.indexOf(cue);
    if (index < 0) throw new Error("Cue is not attached");
    this.cues.splice(index, 1);
  }

  addEventListener(): void {}

  removeEventListener(): void {}
}

function createFakeArt() {
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>();
  const track = new FakeTextTrack();

  const art = {
    option: { subtitle: { escape: false } },
    currentTime: 12,
    video: { paused: false },
    subtitle: {
      textTrack: track as unknown as TextTrack,
      show: false,
      update: vi.fn()
    },
    on(name: string, fn: (...args: never[]) => unknown) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(fn);
      listeners.set(name, bucket);
      return undefined;
    }
  };

  return {
    art: art as unknown as Artplayer,
    raw: art,
    track,
    emit(name: string): void {
      for (const fn of listeners.get(name) ?? []) (fn as () => unknown)();
    },
    listenerCount(name: string): number {
      return (listeners.get(name) ?? []).length;
    }
  };
}

function fakeController(overrides: Partial<EmbeddedSubtitleController> = {}) {
  const base: EmbeddedSubtitleController = {
    get tracks() {
      return [] as readonly EmbeddedSubtitleTrack[];
    },
    get selectedTrack() {
      return null;
    },
    discover: vi.fn(async () => [] as readonly EmbeddedSubtitleTrack[]),
    updateSource: vi.fn(async () => [] as readonly EmbeddedSubtitleTrack[]),
    selectTrack: vi.fn(async () => true),
    disable: vi.fn(async () => undefined),
    handleTimeUpdate: vi.fn(async () => undefined),
    handleSeek: vi.fn(async () => true),
    destroy: vi.fn(async () => undefined)
  };
  return { ...base, ...overrides };
}

describe("artplayer embedded subtitle bridge", () => {
  it("returns the plugin object synchronously", () => {
    const { art } = createFakeArt();
    const controller = fakeController();

    const plugin = artplayerEmbeddedSubtitle({ createController: () => controller })(art);

    expect(plugin).not.toBeInstanceOf(Promise);
    expect(plugin.name).toBe("embeddedSubtitle");
    expect(typeof plugin.selectTrack).toBe("function");
  });

  it("forces cue escaping on the Artplayer subtitle option", () => {
    const { art, raw } = createFakeArt();
    artplayerEmbeddedSubtitle({ createController: () => fakeController() })(art);
    expect(raw.option.subtitle.escape).toBe(true);
  });

  it("performs no discovery or session opening when the initial source is null", async () => {
    const { art } = createFakeArt();
    const openSession = vi.fn(async () => {
      throw new Error("must not open");
    });
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const plugin = artplayerEmbeddedSubtitle({
        source: null,
        openSession: openSession as unknown as (
          options: never
        ) => Promise<MatroskaDemuxSession>,
        cueConstructor: FakeVTTCue as unknown as typeof VTTCue
      })(art);

      await expect(plugin.discover()).resolves.toEqual([]);
      await expect(plugin.selectTrack("track-a")).resolves.toBe(false);
      expect(plugin.tracks).toEqual([]);
      expect(openSession).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("drives the controller from timeupdate and seeked events", () => {
    const { art, emit } = createFakeArt();
    const controller = fakeController();
    artplayerEmbeddedSubtitle({ createController: () => controller })(art);

    emit("video:timeupdate");
    emit("video:seeked");

    expect(controller.handleTimeUpdate).toHaveBeenCalledTimes(1);
    expect(controller.handleSeek).toHaveBeenCalledTimes(1);
  });

  it("swallows rejections raised by event-driven controller calls", async () => {
    const { art, emit } = createFakeArt();
    const unhandled = vi.fn();
    const controller = fakeController({
      handleTimeUpdate: vi.fn(async () => {
        throw new Error("pump failed");
      }),
      handleSeek: vi.fn(async () => {
        throw new Error("seek failed");
      })
    });
    artplayerEmbeddedSubtitle({ createController: () => controller })(art);

    process.on("unhandledRejection", unhandled);
    try {
      expect(() => emit("video:timeupdate")).not.toThrow();
      expect(() => emit("video:seeked")).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
  });

  it("reads current time and paused state from the player", () => {
    const { art, raw } = createFakeArt();
    let captured: { getCurrentTime: () => number; isPaused?: () => boolean } | null = null;
    artplayerEmbeddedSubtitle({
      createController: (options) => {
        captured = options as never;
        return fakeController();
      }
    })(art);

    expect(captured!.getCurrentTime()).toBe(12);
    expect(captured!.isPaused?.()).toBe(false);

    raw.currentTime = Number.NaN;
    raw.video = null as never;
    expect(captured!.getCurrentTime()).toBe(0);
    expect(captured!.isPaused?.()).toBe(true);
  });

  it("destroys idempotently on the destroy event and via the plugin API", async () => {
    const { art, emit } = createFakeArt();
    const controller = fakeController();
    const plugin = artplayerEmbeddedSubtitle({ createController: () => controller })(art);

    emit("destroy");
    emit("destroy");
    await plugin.destroy();
    await plugin.destroy();

    expect(controller.destroy).toHaveBeenCalledTimes(1);
  });

  it("becomes inert after destroy", async () => {
    const { art } = createFakeArt();
    const controller = fakeController();
    const plugin = artplayerEmbeddedSubtitle({ createController: () => controller })(art);

    await plugin.destroy();

    await expect(plugin.discover()).resolves.toEqual([]);
    await expect(plugin.selectTrack("track-a")).resolves.toBe(false);
    await expect(plugin.updateSource({ url: "u", sourceKey: "s" })).resolves.toEqual([]);
    await expect(plugin.disable()).resolves.toBeUndefined();

    expect(controller.discover).not.toHaveBeenCalled();
    expect(controller.selectTrack).not.toHaveBeenCalled();
    expect(controller.updateSource).not.toHaveBeenCalled();
    expect(controller.disable).not.toHaveBeenCalled();
  });

  it("forwards source updates and selections to the controller", async () => {
    const { art } = createFakeArt();
    const controller = fakeController();
    const plugin = artplayerEmbeddedSubtitle({ createController: () => controller })(art);

    await plugin.updateSource({ url: "https://example.invalid/media", sourceKey: "key-1" });
    await plugin.selectTrack("track-a");
    await plugin.disable();

    expect(controller.updateSource).toHaveBeenCalledWith({
      url: "https://example.invalid/media",
      sourceKey: "key-1"
    });
    expect(controller.selectTrack).toHaveBeenCalledWith("track-a");
    expect(controller.disable).toHaveBeenCalledTimes(1);
  });
});
