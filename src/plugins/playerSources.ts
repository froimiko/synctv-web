import type { BaseMovieInfo } from "@/types/Movie";
import type { EmbeddedSubtitleSource } from "./embeddedSubtitle/controller";
import type { EmbeddedSubtitleTrack } from "./embeddedSubtitle/types";
import type { ResolvedPlayerSource } from "./source";

/**
 * Pure source/eligibility plumbing extracted out of `Cinema.vue` so it can be
 * unit tested without a component instance, a DOM, or a real Artplayer.
 */

export const DEFAULT_SOURCE_LABEL = "默认";
export const EMBEDDED_SUBTITLE_FAILURE_MESSAGE = "内嵌字幕不可用";

/** Only extensionless/`.mkv` direct Emby sources can host embedded subtitles. */
const EMBEDDED_SUBTITLE_VENDOR = "emby";
const EMBEDDED_SUBTITLE_TYPE = "mkv";

export interface MovieSourceCandidate {
  /** Display label; never used as identity. */
  name: string;
  url: string;
  type?: string;
  sourceKey?: string;
  isTranscode?: boolean;
}

/**
 * Identity for one playable source slot. A backend `sourceKey` is preferred; the
 * slot fallback keeps non-Emby vendors (which never send one) stable. The two
 * namespaces are prefixed so a literal upstream key can never collide with a
 * synthesised slot key.
 */
export function playerSourceKey(sourceKey: string | undefined, slotIndex: number): string {
  const trimmed = typeof sourceKey === "string" ? sourceKey.trim() : "";
  return trimmed ? `source-key:${trimmed}` : `source-slot:${slotIndex}`;
}

export interface EmbeddedSubtitleEligibilityContext {
  vendor?: string;
  proxy: boolean;
  live: boolean;
}

/**
 * Range probing is only ever allowed for non-proxied, non-live, non-transcode
 * Emby MKV sources. Everything else must not even construct a source.
 */
export function isEmbeddedSubtitleEligible(
  context: EmbeddedSubtitleEligibilityContext,
  candidate: MovieSourceCandidate
): boolean {
  if (context.vendor?.toLowerCase() !== EMBEDDED_SUBTITLE_VENDOR) return false;
  if (context.proxy !== false || context.live !== false) return false;
  if (candidate.isTranscode === true) return false;
  if (typeof candidate.url !== "string" || candidate.url.length === 0) return false;
  return (candidate.type ?? "").toLowerCase() === EMBEDDED_SUBTITLE_TYPE;
}

export function embeddedSubtitleSourceFor(
  context: EmbeddedSubtitleEligibilityContext,
  candidate: MovieSourceCandidate,
  slotIndex: number
): EmbeddedSubtitleSource | null {
  if (!isEmbeddedSubtitleEligible(context, candidate)) return null;
  const sourceKey = typeof candidate.sourceKey === "string" ? candidate.sourceKey.trim() : "";
  return {
    url: candidate.url,
    // The controller keys tracks by sourceKey, so it must be unique per slot
    // even when the backend omitted the upstream MediaSource id.
    sourceKey: sourceKey || playerSourceKey(undefined, slotIndex)
  };
}

/** Primary source first, then `moreSources` in backend order. */
export function movieSourceCandidates(base: BaseMovieInfo): MovieSourceCandidate[] {
  const candidates: MovieSourceCandidate[] = [
    {
      name: DEFAULT_SOURCE_LABEL,
      url: base.url,
      type: base.type,
      sourceKey: base.sourceKey,
      isTranscode: base.isTranscode
    }
  ];

  for (const item of base.moreSources ?? []) {
    candidates.push({
      name: item.name,
      url: item.url,
      type: item.type,
      sourceKey: item.sourceKey,
      isTranscode: item.isTranscode
    });
  }

  return candidates;
}

export function buildPlayerSourceDescriptors(base: BaseMovieInfo): ResolvedPlayerSource[] {
  const context: EmbeddedSubtitleEligibilityContext = {
    vendor: base.vendorInfo?.vendor,
    proxy: base.proxy,
    live: base.live
  };

  return movieSourceCandidates(base).map((candidate, slotIndex) => ({
    key: playerSourceKey(candidate.sourceKey, slotIndex),
    html: candidate.name,
    url: candidate.url,
    type: candidate.type ?? "",
    embeddedSubtitle: embeddedSubtitleSourceFor(context, candidate, slotIndex)
  }));
}

/** The primary source is the one `playerOption` boots the player with. */
export function primaryEmbeddedSubtitleSource(base: BaseMovieInfo): EmbeddedSubtitleSource | null {
  return buildPlayerSourceDescriptors(base)[0]?.embeddedSubtitle ?? null;
}

/** True when ANY source slot can host embedded subtitles, not only the primary one. */
export function hasEmbeddedSubtitleCapableSource(base: BaseMovieInfo): boolean {
  return buildPlayerSourceDescriptors(base).some((source) => source.embeddedSubtitle !== null);
}

/** Stable movie identity used to discard refreshes that outlived their movie. */
export function movieIdentity(movie: { id?: string; subPath?: string } | null | undefined): string {
  return `${movie?.id ?? ""}\u0000${movie?.subPath ?? ""}`;
}

export interface RefreshGuard {
  /** Starts a refresh, invalidating every earlier one. */
  begin(identity: string): number;
  /**
   * True only for the newest refresh, and only while the movie identity that
   * was current when it started is still the live one.
   */
  isCurrent(token: number, liveIdentity: string): boolean;
}

export function createRefreshGuard(): RefreshGuard {
  let generation = 0;
  let startedIdentity: string | null = null;

  return {
    begin(identity) {
      generation += 1;
      startedIdentity = identity;
      return generation;
    },
    isCurrent(token, liveIdentity) {
      return token === generation && startedIdentity === liveIdentity;
    }
  };
}

/** Keeps the user's track choice across a refresh only if it still exists. */
export function restoredTrackId(
  previousTrackId: string | null | undefined,
  tracks: readonly EmbeddedSubtitleTrack[]
): string | null {
  if (!previousTrackId) return null;
  return tracks.some((track) => track.id === previousTrackId) ? previousTrackId : null;
}
