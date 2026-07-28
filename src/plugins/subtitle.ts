import Artplayer from "artplayer";
import type { Selector } from "artplayer/types/component";
import type { Events } from "artplayer/types/events";

import type { EmbeddedSubtitleBridge } from "./embeddedSubtitle/artplayerBridge";
import type { EmbeddedSubtitleTrack } from "./embeddedSubtitle/types";

/** Only one subtitle producer may own the output at any time. */
export type SubtitleMode =
  | { kind: "off" }
  | { kind: "external"; id: string; url: string; type: string }
  | { kind: "ass"; id: string; url: string }
  | { kind: "embedded"; trackId: string };

export interface ExternalSubtitles {
  [key: string]: { url: string; type: string };
}

export interface ArtplayerSubtitleOptions {
  getEmbeddedBridge?: () => EmbeddedSubtitleBridge | null | undefined;
  embeddedEnabled?: boolean;
}

export interface SubtitleCoordinator {
  readonly name: "artplayerSubtitle";
  currentMode(): SubtitleMode;
  setMode(mode: SubtitleMode): Promise<void>;
  updateSubtitles(subtitles: ExternalSubtitles): void;
  updateEmbeddedTracks(tracks: readonly EmbeddedSubtitleTrack[]): void;
  destroy(): void;
}

const disableSubtitleStr = "关闭";
const embeddedUnavailableMessage = "内嵌字幕不可用";
const SUBTITLE_LABEL_STYLE =
  "background-color: #fff; color: #000; padding: 2px 6px; border-radius: 5px; font-size: 14px;";

const ASS_PLUGIN_NAME = "artplayerPluginAss";
const ASS_READY_POLL_INTERVAL_MS = 200;
const ASS_READY_POLL_MAX_ATTEMPTS = 25;

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/**
 * Selector labels are injected through `innerHTML` by Artplayer, so every
 * untrusted name (external subtitle key, Matroska track name/language) must be
 * escaped here. `option.subtitle.escape` only protects cue text.
 */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

const newSubtitleHtml = (name: string): HTMLElement => {
  const SubtitleHtml = document.createElement("span");
  SubtitleHtml.style.cssText = SUBTITLE_LABEL_STYLE;
  SubtitleHtml.innerText = name;
  return SubtitleHtml;
};

/** DOM-free fallback keeps the coordinator usable in non-DOM environments. */
const subtitleLabelHtml = (name: string): string => {
  try {
    return newSubtitleHtml(name).outerHTML;
  } catch {
    return `<span style="${SUBTITLE_LABEL_STYLE}">${escapeHtml(name)}</span>`;
  }
};

const embeddedTrackLabel = (track: EmbeddedSubtitleTrack): string => {
  const name = track.name?.trim() || track.language?.trim() || `轨道 ${track.streamIndex}`;
  const suffix = track.isForced ? "（强制）" : "";
  return `内嵌 ${name}${suffix}`;
};

interface SelectorItem {
  html: string;
  subtitleId: string;
  default: boolean;
}

function modeId(mode: SubtitleMode): string {
  switch (mode.kind) {
    case "external":
      return `external:${mode.id}`;
    case "ass":
      return `ass:${mode.id}`;
    case "embedded":
      return `embedded:${mode.trackId}`;
    default:
      return "off";
  }
}

function modesEqual(first: SubtitleMode, second: SubtitleMode): boolean {
  return modeId(first) === modeId(second);
}

export function artplayerSubtitle(
  subtitles: ExternalSubtitles,
  options: ArtplayerSubtitleOptions = {}
) {
  return (art: Artplayer): SubtitleCoordinator => {
    const subtitleHTML = subtitleLabelHtml("字幕");
    const embeddedEnabled = options.embeddedEnabled ?? Boolean(options.getEmbeddedBridge);
    const isMobile = Artplayer.utils.isMobile;

    let externalSubtitles: ExternalSubtitles = { ...subtitles };
    let embeddedTracks: readonly EmbeddedSubtitleTrack[] = [];
    let selectorItems: SelectorItem[] = [];
    let modeById = new Map<string, SubtitleMode>();

    /** Last requested mode; the menu highlights this one. */
    let mode: SubtitleMode = { kind: "off" };
    /** Mode whose resources may still be attached, used for teardown. */
    let appliedMode: SubtitleMode = { kind: "off" };
    let userSelected = false;
    let destroyed = false;

    let generation = 0;
    let queue: Promise<void> = Promise.resolve();

    let assPollTimer: ReturnType<typeof setTimeout> | null = null;

    const safely = (run: () => void): void => {
      try {
        run();
      } catch {
        // Subtitle plumbing must never break playback.
      }
    };

    const notice = (message: string): void => {
      safely(() => {
        art.notice.show = message;
      });
    };

    const bridge = (): EmbeddedSubtitleBridge | null => {
      if (!embeddedEnabled || destroyed) return null;
      try {
        return options.getEmbeddedBridge?.() ?? null;
      } catch {
        return null;
      }
    };

    const hideExternal = (): void => {
      safely(() => {
        art.subtitle.show = false;
      });
    };

    const hideAss = (): void => {
      safely(() => {
        art.emit("artplayer-plugin-ass:visible" as keyof Events, false);
      });
    };

    const clearAssPoll = (): void => {
      if (assPollTimer === null) return;
      clearTimeout(assPollTimer);
      assPollTimer = null;
    };

    const assPluginReady = (): boolean => {
      try {
        return Boolean(art.plugins?.[ASS_PLUGIN_NAME]);
      } catch {
        return false;
      }
    };

    const emitAssSwitch = (url: string): void => {
      safely(() => {
        art.emit("artplayer-plugin-ass:switch" as keyof Events, url);
      });
    };

    /**
     * The ASS plugin factory is async, so `art.plugins.artplayerPluginAss` (and
     * its event listeners) can appear after this selection. Retry within a
     * bounded window instead of dropping the user's choice.
     */
    const requestAss = (url: string, token: number): void => {
      clearAssPoll();
      if (assPluginReady()) {
        emitAssSwitch(url);
        return;
      }

      let attempts = 0;
      const poll = (): void => {
        assPollTimer = null;
        if (destroyed || token !== generation) return;
        if (assPluginReady()) {
          emitAssSwitch(url);
          return;
        }
        attempts += 1;
        if (attempts >= ASS_READY_POLL_MAX_ATTEMPTS) return;
        assPollTimer = setTimeout(poll, ASS_READY_POLL_INTERVAL_MS);
      };
      assPollTimer = setTimeout(poll, ASS_READY_POLL_INTERVAL_MS);
    };

    const disableEmbedded = async (): Promise<void> => {
      const embedded = bridge();
      if (!embedded) return;
      try {
        await embedded.disable();
      } catch {
        // Fail-open: embedded subtitles simply stay off.
      }
    };

    const buildSelector = (): void => {
      const items: SelectorItem[] = [];
      const nextModes = new Map<string, SubtitleMode>();

      const register = (candidate: SubtitleMode, label: string): void => {
        const id = modeId(candidate);
        nextModes.set(id, candidate);
        items.push({
          html: label,
          subtitleId: id,
          default: modesEqual(candidate, mode)
        });
      };

      for (const key of Object.keys(externalSubtitles)) {
        const entry = externalSubtitles[key];
        if (!entry || typeof entry.url !== "string" || entry.url.length === 0) continue;
        const candidate: SubtitleMode =
          entry.type?.toLowerCase() === "ass"
            ? { kind: "ass", id: key, url: entry.url }
            : { kind: "external", id: key, url: entry.url, type: entry.type };
        register(candidate, escapeHtml(key));
      }

      if (embeddedEnabled) {
        for (const track of embeddedTracks) {
          register({ kind: "embedded", trackId: track.id }, escapeHtml(embeddedTrackLabel(track)));
        }
      }

      register({ kind: "off" }, escapeHtml(disableSubtitleStr));

      selectorItems = items;
      modeById = nextModes;
    };

    const onSelect = (item: Selector) => {
      const subtitleId = (item as Partial<SelectorItem>)?.subtitleId;
      const next = (subtitleId && modeById.get(subtitleId)) || { kind: "off" as const };
      userSelected = true;
      void requestMode(next);
      return subtitleHTML;
    };

    const updateControls = (): void => {
      if (destroyed) return;
      if (!isMobile || art.fullscreen) {
        safely(() => {
          art.controls.update({
            name: "subtitle",
            position: "right",
            html: subtitleHTML,
            selector: selectorItems,
            onSelect
          });
        });
      } else if (art.controls["subtitle"]) {
        safely(() => {
          art.controls.remove("subtitle");
        });
      }
    };

    const refreshMenu = (): void => {
      if (destroyed) return;
      buildSelector();
      updateControls();
      safely(() => {
        art.setting.update({
          name: "subtitle",
          html: subtitleHTML,
          selector: selectorItems,
          onSelect
        });
      });
    };

    const teardown = async (previous: SubtitleMode): Promise<void> => {
      switch (previous.kind) {
        case "external":
          hideExternal();
          break;
        case "ass":
          clearAssPoll();
          hideAss();
          break;
        case "embedded":
          await disableEmbedded();
          break;
        default:
          break;
      }
    };

    const setup = async (target: SubtitleMode, token: number): Promise<void> => {
      if (target.kind === "off") {
        hideExternal();
        hideAss();
        await disableEmbedded();
        return;
      }

      if (target.kind === "ass") {
        hideExternal();
        await disableEmbedded();
        if (token !== generation) return;
        requestAss(target.url, token);
        return;
      }

      if (target.kind === "external") {
        hideAss();
        await disableEmbedded();
        if (token !== generation) return;
        try {
          await art.subtitle.switch(target.url, { type: target.type });
        } catch {
          // A failed external subtitle must not break playback.
          hideExternal();
          return;
        }
        // A late response must never override a newer selection.
        if (token !== generation) {
          hideExternal();
          return;
        }
        safely(() => {
          art.subtitle.show = true;
        });
        return;
      }

      // embedded
      hideExternal();
      hideAss();
      const embedded = bridge();
      if (!embedded) {
        if (token === generation) fallbackToOff(token);
        return;
      }
      let selected = false;
      try {
        selected = await embedded.selectTrack(target.trackId);
      } catch {
        selected = false;
      }
      if (token !== generation) return;
      if (!selected) {
        notice(embeddedUnavailableMessage);
        await disableEmbedded();
        if (token === generation) fallbackToOff(token);
      }
    };

    const fallbackToOff = (token: number): void => {
      if (token !== generation) return;
      mode = { kind: "off" };
      appliedMode = { kind: "off" };
      hideExternal();
      hideAss();
      refreshMenu();
    };

    const applyMode = async (target: SubtitleMode, token: number): Promise<void> => {
      // A newer request already superseded this one; never touch the output.
      if (destroyed || token !== generation) return;

      await teardown(appliedMode);
      if (destroyed || token !== generation) return;

      // Recorded before setup so a superseded partial setup is still torn down.
      appliedMode = target;
      await setup(target, token);
    };

    const requestMode = (target: SubtitleMode): Promise<void> => {
      if (destroyed) return Promise.resolve();
      generation += 1;
      const token = generation;
      mode = target;
      clearAssPoll();
      refreshMenu();
      queue = queue.then(() => applyMode(target, token)).catch(() => undefined);
      return queue;
    };

    const autoSelect = (): void => {
      if (destroyed || userSelected || mode.kind !== "off") return;

      const externalKeys = Object.keys(externalSubtitles);
      if (externalKeys.length === 1) {
        const candidate =
          modeById.get(`external:${externalKeys[0]}`) ?? modeById.get(`ass:${externalKeys[0]}`);
        if (candidate) {
          void requestMode(candidate);
          return;
        }
      }

      if (externalKeys.length > 0 || !embeddedEnabled || embeddedTracks.length === 0) return;

      const forced = embeddedTracks.find((track) => track.isForced);
      const preferred =
        forced ??
        (embeddedTracks.length === 1
          ? embeddedTracks[0]
          : embeddedTracks.find((track) => track.isDefault));
      if (!preferred) return;
      void requestMode({ kind: "embedded", trackId: preferred.id });
    };

    const destroy = (): void => {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      clearAssPoll();
    };

    refreshMenu();

    // Bound exactly once here; refreshMenu() must never re-register it.
    if (isMobile) art.on("fullscreen", updateControls);

    art.on("destroy", destroy);

    autoSelect();

    return {
      name: "artplayerSubtitle",

      currentMode() {
        return mode;
      },

      setMode(next) {
        userSelected = true;
        return requestMode(next);
      },

      updateSubtitles(nextSubtitles) {
        externalSubtitles = { ...nextSubtitles };
        buildSelector();
        if ((mode.kind === "external" || mode.kind === "ass") && !modeById.has(modeId(mode))) {
          void requestMode({ kind: "off" });
          return;
        }
        refreshMenu();
        autoSelect();
      },

      updateEmbeddedTracks(tracks) {
        embeddedTracks = Array.from(tracks);
        buildSelector();
        if (mode.kind === "embedded" && !modeById.has(modeId(mode))) {
          void requestMode({ kind: "off" });
          return;
        }
        refreshMenu();
        autoSelect();
      },

      destroy
    };
  };
}
