import { describe, expect, it, vi } from "vitest";

import type Artplayer from "artplayer";
import type { EmbeddedSubtitleBridge } from "../embeddedSubtitle/artplayerBridge";
import type { EmbeddedSubtitleTrack } from "../embeddedSubtitle/types";
import { artplayerSubtitle, escapeHtml, type SubtitleMode } from "../subtitle";

interface SelectorEntry {
  html: string;
  subtitleId: string;
  default: boolean;
}

interface ComponentOptionLike {
  name?: string;
  html?: string;
  selector?: SelectorEntry[];
  onSelect?: (item: SelectorEntry) => unknown;
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

function createFakeArt() {
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>();
  const emitted: { name: string; args: unknown[] }[] = [];
  let settingOption: ComponentOptionLike | null = null;
  let controlOption: ComponentOptionLike | null = null;

  const switchCalls: { url: string; type?: string }[] = [];
  let switchImpl: (url: string, option?: { type?: string }) => Promise<string> = async (url) => url;

  const art = {
    option: { subtitle: { escape: false } },
    fullscreen: false,
    plugins: {} as Record<string, unknown>,
    notice: { show: "" },
    subtitle: {
      textTrack: null,
      show: false,
      update: vi.fn(),
      switch: (url: string, option?: { type?: string }) => {
        switchCalls.push({ url, type: option?.type });
        return switchImpl(url, option);
      }
    },
    controls: {
      update(option: ComponentOptionLike) {
        controlOption = option;
      },
      remove() {
        controlOption = null;
      }
    } as Record<string, unknown>,
    setting: {
      update(option: ComponentOptionLike) {
        settingOption = option;
      }
    },
    on(name: string, fn: (...args: never[]) => unknown) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(fn);
      listeners.set(name, bucket);
      return undefined;
    },
    emit(name: string, ...args: unknown[]) {
      emitted.push({ name, args });
      return undefined;
    }
  };

  return {
    art: art as unknown as Artplayer,
    raw: art,
    emitted,
    switchCalls,
    setSwitchImpl(impl: typeof switchImpl) {
      switchImpl = impl;
    },
    fire(name: string): void {
      for (const fn of listeners.get(name) ?? []) (fn as () => unknown)();
    },
    listenerCount(name: string): number {
      return (listeners.get(name) ?? []).length;
    },
    selector(): SelectorEntry[] {
      return settingOption?.selector ?? [];
    },
    controlSelector(): SelectorEntry[] {
      return controlOption?.selector ?? [];
    },
    select(subtitleId: string): unknown {
      const entry = (settingOption?.selector ?? []).find((item) => item.subtitleId === subtitleId);
      if (!entry) throw new Error(`Missing selector entry: ${subtitleId}`);
      return settingOption?.onSelect?.(entry);
    }
  };
}

function track(overrides: Partial<EmbeddedSubtitleTrack> = {}): EmbeddedSubtitleTrack {
  return {
    id: "track-a",
    sourceKey: "source-a",
    streamIndex: 2,
    codecId: "S_TEXT/UTF8",
    isDefault: false,
    isForced: false,
    timeBase: { num: 1, den: 1000 },
    ...overrides
  };
}

function createBridge(overrides: Partial<EmbeddedSubtitleBridge> = {}) {
  const bridge = {
    name: "embeddedSubtitle" as const,
    tracks: [] as readonly EmbeddedSubtitleTrack[],
    selectedTrack: null,
    discover: vi.fn(async () => [] as readonly EmbeddedSubtitleTrack[]),
    updateSource: vi.fn(async () => [] as readonly EmbeddedSubtitleTrack[]),
    selectTrack: vi.fn(async () => true),
    disable: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    ...overrides
  };
  return bridge as unknown as EmbeddedSubtitleBridge & {
    selectTrack: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("escapeHtml", () => {
  it("neutralizes every HTML-significant character", () => {
    expect(escapeHtml(`<img src=x onerror=alert(1)>`)).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(escapeHtml(`"><script>bad()</script>`)).toBe(
      "&quot;&gt;&lt;script&gt;bad()&lt;/script&gt;"
    );
    expect(escapeHtml("a&b'c")).toBe("a&amp;b&#39;c");
  });
});

describe("unified subtitle coordinator", () => {
  it("keeps the single-argument call signature working", async () => {
    const fake = createFakeArt();
    const plugin = artplayerSubtitle({
      "字幕 1": { url: "https://example.invalid/a.vtt", type: "vtt" }
    })(fake.art);

    await flush();

    expect(plugin.name).toBe("artplayerSubtitle");
    expect(fake.selector().map((item) => item.subtitleId)).toEqual(["external:字幕 1", "off"]);
    // A single external subtitle is still auto-selected.
    expect(plugin.currentMode()).toEqual({
      kind: "external",
      id: "字幕 1",
      url: "https://example.invalid/a.vtt",
      type: "vtt"
    });
    expect(fake.raw.subtitle.show).toBe(true);
  });

  it("escapes malicious external and embedded labels in selector html", async () => {
    const fake = createFakeArt();
    const evilExternal = `<img src=x onerror=alert(1)>`;
    const plugin = artplayerSubtitle(
      { [evilExternal]: { url: "https://example.invalid/a.vtt", type: "vtt" } },
      { embeddedEnabled: true, getEmbeddedBridge: () => createBridge() }
    )(fake.art);

    plugin.updateEmbeddedTracks([
      track({ id: "t1", name: `"><script>bad()</script>` }),
      track({ id: "t2", language: `</div><svg onload=alert(2)>` })
    ]);
    await flush();

    const html = fake
      .selector()
      .map((item) => item.html)
      .join("|");
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<svg/i);
    expect(html).not.toMatch(/<\/div>/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
  });

  it("uses stable ids instead of display names for identity", async () => {
    const fake = createFakeArt();
    const bridge = createBridge();
    const plugin = artplayerSubtitle(
      { 关闭: { url: "https://example.invalid/tricky.vtt", type: "vtt" } },
      { embeddedEnabled: true, getEmbeddedBridge: () => bridge }
    )(fake.art);

    await flush();
    const ids = fake.selector().map((item) => item.subtitleId);
    // The "关闭"-named external subtitle is not confused with the off entry.
    expect(ids).toEqual(["external:关闭", "off"]);

    fake.select("external:关闭");
    await flush();
    expect(plugin.currentMode().kind).toBe("external");

    fake.select("off");
    await flush();
    expect(plugin.currentMode()).toEqual({ kind: "off" });
  });

  it("switches exclusively between off, external, ass and embedded", async () => {
    const fake = createFakeArt();
    const bridge = createBridge();
    const plugin = artplayerSubtitle(
      {
        vtt: { url: "https://example.invalid/a.vtt", type: "vtt" },
        ass: { url: "https://example.invalid/a.ass", type: "ass" }
      },
      { embeddedEnabled: true, getEmbeddedBridge: () => bridge }
    )(fake.art);

    plugin.updateEmbeddedTracks([track({ id: "t1" })]);
    await flush();

    // external
    await plugin.setMode({
      kind: "external",
      id: "vtt",
      url: "https://example.invalid/a.vtt",
      type: "vtt"
    });
    await flush();
    expect(fake.raw.subtitle.show).toBe(true);
    expect(bridge.selectTrack).not.toHaveBeenCalled();
    expect(bridge.disable).toHaveBeenCalled();

    // embedded: external output must stop first
    await plugin.setMode({ kind: "embedded", trackId: "t1" });
    await flush();
    expect(fake.raw.subtitle.show).toBe(false);
    expect(bridge.selectTrack).toHaveBeenCalledWith("t1");

    // ass: embedded must be disabled first
    const disableCallsBeforeAss = bridge.disable.mock.calls.length;
    await plugin.setMode({ kind: "ass", id: "ass", url: "https://example.invalid/a.ass" });
    await flush();
    expect(bridge.disable.mock.calls.length).toBeGreaterThan(disableCallsBeforeAss);
    expect(fake.raw.subtitle.show).toBe(false);

    // off: everything is torn down
    await plugin.setMode({ kind: "off" });
    await flush();
    expect(fake.raw.subtitle.show).toBe(false);
    expect(
      fake.emitted.some(
        (item) => item.name === "artplayer-plugin-ass:visible" && item.args[0] === false
      )
    ).toBe(true);
    expect(plugin.currentMode()).toEqual({ kind: "off" });
  });

  it("never lets a late external switch override a newer selection", async () => {
    const fake = createFakeArt();
    const bridge = createBridge();
    const pending = deferred<string>();
    fake.setSwitchImpl(() => pending.promise);

    const plugin = artplayerSubtitle(
      { vtt: { url: "https://example.invalid/a.vtt", type: "vtt" } },
      { embeddedEnabled: true, getEmbeddedBridge: () => bridge }
    )(fake.art);

    const externalDone = plugin.setMode({
      kind: "external",
      id: "vtt",
      url: "https://example.invalid/a.vtt",
      type: "vtt"
    });
    plugin.updateEmbeddedTracks([track({ id: "t1" })]);
    const embeddedDone = plugin.setMode({ kind: "embedded", trackId: "t1" });
    const offDone = plugin.setMode({ kind: "off" });

    // The stale external fetch resolves only after two newer selections landed.
    pending.resolve("https://example.invalid/a.vtt");
    await Promise.all([externalDone, embeddedDone, offDone]);
    await flush();

    expect(plugin.currentMode()).toEqual({ kind: "off" });
    expect(fake.raw.subtitle.show).toBe(false);
    expect(bridge.disable).toHaveBeenCalled();
  });

  it("falls back to off and notifies when an embedded track cannot be selected", async () => {
    const fake = createFakeArt();
    const bridge = createBridge({ selectTrack: vi.fn(async () => false) });
    const plugin = artplayerSubtitle(
      {},
      { embeddedEnabled: true, getEmbeddedBridge: () => bridge }
    );
    const coordinator = plugin(fake.art);

    coordinator.updateEmbeddedTracks([track({ id: "t1" })]);
    await coordinator.setMode({ kind: "embedded", trackId: "t1" });
    await flush();

    expect(coordinator.currentMode()).toEqual({ kind: "off" });
    expect(fake.raw.notice.show).toBe("内嵌字幕不可用");
    expect(fake.raw.subtitle.show).toBe(false);
  });

  it("auto-selects a forced embedded track when no external subtitle exists", async () => {
    const fake = createFakeArt();
    const bridge = createBridge();
    const coordinator = artplayerSubtitle(
      {},
      { embeddedEnabled: true, getEmbeddedBridge: () => bridge }
    )(fake.art);

    coordinator.updateEmbeddedTracks([
      track({ id: "t1", isDefault: true }),
      track({ id: "t2", isForced: true })
    ]);
    await flush();

    expect(coordinator.currentMode()).toEqual({ kind: "embedded", trackId: "t2" });
    expect(bridge.selectTrack).toHaveBeenCalledWith("t2");
  });

  it("does not auto-enable embedded subtitles when several undistinguished tracks exist", async () => {
    const fake = createFakeArt();
    const bridge = createBridge();
    const coordinator = artplayerSubtitle(
      {},
      { embeddedEnabled: true, getEmbeddedBridge: () => bridge }
    )(fake.art);

    coordinator.updateEmbeddedTracks([track({ id: "t1" }), track({ id: "t2" })]);
    await flush();

    expect(coordinator.currentMode()).toEqual({ kind: "off" });
    expect(bridge.selectTrack).not.toHaveBeenCalled();
  });

  it("retries the ass switch until the async ass plugin is ready", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeArt();
      const coordinator = artplayerSubtitle({
        ass: { url: "https://example.invalid/a.ass", type: "ass" }
      })(fake.art);

      // Auto-selected, but the ass plugin has not finished initializing yet.
      await vi.advanceTimersByTimeAsync(0);
      expect(coordinator.currentMode().kind).toBe("ass");
      expect(fake.emitted.some((item) => item.name === "artplayer-plugin-ass:switch")).toBe(false);

      await vi.advanceTimersByTimeAsync(400);
      expect(fake.emitted.some((item) => item.name === "artplayer-plugin-ass:switch")).toBe(false);

      fake.raw.plugins["artplayerPluginAss"] = { instance: {} };
      await vi.advanceTimersByTimeAsync(400);

      const switchEvents = fake.emitted.filter(
        (item) => item.name === "artplayer-plugin-ass:switch"
      );
      expect(switchEvents).toHaveLength(1);
      expect(switchEvents[0].args[0]).toBe("https://example.invalid/a.ass");

      // The bounded poll stops after success.
      await vi.advanceTimersByTimeAsync(5000);
      expect(
        fake.emitted.filter((item) => item.name === "artplayer-plugin-ass:switch")
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling for the ass plugin after the mode changes", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeArt();
      const coordinator = artplayerSubtitle({
        ass: { url: "https://example.invalid/a.ass", type: "ass" },
        vtt: { url: "https://example.invalid/a.vtt", type: "vtt" }
      })(fake.art);

      await coordinator.setMode({ kind: "ass", id: "ass", url: "https://example.invalid/a.ass" });
      await vi.advanceTimersByTimeAsync(0);
      await coordinator.setMode({ kind: "off" });
      await vi.advanceTimersByTimeAsync(0);

      fake.raw.plugins["artplayerPluginAss"] = { instance: {} };
      await vi.advanceTimersByTimeAsync(10000);

      expect(fake.emitted.some((item) => item.name === "artplayer-plugin-ass:switch")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a selected mode that disappears from a refreshed list", async () => {
    const fake = createFakeArt();
    const bridge = createBridge();
    const coordinator = artplayerSubtitle(
      { vtt: { url: "https://example.invalid/a.vtt", type: "vtt" } },
      { embeddedEnabled: true, getEmbeddedBridge: () => bridge }
    )(fake.art);

    await flush();
    expect(coordinator.currentMode().kind).toBe("external");

    coordinator.updateSubtitles({});
    await flush();

    expect(coordinator.currentMode()).toEqual({ kind: "off" });
    expect(fake.raw.subtitle.show).toBe(false);

    coordinator.updateEmbeddedTracks([track({ id: "t1", isForced: true })]);
    await flush();
    expect(coordinator.currentMode()).toEqual({ kind: "embedded", trackId: "t1" });

    coordinator.updateEmbeddedTracks([]);
    await flush();
    expect(coordinator.currentMode()).toEqual({ kind: "off" });
  });

  it("marks exactly one selector entry as default", async () => {
    const fake = createFakeArt();
    const coordinator = artplayerSubtitle({
      a: { url: "https://example.invalid/a.vtt", type: "vtt" },
      b: { url: "https://example.invalid/b.vtt", type: "vtt" }
    })(fake.art);

    await coordinator.setMode({
      kind: "external",
      id: "b",
      url: "https://example.invalid/b.vtt",
      type: "vtt"
    });
    await flush();

    const defaults = fake.selector().filter((item) => item.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].subtitleId).toBe("external:b");
  });

  it("becomes inert after destroy", async () => {
    const fake = createFakeArt();
    const bridge = createBridge();
    const coordinator = artplayerSubtitle(
      { vtt: { url: "https://example.invalid/a.vtt", type: "vtt" } },
      { embeddedEnabled: true, getEmbeddedBridge: () => bridge }
    )(fake.art);

    await flush();
    coordinator.destroy();
    const before = bridge.selectTrack.mock.calls.length;

    await coordinator.setMode({ kind: "embedded", trackId: "t1" } satisfies SubtitleMode);
    await flush();

    expect(bridge.selectTrack.mock.calls.length).toBe(before);
  });

  it("registers the fullscreen listener at most once", () => {
    const fake = createFakeArt();
    const coordinator = artplayerSubtitle({
      a: { url: "https://example.invalid/a.vtt", type: "vtt" }
    })(fake.art);

    coordinator.updateSubtitles({ b: { url: "https://example.invalid/b.vtt", type: "vtt" } });
    coordinator.updateEmbeddedTracks([]);

    expect(fake.listenerCount("fullscreen")).toBeLessThanOrEqual(1);
  });
});
