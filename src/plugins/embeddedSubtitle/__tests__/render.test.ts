import { describe, expect, it, vi } from "vitest";

import { createArtplayerEmbeddedSubtitleRenderer, createEmbeddedSubtitleRenderer } from "../render";
import type { EmbeddedSubtitleCue } from "../types";

class FakeVTTCue {
  constructor(public startTime: number, public endTime: number, public text: string) {}
}

class FakeTextTrack {
  cues: FakeVTTCue[] = [];
  private readonly listeners = new Set<() => void>();

  addCue(cue: FakeVTTCue): void {
    this.cues.push(cue);
  }

  removeCue(cue: FakeVTTCue): void {
    const index = this.cues.indexOf(cue);
    if (index < 0) throw new Error("Cue is not attached");
    this.cues.splice(index, 1);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "cuechange") return;
    this.listeners.add(listener as () => void);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "cuechange") return;
    this.listeners.delete(listener as () => void);
  }

  dispatchCueChange(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
}

function cue(overrides: Partial<EmbeddedSubtitleCue> = {}): EmbeddedSubtitleCue {
  return {
    key: "cue-1",
    sourceKey: "source-a",
    trackId: "track-a",
    startSeconds: 1,
    endSeconds: 3,
    text: "Hello",
    ...overrides
  };
}

function createRenderer(track: FakeTextTrack, setVisible = vi.fn(), update = vi.fn()) {
  return {
    renderer: createEmbeddedSubtitleRenderer({
      textTrack: track as unknown as TextTrack,
      cueConstructor: FakeVTTCue as unknown as typeof VTTCue,
      setVisible,
      update
    }),
    setVisible,
    update
  };
}

function escapeLikeArtplayer(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character];
  });
}

describe("embedded subtitle TextTrack renderer", () => {
  it("distinguishes added, duplicate, unavailable, and invalid results", () => {
    const track = new FakeTextTrack();
    const { renderer } = createRenderer(track);

    expect(renderer.add(cue())).toBe("added");
    expect(renderer.add(cue({ text: "Duplicate key" }))).toBe("duplicate");
    expect(renderer.add(cue({ key: "nan", startSeconds: Number.NaN }))).toBe("invalid");
    expect(renderer.add(cue({ key: "reverse", startSeconds: 4, endSeconds: 4 }))).toBe("invalid");
    expect(
      createEmbeddedSubtitleRenderer({
        textTrack: null,
        cueConstructor: FakeVTTCue as unknown as typeof VTTCue
      }).add(cue())
    ).toBe("unavailable");
    expect(track.cues).toEqual([
      expect.objectContaining({ startTime: 1, endTime: 3, text: "Hello" })
    ]);
    expect(renderer.size).toBe(1);
  });

  it("retries an unavailable cue after a TextTrack becomes available", () => {
    let track: FakeTextTrack | null = null;
    const renderer = createEmbeddedSubtitleRenderer({
      getTextTrack: () => track as unknown as TextTrack | null,
      cueConstructor: FakeVTTCue as unknown as typeof VTTCue
    });

    expect(renderer.add(cue())).toBe("unavailable");
    track = new FakeTextTrack();
    expect(renderer.add(cue())).toBe("added");
    expect(track.cues).toHaveLength(1);
  });

  it("clear removes only cues owned by this renderer and is idempotent", () => {
    const track = new FakeTextTrack();
    const before = new FakeVTTCue(0, 1, "Independent before");
    const after = new FakeVTTCue(8, 9, "Independent after");
    track.addCue(before);
    const { renderer } = createRenderer(track);
    renderer.add(cue());
    track.addCue(after);

    renderer.clear();
    renderer.clear();

    expect(track.cues).toEqual([before, after]);
    expect(renderer.size).toBe(0);
  });

  it("removeOutsideWindow removes only owned non-overlapping cues", () => {
    const track = new FakeTextTrack();
    const independent = new FakeVTTCue(20, 21, "Independent");
    track.addCue(independent);
    const { renderer } = createRenderer(track);
    renderer.add(cue({ key: "past", startSeconds: 0, endSeconds: 2 }));
    renderer.add(cue({ key: "inside", startSeconds: 5, endSeconds: 7 }));
    renderer.add(cue({ key: "future", startSeconds: 10, endSeconds: 12 }));

    renderer.removeOutsideWindow(3, 9);

    expect(track.cues).toEqual([
      independent,
      expect.objectContaining({ startTime: 5, endTime: 7, text: "Hello" })
    ]);
    expect(renderer.size).toBe(1);
  });

  it("actively updates after add/remove and on cuechange while active", () => {
    const track = new FakeTextTrack();
    const { renderer, update } = createRenderer(track);
    renderer.setActive(true);
    update.mockClear();

    renderer.add(cue());
    expect(update).toHaveBeenCalledTimes(1);
    track.dispatchCueChange();
    expect(update).toHaveBeenCalledTimes(2);
    renderer.removeOutsideWindow(4, 8);
    expect(update).toHaveBeenCalledTimes(3);
  });

  it("refreshes removed cues before hiding on deactivate and remains idempotent", () => {
    const events: string[] = [];
    const track = new FakeTextTrack();
    const independent = new FakeVTTCue(20, 21, "Independent");
    track.addCue(independent);
    const renderer = createEmbeddedSubtitleRenderer({
      textTrack: track as unknown as TextTrack,
      cueConstructor: FakeVTTCue as unknown as typeof VTTCue,
      update: () => events.push(`update:${track.cues.length}`),
      setVisible: (visible) => events.push(`visible:${visible}`)
    });
    renderer.setActive(true);
    renderer.add(cue());
    events.length = 0;

    renderer.setActive(false);
    renderer.setActive(false);

    expect(events).toEqual(["update:1", "visible:false"]);
    expect(track.cues).toEqual([independent]);
  });

  it("rebinds replacement tracks, clears old ownership, and allows re-adding", () => {
    const firstTrack = new FakeTextTrack();
    const secondTrack = new FakeTextTrack();
    let currentTrack = firstTrack;
    const update = vi.fn();
    const renderer = createEmbeddedSubtitleRenderer({
      getTextTrack: () => currentTrack as unknown as TextTrack,
      cueConstructor: FakeVTTCue as unknown as typeof VTTCue,
      update
    });
    renderer.setActive(true);
    expect(renderer.add(cue())).toBe("added");
    update.mockClear();

    currentTrack = secondTrack;
    expect(renderer.add(cue())).toBe("added");
    expect(firstTrack.cues).toHaveLength(0);
    expect(secondTrack.cues).toHaveLength(1);
    expect(update).toHaveBeenCalled();

    update.mockClear();
    firstTrack.dispatchCueChange();
    expect(update).not.toHaveBeenCalled();
    secondTrack.dispatchCueChange();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refreshes before detach/hide on destroy and ignores later cuechange", () => {
    const events: string[] = [];
    const track = new FakeTextTrack();
    const independent = new FakeVTTCue(20, 21, "Independent");
    track.addCue(independent);
    const originalRemoveEventListener = track.removeEventListener.bind(track);
    track.removeEventListener = (type, listener) => {
      events.push("detach");
      originalRemoveEventListener(type, listener);
    };
    const renderer = createEmbeddedSubtitleRenderer({
      textTrack: track as unknown as TextTrack,
      cueConstructor: FakeVTTCue as unknown as typeof VTTCue,
      update: () => events.push(`update:${track.cues.length}`),
      setVisible: (visible) => events.push(`visible:${visible}`)
    });
    renderer.setActive(true);
    renderer.add(cue());
    events.length = 0;

    renderer.destroy();
    renderer.destroy();
    track.dispatchCueChange();

    expect(events).toEqual(["update:1", "detach", "visible:false"]);

    expect(renderer.add(cue({ key: "after-destroy" }))).toBe("unavailable");
  });

  it("Artplayer adapter forces escape and preserves malicious cue text verbatim", () => {
    const track = new FakeTextTrack();
    const update = vi.fn();
    const art = {
      option: { subtitle: { escape: false } },
      subtitle: {
        textTrack: track as unknown as TextTrack,
        show: false,
        update
      }
    };
    const renderer = createArtplayerEmbeddedSubtitleRenderer(art, {
      cueConstructor: FakeVTTCue as unknown as typeof VTTCue
    });
    const malicious = `<img src=x onerror=alert(1)>\n<svg onload=alert(2)></svg>\n</div><script>bad()</script> & " '`;

    renderer.setActive(true);
    expect(renderer.add(cue({ text: malicious }))).toBe("added");

    expect(art.option.subtitle.escape).toBe(true);
    expect(track.cues[0]?.text).toBe(malicious);
    const escaped = escapeLikeArtplayer(track.cues[0]!.text);
    expect(escaped).not.toMatch(/<(?:img|svg|script|\/div)\b/i);
    expect(escaped).toContain("&lt;img");
    expect(art.subtitle.show).toBe(true);
    expect(update).toHaveBeenCalled();
  });
});
