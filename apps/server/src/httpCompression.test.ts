import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { acceptsGzip, GZIP_MIN_BYTES, gzipResponse } from "./httpCompression";

const LARGE = JSON.stringify({ text: "x".repeat(GZIP_MIN_BYTES * 4) });
const SMALL = JSON.stringify({ text: "small" });

function request(acceptEncoding?: string, signal?: AbortSignal): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: acceptEncoding ? { "Accept-Encoding": acceptEncoding } : {},
    signal,
  });
}

function json(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sse(body: string): Response {
  return new Response(`event: message\ndata: ${body}\n\n`, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

async function decoded(response: Response): Promise<string> {
  return gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
}

describe("acceptsGzip", () => {
  it.each([
    ["gzip", true],
    ["gzip, deflate, br", true],
    ["br;q=1.0, gzip;q=0.8", true],
    ["x-gzip", true],
    ["*", true],
    ["GZIP", true],
    ["gzip;q=0", false],
    ["gzip;q=0.0, *", false],
    ["*;q=0", false],
    ["deflate, br", false],
    ["identity", false],
    ["", false],
  ])("%j → %s", (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });

  it("is false with no header", () => {
    expect(acceptsGzip(null)).toBe(false);
  });
});

describe("gzipResponse", () => {
  it("gzips a large JSON answer, which decodes byte-equal", async () => {
    const response = await gzipResponse(request("gzip"), json(LARGE));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await decoded(response)).toBe(LARGE);
  });

  it("keeps the status of a large JSON error answer", async () => {
    const response = await gzipResponse(request("gzip"), json(LARGE, 413));
    expect(response.status).toBe(413);
    expect(await decoded(response)).toBe(LARGE);
  });

  it("changes nothing without Accept-Encoding", async () => {
    const original = json(LARGE);
    const response = await gzipResponse(request(), original);
    expect(response).toBe(original);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(LARGE);
  });

  it("changes nothing when the client refuses gzip", async () => {
    const original = json(LARGE);
    expect(await gzipResponse(request("gzip;q=0, br"), original)).toBe(
      original,
    );
  });

  it("sends a small answer uncompressed, with its bytes and headers", async () => {
    const response = await gzipResponse(request("gzip"), json(SMALL));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(SMALL);
  });

  it("never touches an SSE stream that can carry progress", async () => {
    const original = sse(LARGE);
    const response = await gzipResponse(request("gzip"), original);
    expect(response).toBe(original);
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("gzips an SSE stream the caller marks as one complete answer", async () => {
    const response = await gzipResponse(request("gzip"), sse(LARGE), {
      completeStream: true,
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    expect(await decoded(response)).toBe(`event: message\ndata: ${LARGE}\n\n`);
  });

  it("leaves other content types alone", async () => {
    const original = new Response("x".repeat(GZIP_MIN_BYTES * 2), {
      headers: { "Content-Type": "text/plain" },
    });
    expect(await gzipResponse(request("gzip"), original)).toBe(original);
  });

  it("leaves an answer with no body or an encoding alone", async () => {
    const empty = new Response(null, { status: 202 });
    expect(await gzipResponse(request("gzip"), empty)).toBe(empty);
    const encoded = new Response(LARGE, {
      headers: { "Content-Type": "application/json", "Content-Encoding": "br" },
    });
    expect(await gzipResponse(request("gzip"), encoded)).toBe(encoded);
  });

  it("answers 499 when a stream ends early because the client left", async () => {
    const controller = new AbortController();
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("event: message\n"));
        controller.abort();
        stream.error(new Error("client left"));
      },
    });
    const response = await gzipResponse(
      request("gzip", controller.signal),
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      { completeStream: true },
    );
    expect(response.status).toBe(499);
  });

  it("passes on a stream failure while the client is still there", async () => {
    const body = new ReadableStream({
      start(stream) {
        stream.error(new Error("broken"));
      },
    });
    await expect(
      gzipResponse(
        request("gzip"),
        new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        }),
        { completeStream: true },
      ),
    ).rejects.toThrow("broken");
  });
});
