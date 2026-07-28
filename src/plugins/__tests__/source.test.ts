import { describe, expect, it, vi } from "vitest";

import type Artplayer from "artplayer";
import {
  artplayPluginSource,
  resolvePlayerSources,
  type PlayerSourceDescriptor,
  type PlayerSourcePlugin,
  type ResolvedPlayerSource
} from "../source";

interface SelectorEntry {
  html: string;
  sourceItemKey: string;
  default: boolean;
}

interface ComponentOptionLike {
  name?: string;
  html?: string;
  selector?: SelectorEntry[];
  onSelect?: (item: SelectorEntry) => unknown;
}

const flush = async (times = 6): Promise<void> => {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
};

function createFakeArt() {
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>();
  const emitted: { name: string; args: unknown[] }[] = [];
  const urlWrites: string[] = [];
  let settingOption: ComponentOptionLike | null = null;
  let controlOption: ComponentOptionLike | null = null;
  let statusCounter = 0;
  const restoredStatuses: unknown[] = [];

  const art = {
    option: { type: "", url: "" } as Record<string, unknown>,
    fullscreen: false,
    plugins: {
      syncPlugin: {
        currentStatus() {
          statusCounter += 1;
          return { seq: statusCounter };
        },
        setAndNoPublishStatus(status: unknown) {
          restoredStatuses.push(status);
        }
      }
    } as Record<string, any>,
    controls: {
      update(option: ComponentOptionLike) {
        controlOption = option;
      },
      remove() {
        controlOption = null;
      }
    } as Record<string, any>,
    setting: {
      update(option: ComponentOptionLike) {
        settingOption = option;
      },
      find() {
        return settingOption;
      },
      remove() {
        settingOption = null;
      }
    } as Record<string, any>,
    get url() {
      return urlWrites[urlWrites.length - 1] ?? "";
    },
    set url(value: string) {
      urlWrites.push(value);
    },
    on(name: string, fn: (...args: never[]) => unknown) {
      const bucket = listeners.get(name) ?? [];
      bucket.push(fn);
      listeners.set(name, bucket);
      return undefined;
    },
    once(name: string, fn: (...args: never[]) => unknown) {
      return art.on(name, fn);
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
    urlWrites,
    restoredStatuses,
    fire(name: string): void {
      for (const fn of [...(listeners.get(name) ?? [])]) (fn as () => unknown)();
    },
    listenerCount(name: string): number {
      return (listeners.get(name) ?? []).length;
    },
    selector(): SelectorEntry[] {
      return settingOption?.selector ?? [];
    },
    select(sourceItemKey: string): unknown {
      const entry = (settingOption?.selector ?? []).find(
        (item) => item.sourceItemKey === sourceItemKey
      );
      if (!entry) throw new Error(`Missing selector entry: ${sourceItemKey}`);
      return settingOption?.onSelect?.(entry);
    }
  };
}

function source(overrides: Partial<PlayerSourceDescriptor> = {}): PlayerSourceDescriptor {
  return {
    key: "source-key:a",
    html: "源A",
    url: "https://example.test/a.mkv",
    type: "mkv",
    ...overrides
  };
}

describe("resolvePlayerSources", () => {
  it("keeps caller supplied keys", () => {
    const resolved = resolvePlayerSources([
      source({ key: "source-key:a" }),
      source({ key: "source-key:b", url: "https://example.test/b.mkv" })
    ]);
    expect(resolved.map((item) => item.key)).toEqual(["source-key:a", "source-key:b"]);
  });

  it("synthesises stable keys for keyless legacy descriptors", () => {
    const resolved = resolvePlayerSources([
      { html: "默认", url: "https://example.test/a", type: "mp4" },
      { html: "备用", url: "https://example.test/b", type: "mp4" }
    ]);
    expect(resolved.map((item) => item.key)).toEqual(["auto:默认", "auto:备用"]);
  });

  it("disambiguates duplicated labels and duplicated keys", () => {
    const resolved = resolvePlayerSources([
      { html: "源", url: "https://example.test/a" },
      { html: "源", url: "https://example.test/b" },
      { key: "dup", html: "x", url: "https://example.test/c" },
      { key: "dup", html: "y", url: "https://example.test/d" }
    ]);
    expect(new Set(resolved.map((item) => item.key)).size).toBe(4);
  });

  it("drops descriptors without a usable url", () => {
    const resolved = resolvePlayerSources([
      { html: "空", url: "" },
      { html: "有", url: "https://example.test/a" }
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].html).toBe("有");
  });
});

describe("artplayPluginSource", () => {
  const twoSources = (): PlayerSourceDescriptor[] => [
    source({ key: "source-key:a", html: "源A", url: "https://example.test/a.mkv" }),
    source({ key: "source-key:b", html: "源B", url: "https://example.test/b.mkv" })
  ];

  it("awaits beforeSwitch before writing art.url", async () => {
    const fake = createFakeArt();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforeSwitch = vi.fn(() => gate);

    const plugin = artplayPluginSource(twoSources(), { beforeSwitch })(fake.art);
    expect(plugin.currentKey()).toBe("source-key:a");

    fake.select("source-key:b");
    await flush();
    expect(beforeSwitch).toHaveBeenCalledTimes(1);
    expect(fake.urlWrites).toEqual([]);

    release();
    await flush();
    expect(fake.urlWrites).toEqual(["https://example.test/b.mkv"]);
  });

  it("writes art.url even when beforeSwitch rejects", async () => {
    const fake = createFakeArt();
    const beforeSwitch = vi.fn(() => Promise.reject(new Error("x")));

    artplayPluginSource(twoSources(), { beforeSwitch })(fake.art);

    fake.select("source-key:b");
    await flush();

    expect(beforeSwitch).toHaveBeenCalledTimes(1);
    expect(fake.urlWrites).toContain("https://example.test/b.mkv");
  });

  it("does not claim the target source until beforeSwitch resolved", async () => {
    const fake = createFakeArt();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const plugin = artplayPluginSource(twoSources(), { beforeSwitch: () => gate })(fake.art);
    expect(plugin.currentKey()).toBe("source-key:a");

    fake.select("source-key:b");
    await flush();
    expect(plugin.currentKey()).toBe("source-key:a");

    release();
    await flush();
    expect(plugin.currentKey()).toBe("source-key:b");
  });

  it("drops a superseded switch whose beforeSwitch resolves last", async () => {
    const fake = createFakeArt();
    const releases: (() => void)[] = [];
    const beforeSwitch = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });

    const plugin = artplayPluginSource(
      [
        source({ key: "source-key:a", html: "源A", url: "https://example.test/a.mkv" }),
        source({ key: "source-key:b", html: "源B", url: "https://example.test/b.mkv" }),
        source({ key: "source-key:c", html: "源C", url: "https://example.test/c.mkv" })
      ],
      { beforeSwitch }
    )(fake.art);

    fake.select("source-key:b");
    fake.select("source-key:c");
    await flush();
    expect(releases).toHaveLength(2);

    // Release the newest switch first, then the superseded one.
    releases[1]();
    await flush();
    releases[0]();
    await flush();

    expect(plugin.currentKey()).toBe("source-key:c");
    expect(fake.urlWrites).toEqual(["https://example.test/c.mkv"]);
  });

  it("only applies the newest canplay job for rapid consecutive switches", async () => {
    const fake = createFakeArt();
    const afterSwitch = vi.fn();
    const plugin = artplayPluginSource(twoSources(), { afterSwitch })(fake.art);

    fake.select("source-key:b");
    fake.select("source-key:a");
    await flush();

    expect(plugin.currentKey()).toBe("source-key:a");
    expect(fake.urlWrites[fake.urlWrites.length - 1]).toBe("https://example.test/a.mkv");

    fake.fire("video:canplay");
    await flush();

    expect(afterSwitch).toHaveBeenCalledTimes(1);
    expect((afterSwitch.mock.calls[0][0] as ResolvedPlayerSource).key).toBe("source-key:a");
    expect(fake.restoredStatuses).toHaveLength(1);

    // A second canplay from the same switch must not re-run the hook.
    fake.fire("video:canplay");
    await flush();
    expect(afterSwitch).toHaveBeenCalledTimes(1);
  });

  it("restores the current source by key across updateSources, not by label", async () => {
    const fake = createFakeArt();
    const plugin = artplayPluginSource(twoSources())(fake.art);

    fake.select("source-key:b");
    await flush();
    expect(plugin.currentKey()).toBe("source-key:b");

    plugin.updateSources([
      source({ key: "source-key:a", html: "改名A", url: "https://example.test/a2.mkv" }),
      source({ key: "source-key:b", html: "改名B", url: "https://example.test/b2.mkv" })
    ]);
    await flush();

    expect(plugin.currentKey()).toBe("source-key:b");
    expect(fake.urlWrites[fake.urlWrites.length - 1]).toBe("https://example.test/b2.mkv");
  });

  it("restores the correct slot when two sources share a display name", async () => {
    const fake = createFakeArt();
    const plugin = artplayPluginSource([
      source({ key: "source-key:a", html: "同名", url: "https://example.test/a.mkv" }),
      source({ key: "source-key:b", html: "同名", url: "https://example.test/b.mkv" })
    ])(fake.art);

    fake.select("source-key:b");
    await flush();

    plugin.updateSources([
      source({ key: "source-key:a", html: "同名", url: "https://example.test/a2.mkv" }),
      source({ key: "source-key:b", html: "同名", url: "https://example.test/b2.mkv" })
    ]);
    await flush();

    expect(plugin.currentSource()?.url).toBe("https://example.test/b2.mkv");
  });

  it("falls back to the first source when the previous key disappeared", async () => {
    const fake = createFakeArt();
    const plugin = artplayPluginSource(twoSources())(fake.art);

    fake.select("source-key:b");
    await flush();

    plugin.updateSources([
      source({ key: "source-key:c", html: "源C", url: "https://example.test/c.mkv" })
    ]);
    await flush();

    expect(plugin.currentKey()).toBe("source-key:c");
    expect(fake.urlWrites[fake.urlWrites.length - 1]).toBe("https://example.test/c.mkv");
  });

  it("escapes selector labels", () => {
    const fake = createFakeArt();
    artplayPluginSource([
      source({ key: "source-key:a", html: "<img onerror=alert(1)>" }),
      source({ key: "source-key:b", html: "安全", url: "https://example.test/b.mkv" })
    ])(fake.art);

    const labels = fake.selector().map((item) => item.html);
    expect(labels[0]).toBe("&lt;img onerror=alert(1)&gt;");
    expect(labels[0]).not.toContain("<img");
  });

  it("registers the fullscreen listener at most once across selector updates", async () => {
    const fake = createFakeArt();
    const plugin = artplayPluginSource(twoSources())(fake.art);

    plugin.updateSources(twoSources());
    plugin.updateSources(twoSources());
    await flush();

    expect(fake.listenerCount("fullscreen")).toBeLessThanOrEqual(1);
  });

  it("passes the embedded subtitle source of the target through the hooks", async () => {
    const fake = createFakeArt();
    const seen: (ResolvedPlayerSource | null)[] = [];
    const plugin: PlayerSourcePlugin = artplayPluginSource(
      [
        source({
          key: "source-key:a",
          embeddedSubtitle: { url: "https://example.test/a.mkv", sourceKey: "a" }
        }),
        source({
          key: "source-key:b",
          html: "源B",
          url: "https://example.test/b.mkv",
          embeddedSubtitle: null
        })
      ],
      {
        beforeSwitch: (next) => {
          seen.push(next);
        }
      }
    )(fake.art);

    fake.select("source-key:b");
    await flush();

    expect(plugin.currentKey()).toBe("source-key:b");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.embeddedSubtitle).toBeNull();
  });

  it("stops switching after destroy", async () => {
    const fake = createFakeArt();
    const beforeSwitch = vi.fn();
    const plugin = artplayPluginSource(twoSources(), { beforeSwitch })(fake.art);

    fake.fire("destroy");
    plugin.updateSources(twoSources());
    await flush();

    expect(beforeSwitch).not.toHaveBeenCalled();
    expect(fake.urlWrites).toEqual([]);
  });
});
