import type { EmbeddedSubtitleCue } from "./types";

export type EmbeddedSubtitleCueConstructor = new (
  startTime: number,
  endTime: number,
  text: string
) => VTTCue;

export type EmbeddedSubtitleAddResult = "added" | "duplicate" | "unavailable" | "invalid";

export interface EmbeddedSubtitleRendererOptions {
  textTrack?: TextTrack | null;
  getTextTrack?: () => TextTrack | null | undefined;
  cueConstructor?: EmbeddedSubtitleCueConstructor;
  setVisible?: (visible: boolean) => void;
  update?: () => void;
}

export interface EmbeddedSubtitleRenderer {
  readonly size: number;
  setActive(active: boolean): void;
  add(cue: EmbeddedSubtitleCue): EmbeddedSubtitleAddResult;
  clear(): void;
  removeByKey(key: string): void;
  removeOutsideWindow(startSeconds: number, endSeconds: number): void;
  destroy(): void;
}

export interface ArtplayerSubtitleRendererTarget {
  option: {
    subtitle?: {
      escape?: boolean;
    };
  };
  readonly subtitle: {
    readonly textTrack: TextTrack | null | undefined;
    show: boolean;
    update(): void;
  };
}

interface OwnedCue {
  cue: VTTCue;
  track: TextTrack;
}

function getBrowserCueConstructor(): EmbeddedSubtitleCueConstructor | null {
  return typeof globalThis.VTTCue === "function" ? globalThis.VTTCue : null;
}

function isValidCue(cue: EmbeddedSubtitleCue): boolean {
  return (
    typeof cue.key === "string" &&
    cue.key.length > 0 &&
    typeof cue.text === "string" &&
    Number.isFinite(cue.startSeconds) &&
    Number.isFinite(cue.endSeconds) &&
    cue.endSeconds > cue.startSeconds
  );
}

export function createEmbeddedSubtitleRenderer(
  options: EmbeddedSubtitleRendererOptions
): EmbeddedSubtitleRenderer {
  const getTextTrack = options.getTextTrack ?? (() => options.textTrack ?? null);
  const ownedCues = new Map<string, OwnedCue>();
  let active = false;
  let destroyed = false;
  let boundTrack: TextTrack | null = null;

  const safeUpdate = (): void => {
    if (!active || destroyed) return;
    try {
      options.update?.();
    } catch {
      // Subtitle refresh failures must never affect video playback.
    }
  };

  // Cleanup can make the TextTrack change while the renderer is already
  // inactive/destroyed. Artplayer still needs one best-effort refresh so its
  // rebuilt subtitle DOM cannot retain a cue that this renderer removed.
  const forceUpdate = (): void => {
    try {
      options.update?.();
    } catch {
      // Subtitle refresh failures must never affect video playback.
    }
  };

  const onCueChange = (): void => {
    safeUpdate();
  };

  const detachTrack = (): void => {
    if (!boundTrack) return;
    const track = boundTrack;
    boundTrack = null;
    try {
      track.removeEventListener("cuechange", onCueChange);
    } catch {
      // A detached/replaced TextTrack may reject listener cleanup.
    }
  };

  const removeOwnedCue = (key: string, owned: OwnedCue): void => {
    try {
      owned.track.removeCue(owned.cue);
    } catch {
      // The browser may already have detached the track or cue. Ownership is
      // still dropped locally so repeated cleanup remains idempotent.
    }
    ownedCues.delete(key);
  };

  const dropTrackResidency = (track: TextTrack): boolean => {
    let removed = false;
    for (const [key, owned] of Array.from(ownedCues.entries())) {
      if (owned.track !== track) continue;
      removeOwnedCue(key, owned);
      removed = true;
    }
    return removed;
  };

  const currentTrack = (): TextTrack | null => {
    try {
      return getTextTrack() ?? null;
    } catch {
      return null;
    }
  };

  const syncTrackBinding = (): TextTrack | null => {
    const track = currentTrack();
    if (track === boundTrack) return track;

    const previousTrack = boundTrack;
    detachTrack();
    const removed = previousTrack ? dropTrackResidency(previousTrack) : false;

    if (track) {
      boundTrack = track;
      try {
        track.addEventListener("cuechange", onCueChange);
      } catch {
        // Listener binding is best-effort; add() remains retryable.
      }
    }
    if (removed) safeUpdate();
    return track;
  };

  const clearOwnedCues = (): boolean => {
    let removed = false;
    for (const [key, owned] of Array.from(ownedCues.entries())) {
      removeOwnedCue(key, owned);
      removed = true;
    }
    return removed;
  };

  const clearOwnedCuesAndRefresh = (force: boolean): boolean => {
    const removed = clearOwnedCues();
    if (removed) {
      if (force) forceUpdate();
      else safeUpdate();
    }
    return removed;
  };

  const clear = (): void => {
    if (destroyed) return;
    syncTrackBinding();
    clearOwnedCuesAndRefresh(false);
    syncTrackBinding();
  };

  return {
    get size() {
      return ownedCues.size;
    },

    setActive(nextActive) {
      if (destroyed) return;
      syncTrackBinding();
      if (active === nextActive) {
        if (nextActive) safeUpdate();
        else if (ownedCues.size > 0) clearOwnedCuesAndRefresh(true);
        return;
      }

      if (!nextActive) {
        active = false;
        clearOwnedCuesAndRefresh(true);
      } else {
        active = true;
      }
      try {
        options.setVisible?.(nextActive);
      } catch {
        // Visibility integration must never affect video playback.
      }
      if (nextActive) safeUpdate();
    },

    add(cue) {
      if (destroyed) return "unavailable";
      const track = syncTrackBinding();
      if (ownedCues.has(cue.key)) return "duplicate";
      if (!isValidCue(cue)) return "invalid";

      const Cue = options.cueConstructor ?? getBrowserCueConstructor();
      if (!track || !Cue) return "unavailable";

      try {
        const textCue = new Cue(cue.startSeconds, cue.endSeconds, cue.text);
        track.addCue(textCue);
        ownedCues.set(cue.key, { cue: textCue, track });
        safeUpdate();
        return "added";
      } catch {
        return "unavailable";
      }
    },

    clear,

    removeByKey(key) {
      if (destroyed || typeof key !== "string" || key.length === 0) return;
      syncTrackBinding();
      const owned = ownedCues.get(key);
      if (!owned) return;
      removeOwnedCue(key, owned);
      safeUpdate();
    },

    removeOutsideWindow(startSeconds, endSeconds) {
      if (
        destroyed ||
        !Number.isFinite(startSeconds) ||
        !Number.isFinite(endSeconds) ||
        endSeconds < startSeconds
      ) {
        return;
      }

      syncTrackBinding();
      let removed = false;
      for (const [key, owned] of Array.from(ownedCues.entries())) {
        if (owned.cue.endTime <= startSeconds || owned.cue.startTime >= endSeconds) {
          removeOwnedCue(key, owned);
          removed = true;
        }
      }
      syncTrackBinding();
      if (removed) safeUpdate();
    },

    destroy() {
      if (destroyed) return;
      const wasActive = active;
      clearOwnedCuesAndRefresh(true);
      active = false;
      detachTrack();
      if (wasActive) {
        try {
          options.setVisible?.(false);
        } catch {
          // Visibility integration must never affect video playback.
        }
      }
      destroyed = true;
    }
  };
}

export function createArtplayerEmbeddedSubtitleRenderer(
  art: ArtplayerSubtitleRendererTarget,
  options: Pick<EmbeddedSubtitleRendererOptions, "cueConstructor" | "setVisible"> = {}
): EmbeddedSubtitleRenderer {
  try {
    if (art.option.subtitle) art.option.subtitle.escape = true;
  } catch {
    // The formal Player option also enables escaping. This adapter is a
    // defense-in-depth boundary for compatible Artplayer-like targets.
  }

  return createEmbeddedSubtitleRenderer({
    getTextTrack: () => art.subtitle.textTrack,
    cueConstructor: options.cueConstructor,
    update: () => art.subtitle.update(),
    setVisible: (visible) => {
      art.subtitle.show = visible;
      options.setVisible?.(visible);
    }
  });
}
