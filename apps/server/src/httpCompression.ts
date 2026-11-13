/**
 * gzip for large /mcp answers (#415).
 *
 * An MCP App's `app.html` goes out in a `resources/read` answer: about 0.9 MB
 * for a chart app and 2.2 MB for the route map, and gzip cuts each to under a
 * third. Over a home tunnel with a slow uplink that is most of a card's first
 * load. `Bun.serve` compresses nothing on its own.
 *
 * Only an answer that is complete before it is sent is compressed:
 *
 * - A JSON body (`application/json`), which is what a 2026-07-28 exchange
 *   answers unless the call streams.
 * - An SSE body that the caller says carries one answer and then ends. The
 *   2025-era path answers every POST as SSE, also a `resources/read`, and
 *   claude.ai loads its chart cards over that path. The endpoint decides
 *   (`answersOnce` in `mcpEndpoint.ts`): never a `tools/call`, whose stream
 *   can carry progress, and never a `subscriptions/listen`.
 *
 * A stream that can carry progress is never compressed: gzip holds bytes back
 * until it has a block to write, so a progress message or keep-alive would
 * reach the client late or not at all.
 */

/** Smallest body that is compressed. Below it, gzip saves too little to pay for itself. */
export const GZIP_MIN_BYTES = 8 * 1024;

/** The media type of a header value, without parameters, in lower case. */
function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * True when an `Accept-Encoding` value accepts gzip: `gzip` (or `x-gzip`) with
 * a q-value above 0, or `*` above 0 when gzip is not listed itself.
 */
export function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  let gzip: number | undefined;
  let any: number | undefined;
  for (const part of header.split(",")) {
    const [coding = "", ...params] = part.split(";");
    const name = coding.trim().toLowerCase();
    let q = 1;
    for (const param of params) {
      const [key = "", value = ""] = param.split("=");
      if (key.trim().toLowerCase() === "q") {
        const parsed = Number(value.trim());
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (name === "gzip" || name === "x-gzip") gzip = Math.max(gzip ?? 0, q);
    else if (name === "*") any = q;
  }
  return (gzip ?? any ?? 0) > 0;
}

async function gzip(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface GzipOptions {
  /**
   * The body is an SSE stream that carries one answer and ends, so it can be
   * read to the end before it is sent. Leave it out for a stream that can
   * carry progress.
   */
  completeStream?: boolean;
}

/**
 * `response` gzipped when the request accepts gzip, the body is complete
 * before it is sent (see the module comment), and it is at least
 * {@link GZIP_MIN_BYTES}. Any other response is returned as it is. A body
 * that was read but stays uncompressed goes out with its bytes and headers
 * unchanged.
 */
export async function gzipResponse(
  req: Request,
  response: Response,
  { completeStream = false }: GzipOptions = {},
): Promise<Response> {
  if (!response.body || response.headers.has("content-encoding")) {
    return response;
  }
  if (!acceptsGzip(req.headers.get("accept-encoding"))) return response;
  const type = mediaType(response.headers.get("content-type"));
  const complete =
    type === "application/json" ||
    (completeStream && type === "text/event-stream");
  if (!complete) return response;

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    // A stream ends early when the client leaves; nobody reads this answer.
    if (req.signal.aborted) return new Response(null, { status: 499 });
    throw error;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const init = { status: response.status, statusText: response.statusText };
  if (bytes.byteLength < GZIP_MIN_BYTES) {
    return new Response(bytes, { ...init, headers });
  }
  let compressed: Uint8Array<ArrayBuffer>;
  try {
    compressed = await gzip(bytes);
  } catch {
    // The answer is worth more than the saving.
    return new Response(bytes, { ...init, headers });
  }
  headers.set("content-encoding", "gzip");
  headers.append("vary", "Accept-Encoding");
  return new Response(compressed, {
    ...init,
    headers,
  });
}
