import { describe, expect, it } from "vitest";

import type { BaseMovieInfo } from "@/types/Movie";
import type { EmbeddedSubtitleTrack } from "../embeddedSubtitle/types";
import {
  buildPlayerSourceDescriptors,
  createRefreshGuard,
  hasEmbeddedSubtitleCapableSource,
  isEmbeddedSubtitleEligible,
  movieIdentity,
  movieSourceCandidates,
  playerSourceKey,
  primaryEmbeddedSubtitleSource,
  restoredTrackId
} from "../playerSources";

function base(overrides: Partial<BaseMovieInfo> = {}): BaseMovieInfo {
  return {
    url: "https://emby.test/videos/1/stream",
    name: "movie",
    live: false,
    proxy: false,
    rtmpSource: false,
    type: "mkv",
    headers: {},
    vendorInfo: { vendor: "emby" },
    sourceKey: "media-source-1",
    isTranscode: false,
    ...overrides
  };
}

function track(overrides: Partial<EmbeddedSubtitleTrack> = {}): EmbeddedSubtitleTrack {
  return {
    id: "track-a",
    sourceKey: "media-source-1",
    streamIndex: 2,
    codecId: "S_TEXT/UTF8",
    isDefault: false,
    isForced: false,
    timeBase: { num: 1, den: 1000 },
    ...overrides
  };
}

const embyContext = { vendor: "emby", proxy: false, live: false };

describe("isEmbeddedSubtitleEligible", () => {
  const candidate = { name: "默认", url: "https://emby.test/a", type: "mkv", isTranscode: false };

  it("accepts a direct non-transcode Emby mkv source", () => {
    expect(isEmbeddedSubtitleEligible(embyContext, candidate)).toBe(true);
  });

  it("accepts an uppercase MKV type", () => {
    expect(isEmbeddedSubtitleEligible(embyContext, { ...candidate, type: "MKV" })).toBe(true);
  });

  it.each([
    ["non-emby vendor", { ...embyContext, vendor: "alist" }, candidate],
    ["missing vendor", { ...embyContext, vendor: undefined }, candidate],
    ["proxied", { ...embyContext, proxy: true }, candidate],
    ["live", { ...embyContext, live: true }, candidate],
    ["transcode", embyContext, { ...candidate, isTranscode: true }],
    ["non-mkv type", embyContext, { ...candidate, type: "mp4" }],
    ["missing type", embyContext, { ...candidate, type: undefined }],
    ["empty url", embyContext, { ...candidate, url: "" }]
  ])("rejects %s", (_label, context, input) => {
    expect(isEmbeddedSubtitleEligible(context, input)).toBe(false);
  });
});

describe("playerSourceKey", () => {
  it("prefers the backend source key", () => {
    expect(playerSourceKey("media-source-1", 3)).toBe("source-key:media-source-1");
  });

  it("falls back to a slot key when the backend omitted it", () => {
    expect(playerSourceKey(undefined, 2)).toBe("source-slot:2");
    expect(playerSourceKey("  ", 0)).toBe("source-slot:0");
  });

  it("keeps the two namespaces disjoint", () => {
    expect(playerSourceKey("source-slot:0", 1)).not.toBe(playerSourceKey(undefined, 0));
  });
});

describe("buildPlayerSourceDescriptors", () => {
  it("puts the primary source first and preserves moreSources order", () => {
    const descriptors = buildPlayerSourceDescriptors(
      base({
        moreSources: [
          { name: "1080p", url: "https://emby.test/b", type: "mkv", sourceKey: "media-source-2" },
          { name: "720p", url: "https://emby.test/c", type: "mp4", sourceKey: "media-source-3" }
        ]
      })
    );

    expect(descriptors.map((item) => item.html)).toEqual(["默认", "1080p", "720p"]);
    expect(descriptors.map((item) => item.key)).toEqual([
      "source-key:media-source-1",
      "source-key:media-source-2",
      "source-key:media-source-3"
    ]);
  });

  it("only attaches an embedded source to eligible slots", () => {
    const descriptors = buildPlayerSourceDescriptors(
      base({
        moreSources: [
          {
            name: "转码",
            url: "https://emby.test/t",
            type: "mkv",
            sourceKey: "media-source-2",
            isTranscode: true
          },
          { name: "mp4", url: "https://emby.test/m", type: "mp4", sourceKey: "media-source-3" }
        ]
      })
    );

    expect(descriptors[0].embeddedSubtitle).toEqual({
      url: "https://emby.test/videos/1/stream",
      sourceKey: "media-source-1"
    });
    expect(descriptors[1].embeddedSubtitle).toBeNull();
    expect(descriptors[2].embeddedSubtitle).toBeNull();
  });

  it("attaches no embedded source at all for a proxied movie", () => {
    const descriptors = buildPlayerSourceDescriptors(base({ proxy: true }));
    expect(descriptors.every((item) => item.embeddedSubtitle === null)).toBe(true);
  });

  it("attaches no embedded source at all for a non-emby vendor", () => {
    const descriptors = buildPlayerSourceDescriptors(base({ vendorInfo: { vendor: "alist" } }));
    expect(descriptors.every((item) => item.embeddedSubtitle === null)).toBe(true);
  });

  it("gives each eligible slot a distinct embedded source key when the backend omitted one", () => {
    const descriptors = buildPlayerSourceDescriptors(
      base({
        sourceKey: undefined,
        moreSources: [{ name: "备用", url: "https://emby.test/b", type: "mkv" }]
      })
    );

    const keys = descriptors.map((item) => item.embeddedSubtitle?.sourceKey);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBeDefined();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("carries the movie url without mutating it", () => {
    const info = base();
    const descriptors = buildPlayerSourceDescriptors(info);
    expect(descriptors[0].url).toBe(info.url);
    expect(movieSourceCandidates(info)).toHaveLength(1);
  });
});

describe("primaryEmbeddedSubtitleSource", () => {
  it("returns the primary source when eligible", () => {
    expect(primaryEmbeddedSubtitleSource(base())).toEqual({
      url: "https://emby.test/videos/1/stream",
      sourceKey: "media-source-1"
    });
  });

  it("returns null when the primary source is a transcode", () => {
    expect(primaryEmbeddedSubtitleSource(base({ isTranscode: true }))).toBeNull();
  });
});

describe("hasEmbeddedSubtitleCapableSource", () => {
  it("is true when only a secondary source is a direct Emby mkv", () => {
    const info = base({
      type: "m3u8",
      moreSources: [
        { name: "原画", url: "https://emby.test/b", type: "mkv", sourceKey: "media-source-2" }
      ]
    });

    expect(primaryEmbeddedSubtitleSource(info)).toBeNull();
    expect(hasEmbeddedSubtitleCapableSource(info)).toBe(true);
  });

  it("is true when the primary source is a transcode but a secondary one is not", () => {
    const info = base({
      isTranscode: true,
      moreSources: [
        { name: "直链", url: "https://emby.test/b", type: "mkv", sourceKey: "media-source-2" }
      ]
    });

    expect(primaryEmbeddedSubtitleSource(info)).toBeNull();
    expect(hasEmbeddedSubtitleCapableSource(info)).toBe(true);
  });

  it("is false when the movie is proxied", () => {
    const info = base({
      proxy: true,
      moreSources: [
        { name: "原画", url: "https://emby.test/b", type: "mkv", sourceKey: "media-source-2" }
      ]
    });

    expect(hasEmbeddedSubtitleCapableSource(info)).toBe(false);
  });

  it("is false when no slot is an mkv", () => {
    const info = base({
      type: "mp4",
      moreSources: [
        { name: "720p", url: "https://emby.test/b", type: "mp4", sourceKey: "media-source-2" }
      ]
    });

    expect(hasEmbeddedSubtitleCapableSource(info)).toBe(false);
  });

  it("is true for a single eligible primary source", () => {
    expect(hasEmbeddedSubtitleCapableSource(base())).toBe(true);
  });
});

describe("createRefreshGuard", () => {
  it("only lets the newest refresh apply", () => {
    const guard = createRefreshGuard();
    const first = guard.begin("movie-a");
    const second = guard.begin("movie-a");

    expect(guard.isCurrent(first, "movie-a")).toBe(false);
    expect(guard.isCurrent(second, "movie-a")).toBe(true);
  });

  it("discards a refresh whose movie changed while it was in flight", () => {
    const guard = createRefreshGuard();
    const token = guard.begin("movie-a");
    expect(guard.isCurrent(token, "movie-b")).toBe(false);
  });
});

describe("movieIdentity", () => {
  it("separates id from subPath so concatenations cannot collide", () => {
    expect(movieIdentity({ id: "a", subPath: "bc" })).not.toBe(
      movieIdentity({ id: "ab", subPath: "c" })
    );
  });

  it("tolerates a missing movie", () => {
    expect(movieIdentity(null)).toBe(movieIdentity(undefined));
  });
});

describe("restoredTrackId", () => {
  it("keeps the previous track when it survived the refresh", () => {
    expect(restoredTrackId("track-a", [track()])).toBe("track-a");
  });

  it("drops the previous track when it is gone", () => {
    expect(restoredTrackId("track-a", [track({ id: "track-b" })])).toBeNull();
  });

  it("returns null when nothing was selected", () => {
    expect(restoredTrackId(null, [track()])).toBeNull();
  });
});
