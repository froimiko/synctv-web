import type { RangeSourceOptions, ContentRangeInfo, CachedRange } from "./types";

export * from "./types";

/**
 * 纯函数：构建 Range 请求头字符串
 */
export function buildRangeHeader(start: number, end: number): string {
  return `bytes=${start}-${end}`;
}

/**
 * 纯函数：解析 Content-Range 响应头，形如 "bytes 0-1023/5000" 或 "bytes 0-1023/*"
 */
export function parseContentRange(header: string | null | undefined): ContentRangeInfo | null {
  if (!header) return null;
  // 匹配 bytes start-end/total
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  const totalStr = match[3];
  const total = totalStr === "*" ? -1 : parseInt(totalStr, 10);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    (totalStr !== "*" && !Number.isSafeInteger(total))
  ) {
    return null;
  }
  return { start, end, total };
}

/**
 * 纯函数：判断 Uint8Array 前4个字节是否为 EBML Header Magic (0x1A, 0x45, 0xDF, 0xA3)
 */
export function isMatroskaHeader(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  return data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3;
}

export class RangeSource {
  private url: string;
  private maxCacheBytes: number;
  private customFetch: typeof fetch;
  private cache: CachedRange[] = [];
  private currentCacheBytes = 0;
  private totalLength: number = -1;
  private accessCounter = 0;

  constructor(options: RangeSourceOptions) {
    this.url = options.url;
    this.maxCacheBytes = options.maxCacheBytes ?? 10 * 1024 * 1024; // 默认10MB
    this.customFetch =
      options.fetch ??
      (typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch);
  }

  public getTotalLength(): number {
    return this.totalLength;
  }

  public getCacheSize(): number {
    return this.currentCacheBytes;
  }

  /**
   * 从指定 byte 范围读取数据
   */
  public async read(start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0) {
      throw new Error(`Invalid range request: start ${start}, end ${end}`);
    }

    if (this.totalLength >= 0) {
      if (start >= this.totalLength) {
        throw new Error("Requested byte range starts beyond the known resource length");
      }
      end = Math.min(end, this.totalLength - 1);
    }

    // 检查缓存
    const cachedData = this.getFromCache(start, end);
    if (cachedData) {
      return cachedData.buffer.slice(
        cachedData.byteOffset,
        cachedData.byteOffset + cachedData.byteLength
      );
    }

    const rangeHeader = buildRangeHeader(start, end);
    let response: Response;
    try {
      response = await this.customFetch(this.url, {
        headers: {
          Range: rangeHeader
        },
        signal
      });
    } catch (err: unknown) {
      if ((err instanceof Error && err.name === "AbortError") || signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      throw new Error("Network request failed");
    }

    if (response.status === 200) {
      throw new Error("Server returned 200 OK; byte-range responses (206) are required");
    }

    if (response.status !== 206) {
      throw new Error(`Unexpected HTTP status code: ${response.status}`);
    }

    const parsedRange = parseContentRange(response.headers.get("Content-Range"));
    if (!parsedRange) {
      throw new Error("Invalid or missing Content-Range header");
    }
    if (parsedRange.start !== start) {
      throw new Error("Content-Range start does not match the requested range");
    }
    if (parsedRange.end < parsedRange.start || parsedRange.end > end) {
      throw new Error("Content-Range end is outside the requested range");
    }
    if (parsedRange.total !== -1) {
      if (
        parsedRange.total <= 0 ||
        parsedRange.start >= parsedRange.total ||
        parsedRange.end >= parsedRange.total
      ) {
        throw new Error("Content-Range is invalid for the reported resource length");
      }
      if (this.totalLength >= 0 && this.totalLength !== parsedRange.total) {
        throw new Error("Content-Range total changed between requests");
      }
      const isShortResponse = parsedRange.end < end;
      if (isShortResponse && parsedRange.end !== parsedRange.total - 1) {
        throw new Error("Content-Range may be shorter than requested only at EOF");
      }
      this.totalLength = parsedRange.total;
    } else if (parsedRange.end < end) {
      throw new Error("Content-Range with unknown total may not shorten the requested range");
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const expectedLength = parsedRange.end - parsedRange.start + 1;
    if (bytes.length !== expectedLength) {
      throw new Error("Response body length does not match Content-Range");
    }

    // 验证从 0 开始的首块为 EBML magic 1a45dfa3
    if (start === 0 && !isMatroskaHeader(bytes)) {
      throw new Error("Invalid EBML header magic; file is not a valid MKV/WebM media file");
    }

    // 写入缓存
    this.putCache(parsedRange.start, parsedRange.end, bytes);

    return arrayBuffer;
  }

  private getFromCache(start: number, end: number): Uint8Array | null {
    for (const range of this.cache) {
      if (start >= range.start && end <= range.end) {
        range.lastAccessed = ++this.accessCounter;
        const offset = start - range.start;
        const length = end - start + 1;
        return range.data.subarray(offset, offset + length);
      }
    }
    return null;
  }

  private putCache(start: number, end: number, data: Uint8Array) {
    const dataSize = data.length;

    // 如果单次数据大于 maxCacheBytes，简单裁剪或不做长期全量存（但视情况存切片）
    if (dataSize > this.maxCacheBytes) {
      this.cache = [];
      this.currentCacheBytes = 0;
      return;
    }

    // LRU 淘汰以容纳 new dataSize
    while (this.currentCacheBytes + dataSize > this.maxCacheBytes && this.cache.length > 0) {
      // 找到 lastAccessed 最小的项
      let oldestIndex = 0;
      let oldestTime = this.cache[0].lastAccessed;
      for (let i = 1; i < this.cache.length; i++) {
        if (this.cache[i].lastAccessed < oldestTime) {
          oldestTime = this.cache[i].lastAccessed;
          oldestIndex = i;
        }
      }
      const removed = this.cache.splice(oldestIndex, 1)[0];
      this.currentCacheBytes -= removed.data.length;
    }

    const newRange: CachedRange = {
      start,
      end,
      data: new Uint8Array(data),
      lastAccessed: ++this.accessCounter
    };

    this.cache.push(newRange);
    this.currentCacheBytes += dataSize;
  }
}
