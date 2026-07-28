import Artplayer from "artplayer";
import type { Selector } from "artplayer/types/component";

import { destroyOldCustomPlayLib } from "@/utils";
import type { EmbeddedSubtitleSource } from "./embeddedSubtitle/controller";
import { escapeHtml } from "./subtitle";

export const PLAYER_SOURCE_PLUGIN_NAME = "source";

/**
 * Source descriptor supplied by the caller. `key` is the stable identity used
 * for restore-after-refresh; display names and token bearing URLs must never be
 * used as identity. Callers that cannot provide a key (legacy vendors) still
 * work: a deterministic key is synthesised from the label and the slot index.
 */
export interface PlayerSourceDescriptor {
  key?: string;
  html: string;
  url: string;
  type?: string;
  embeddedSubtitle?: EmbeddedSubtitleSource | null;
}

export interface ResolvedPlayerSource {
  key: string;
  html: string;
  url: string;
  type: string;
  embeddedSubtitle: EmbeddedSubtitleSource | null;
}

export type PlayerSourceSwitchHook = (
  next: ResolvedPlayerSource,
  previous: ResolvedPlayerSource | null
) => unknown;

export interface ArtplayPluginSourceOptions {
  /** Awaited before `art.option.type` / `art.url` are written. */
  beforeSwitch?: PlayerSourceSwitchHook;
  /** Invoked after the new media reports `video:canplay`. */
  afterSwitch?: PlayerSourceSwitchHook;
}

export interface PlayerSourcePlugin {
  readonly name: typeof PLAYER_SOURCE_PLUGIN_NAME;
  currentKey(): string | null;
  currentSource(): ResolvedPlayerSource | null;
  sources(): readonly ResolvedPlayerSource[];
  updateSources(next: PlayerSourceDescriptor[]): void;
}

interface SourceSelectorItem {
  html: string;
  sourceItemKey: string;
  default: boolean;
}

interface PendingSwitch {
  token: number;
  next: ResolvedPlayerSource;
  previous: ResolvedPlayerSource | null;
  status: unknown;
}

/**
 * Assigns every descriptor a unique, deterministic key. Duplicated keys (or
 * duplicated labels in the legacy keyless form) are disambiguated by slot so a
 * renamed or repeated source can never be confused with another one.
 */
export function resolvePlayerSources(
  sources: readonly PlayerSourceDescriptor[]
): ResolvedPlayerSource[] {
  const used = new Set<string>();
  const resolved: ResolvedPlayerSource[] = [];

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (!source || typeof source.url !== "string" || source.url.length === 0) continue;

    const provided = typeof source.key === "string" ? source.key.trim() : "";
    let key = provided || `auto:${source.html}`;
    if (used.has(key)) key = `${key}#${index}`;
    while (used.has(key)) key = `${key}#`;
    used.add(key);

    resolved.push({
      key,
      html: typeof source.html === "string" ? source.html : "",
      url: source.url,
      type: source.type ?? "",
      embeddedSubtitle: source.embeddedSubtitle ?? null
    });
  }

  return resolved;
}

export function artplayPluginSource(
  sources: PlayerSourceDescriptor[],
  options: ArtplayPluginSourceOptions = {}
) {
  return (art: Artplayer): PlayerSourcePlugin => {
    const isMobile = Artplayer.utils.isMobile;

    let resolved = resolvePlayerSources(sources);
    /** The source the player is actually playing, kept by object identity. */
    let current: ResolvedPlayerSource | null = resolved.length > 0 ? resolved[0] : null;
    let generation = 0;
    let destroyed = false;
    let pending: PendingSwitch | null = null;

    const safely = (run: () => void): void => {
      try {
        run();
      } catch {
        // Source plumbing must never break playback.
      }
    };

    const ignore = (promise: Promise<unknown>): void => {
      void promise.then(
        () => undefined,
        () => undefined
      );
    };

    const runHook = (
      hook: PlayerSourceSwitchHook | undefined,
      next: ResolvedPlayerSource,
      previous: ResolvedPlayerSource | null
    ): Promise<void> => {
      if (!hook) return Promise.resolve();
      try {
        return Promise.resolve(hook(next, previous)).then(
          () => undefined,
          () => undefined
        );
      } catch {
        return Promise.resolve();
      }
    };

    const readSyncStatus = (): unknown => {
      try {
        return art.plugins?.["syncPlugin"]?.currentStatus?.() ?? null;
      } catch {
        return null;
      }
    };

    const restoreSyncStatus = (status: unknown): void => {
      if (!status) return;
      safely(() => {
        art.plugins["syncPlugin"].setAndNoPublishStatus(status);
      });
    };

    const selectorItems = (): SourceSelectorItem[] =>
      resolved.map((source) => ({
        html: escapeHtml(source.html),
        sourceItemKey: source.key,
        default: source.key === current?.key
      }));

    const onSelect = (item: Selector) => {
      const key = (item as Partial<SourceSelectorItem>)?.sourceItemKey;
      const target = key ? resolved.find((source) => source.key === key) ?? null : null;
      if (target) ignore(switchTo(target));
      return "源";
    };

    const removeSelector = (): void => {
      safely(() => {
        if (art.controls["source"]) art.controls.remove("source");
      });
      safely(() => {
        if (art.setting.find("source")) art.setting.remove("source");
      });
    };

    const updateControls = (): void => {
      if (destroyed) return;
      if (resolved.length <= 1) {
        removeSelector();
        return;
      }
      if (!isMobile || art.fullscreen) {
        safely(() => {
          art.controls.update({
            name: "source",
            position: "right",
            html: "源",
            selector: selectorItems(),
            onSelect
          });
        });
      } else if (art.controls["source"]) {
        safely(() => {
          art.controls.remove("source");
        });
      }
    };

    const setSelector = (): void => {
      if (destroyed) return;
      if (resolved.length <= 1) {
        removeSelector();
        return;
      }
      updateControls();
      safely(() => {
        art.setting.update({
          name: "source",
          position: "right",
          html: "源",
          selector: selectorItems(),
          onSelect
        });
      });
    };

    /**
     * `generation` invalidates every in-flight switch, so overlapping switches
     * only ever apply the newest one and stale `video:canplay` jobs are dropped.
     */
    const switchTo = async (next: ResolvedPlayerSource): Promise<void> => {
      if (destroyed) return;
      generation += 1;
      const token = generation;
      const previous = current;
      const status = readSyncStatus();
      pending = null;

      await runHook(options.beforeSwitch, next, previous);
      if (destroyed || token !== generation) return;
      // Only the winning switch may claim `current`: until the hook resolved the
      // player is still playing `previous`.
      current = next;

      safely(() => {
        if (art.controls["quality"]) art.controls.remove("quality");
      });
      safely(() => {
        if (art.setting.find("quality")) art.setting.remove("quality");
      });
      safely(() => {
        if (art.controls["audio"]) art.controls.remove("audio");
      });
      safely(() => {
        if (art.setting.find("audio")) art.setting.remove("audio");
      });
      safely(() => {
        destroyOldCustomPlayLib(art);
      });

      pending = { token, next, previous, status };
      safely(() => {
        art.option.type = next.type;
      });
      // Artplayer's url setter emits `restart` itself; never emit it here again.
      safely(() => {
        art.url = next.url;
      });
    };

    const updateSources = (next: PlayerSourceDescriptor[]): void => {
      if (destroyed) return;
      resolved = resolvePlayerSources(next);
      setSelector();

      const previousKey = current?.key;
      const target =
        (previousKey ? resolved.find((source) => source.key === previousKey) : undefined) ??
        resolved[0] ??
        null;

      if (!target) {
        current = null;
        return;
      }
      ignore(switchTo(target));
    };

    // Bound exactly once: a per-switch `art.once` would let stale callbacks of
    // rapid consecutive switches race each other.
    art.on("video:canplay", () => {
      const job = pending;
      if (!job) return;
      pending = null;
      if (destroyed || job.token !== generation) return;
      restoreSyncStatus(job.status);
      // Artplayer only emits `restart` itself when its url setter observed the
      // swap (`art.option.url` updated). Custom types assign `video.src`
      // asynchronously, so that check fails there and we must emit once.
      if (art.option?.url !== job.next.url) {
        safely(() => {
          art.emit("restart", job.next.url);
        });
      }
      ignore(runHook(options.afterSwitch, job.next, job.previous));
    });

    art.on("destroy", () => {
      destroyed = true;
      generation += 1;
      pending = null;
    });

    setSelector();

    // Bound exactly once here; setSelector() must never re-register it.
    if (isMobile) art.on("fullscreen", updateControls);

    return {
      name: PLAYER_SOURCE_PLUGIN_NAME,

      currentKey() {
        return current?.key ?? null;
      },

      currentSource() {
        return current;
      },

      sources() {
        return resolved;
      },

      updateSources
    };
  };
}
