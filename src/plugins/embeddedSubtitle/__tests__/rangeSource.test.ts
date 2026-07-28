import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRangeHeader, parseContentRange, isMatroskaHeader, RangeSource } from "../rangeSource";

describe("RangeSource pure functions", () => {
  it("buildRangeHeader returns correct range string", () => {
    expect(buildRangeHeader(0, 511)).toBe("bytes=0-511");
    expect(buildRangeHeader(100, 200)).toBe("bytes=100-200");
  });

  it("parseContentRange correctly parses valid Content-Range headers", () => {
    expect(parseContentRange("bytes 0-511/1024")).toEqual({
      start: 0,
      end: 511,
      total: 1024
    });
    expect(parseContentRange("bytes 100-200/*")).toEqual({
      start: 100,
      end: 200,
      total: -1
    });
  });

  it("parseContentRange returns null for invalid headers", () => {
    expect(parseContentRange(null)).toBeNull();
    expect(parseContentRange(undefined)).toBeNull();
    expect(parseContentRange("invalid header")).toBeNull();
    expect(parseContentRange("bytes invalid/100")).toBeNull();
  });

  it("isMatroskaHeader validates EBML magic", () => {
    const validEbml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
    const invalidEbml = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    const shortBuffer = new Uint8Array([0x1a, 0x45]);

    expect(isMatroskaHeader(validEbml)).toBe(true);
    expect(isMatroskaHeader(invalidEbml)).toBe(false);
    expect(isMatroskaHeader(shortBuffer)).toBe(false);
  });
});

describe("RangeSource class", () => {
  const SECRET_URL = "http://secret-domain.com/private/video.mkv";
  const validHeaderData = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x99, 0x88, 0x77, 0x66]);
  const dummyBodyData = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("fetches range data with 206 status and verifies EBML magic on start=0", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 206,
      headers: new Headers({
        "Content-Range": "bytes 0-7/1000"
      }),
      arrayBuffer: async () => validHeaderData.buffer.slice(0)
    });

    const source = new RangeSource({
      url: SECRET_URL,
      fetch: fetchMock
    });

    const result = await source.read(0, 7);
    expect(result.byteLength).toBe(8);
    expect(source.getTotalLength()).toBe(1000);
    expect(fetchMock).toHaveBeenCalledWith(
      SECRET_URL,
      expect.objectContaining({
        headers: { Range: "bytes=0-7" }
      })
    );
  });

  it("rejects when server returns HTTP 200 before calling arrayBuffer", async () => {
    const arrayBufferSpy = vi.fn();
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: new Headers({}),
      arrayBuffer: arrayBufferSpy
    });

    const source = new RangeSource({
      url: SECRET_URL,
      fetch: fetchMock
    });

    let error: any;
    try {
      await source.read(0, 100);
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toContain("200");
    expect(error.message).not.toContain(SECRET_URL);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it("rejects when Content-Range is invalid", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 206,
      headers: new Headers({
        "Content-Range": "invalid-range"
      }),
      arrayBuffer: async () => dummyBodyData.buffer.slice(0)
    });

    const source = new RangeSource({
      url: SECRET_URL,
      fetch: fetchMock
    });

    await expect(source.read(10, 13)).rejects.toThrow("Content-Range");
  });

  it("rejects Content-Range start or end mismatches before reading the body", async () => {
    const bodySpy = vi.fn(async () => dummyBodyData.buffer.slice(0));
    fetchMock
      .mockResolvedValueOnce({
        status: 206,
        headers: new Headers({ "Content-Range": "bytes 11-13/100" }),
        arrayBuffer: bodySpy
      })
      .mockResolvedValueOnce({
        status: 206,
        headers: new Headers({ "Content-Range": "bytes 10-14/100" }),
        arrayBuffer: bodySpy
      });

    const source = new RangeSource({ url: SECRET_URL, fetch: fetchMock });
    await expect(source.read(10, 13)).rejects.toThrow("start");
    await expect(source.read(10, 13)).rejects.toThrow("end");
    expect(bodySpy).not.toHaveBeenCalled();
  });

  it("rejects body length mismatches", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 206,
      headers: new Headers({ "Content-Range": "bytes 10-13/100" }),
      arrayBuffer: async () => new Uint8Array([0xaa, 0xbb, 0xcc]).buffer
    });

    const source = new RangeSource({ url: SECRET_URL, fetch: fetchMock });
    await expect(source.read(10, 13)).rejects.toThrow("body length");
  });

  it("allows a short response only when it reaches the reported EOF", async () => {
    const eofData = new Uint8Array([0xaa, 0xbb, 0xcc]);
    fetchMock.mockResolvedValueOnce({
      status: 206,
      headers: new Headers({ "Content-Range": "bytes 97-99/100" }),
      arrayBuffer: async () => eofData.buffer.slice(0)
    });

    const source = new RangeSource({ url: SECRET_URL, fetch: fetchMock });
    const result = await source.read(97, 110);
    expect(new Uint8Array(result)).toEqual(eofData);
    expect(source.getTotalLength()).toBe(100);
  });

  it("rejects a short response that does not reach EOF", async () => {
    const bodySpy = vi.fn(async () => dummyBodyData.buffer.slice(0));
    fetchMock.mockResolvedValueOnce({
      status: 206,
      headers: new Headers({ "Content-Range": "bytes 10-13/100" }),
      arrayBuffer: bodySpy
    });

    const source = new RangeSource({ url: SECRET_URL, fetch: fetchMock });
    await expect(source.read(10, 20)).rejects.toThrow("EOF");
    expect(bodySpy).not.toHaveBeenCalled();
  });

  it("rejects when start=0 and EBML magic is missing", async () => {
    const invalidHeaderData = new Uint8Array([0x00, 0x11, 0x22, 0x33]);
    fetchMock.mockResolvedValueOnce({
      status: 206,
      headers: new Headers({
        "Content-Range": "bytes 0-3/100"
      }),
      arrayBuffer: async () => invalidHeaderData.buffer.slice(0)
    });

    const source = new RangeSource({
      url: SECRET_URL,
      fetch: fetchMock
    });

    await expect(source.read(0, 3)).rejects.toThrow("EBML header magic");
  });

  it("uses cached data for subsequent range requests if sub-range is covered", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 206,
      headers: new Headers({
        "Content-Range": "bytes 0-7/1000"
      }),
      arrayBuffer: async () => validHeaderData.buffer.slice(0)
    });

    const source = new RangeSource({
      url: SECRET_URL,
      fetch: fetchMock
    });

    await source.read(0, 7);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 再次读取子区间 2..5
    const cachedResult = await source.read(2, 5);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 无额外网络请求
    const uint8 = new Uint8Array(cachedResult);
    expect(uint8).toEqual(validHeaderData.subarray(2, 6));
  });

  it("handles AbortSignal before and during fetch", async () => {
    const source = new RangeSource({
      url: SECRET_URL,
      fetch: fetchMock
    });

    const controller = new AbortController();
    controller.abort();

    await expect(source.read(0, 7, controller.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    const controller2 = new AbortController();
    fetchMock.mockImplementationOnce((_url: string, options: any) => {
      return new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const readPromise = source.read(0, 7, controller2.signal);
    controller2.abort();

    await expect(readPromise).rejects.toThrow();
  });

  it("never exposes secret URL in error messages", async () => {
    fetchMock.mockRejectedValueOnce(
      new Error("Network failed at http://secret-domain.com/private/video.mkv")
    );

    const source = new RangeSource({
      url: SECRET_URL,
      fetch: fetchMock
    });

    let caughtError: any;
    try {
      await source.read(0, 7);
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError.message).not.toContain(SECRET_URL);
  });
});
