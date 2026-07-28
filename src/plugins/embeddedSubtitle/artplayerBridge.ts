import type Artplayer from "artplayer";

import {
  createEmbeddedSubtitleController,
  type EmbeddedSubtitleController,
  type EmbeddedSubtitleControllerOptions,
  type EmbeddedSubtitleFailure,
  type EmbeddedSubtitleSource
} from "./controller";
import {
  createArtplayerEmbeddedSubtitleRenderer,
  type ArtplayerSubtitleRendererTarget,
  type EmbeddedSubtitleCueConstructor
} from "./render";
import type { EmbeddedSubtitleTrack } from "./types";

export const EMBEDDED_SUBTITLE_PLUGIN_NAME = "embeddedSubtitle";

/**
 * Minimal Artplayer surface the bridge depends on. Keeping it structural lets
 * tests drive the bridge without a DOM while a real Artplayer instance still
 * satisfies it.
 */
export interface EmbeddedSubtitleBridgeTarget extends ArtplayerSubtitleRendererTarget {
  readonly currentTime: number;
  readonly video?: { paused?: boolean } | null;
  on(name: string, fn: (...args: never[]) => unknown): unknown;
}

export interface EmbeddedSubtitleBridge {
  readonly name: typeof EMBEDDED_SUBTITLE_PLUGIN_NAME;
  readonly tracks: readonly EmbeddedSubtitleTrack[];
  readonly selectedTrack: EmbeddedSubtitleTrack | null;
  discover(): Promise<readonly EmbeddedSubtitleTrack[]>;
  updateSource(source: EmbeddedSubtitleSource | null): Promise<readonly EmbeddedSubtitleTrack[]>;
  selectTrack(trackId: string): Promise<boolean>;
  disable(): Promise<void>;
  destroy(): Promise<void>;
}

export interface ArtplayerEmbeddedSubtitleOptions {
  source?: EmbeddedSubtitleSource | null;
  openSession?: EmbeddedSubtitleControllerOptions["openSession"];
  cueConstructor?: EmbeddedSubtitleCueConstructor;
  onTracksChanged?: (tracks: readonly EmbeddedSubtitleTrack[]) => void;
  onSelectionChanged?: (track: EmbeddedSubtitleTrack | null) => void;
  onFailure?: (failure: EmbeddedSubtitleFailure) => void;
  prefetchSeconds?: number;
  /** Escape hatch for tests; production always builds a real controller. */
  createController?: (options: EmbeddedSubtitleControllerOptions) => EmbeddedSubtitleController;
}

/** Swallows rejections so a controller failure can never reach Artplayer. */
function ignore(promise: Promise<unknown>): void {
  void promise.then(
    () => undefined,
    () => undefined
  );
}

/**
 * Synchronous Artplayer plugin factory. It must stay synchronous: Artplayer
 * defers `art.plugins[name]` registration when a factory returns a Promise.
 */
export function artplayerEmbeddedSubtitle(
  options: ArtplayerEmbeddedSubtitleOptions = {}
): (art: Artplayer) => EmbeddedSubtitleBridge {
  return (artplayer: Artplayer): EmbeddedSubtitleBridge => {
    const art = artplayer as unknown as EmbeddedSubtitleBridgeTarget;

    const renderer = createArtplayerEmbeddedSubtitleRenderer(art, {
      cueConstructor: options.cueConstructor
    });

    const createController = options.createController ?? createEmbeddedSubtitleController;
    const controller = createController({
      source: options.source ?? null,
      openSession: options.openSession,
      renderer,
      getCurrentTime: () => {
        const value = art.currentTime;
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      },
      isPaused: () => art.video?.paused ?? true,
      onTracksChanged: options.onTracksChanged,
      onSelectionChanged: options.onSelectionChanged,
      onFailure: options.onFailure,
      prefetchSeconds: options.prefetchSeconds
    });

    let destroyed = false;
    let destroyPromise: Promise<void> | null = null;

    const destroy = (): Promise<void> => {
      if (destroyPromise) return destroyPromise;
      destroyed = true;
      destroyPromise = controller.destroy().then(
        () => undefined,
        () => undefined
      );
      return destroyPromise;
    };

    art.on("video:timeupdate", () => {
      if (destroyed) return;
      ignore(controller.handleTimeUpdate());
    });

    art.on("video:seeked", () => {
      if (destroyed) return;
      ignore(controller.handleSeek());
    });

    art.on("destroy", () => {
      ignore(destroy());
    });

    return {
      name: EMBEDDED_SUBTITLE_PLUGIN_NAME,

      get tracks() {
        return controller.tracks;
      },

      get selectedTrack() {
        return controller.selectedTrack;
      },

      discover() {
        if (destroyed) return Promise.resolve([]);
        return controller.discover();
      },

      updateSource(source) {
        if (destroyed) return Promise.resolve([]);
        return controller.updateSource(source);
      },

      selectTrack(trackId) {
        if (destroyed) return Promise.resolve(false);
        return controller.selectTrack(trackId);
      },

      disable() {
        if (destroyed) return Promise.resolve();
        return controller.disable();
      },

      destroy
    };
  };
}
