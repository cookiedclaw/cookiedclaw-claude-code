/**
 * Read raw bytes from either an http(s) URL (via `fetch`) or a local
 * filesystem path (via Bun.file). Returns the bytes plus the best-guess
 * media type from the response headers / file extension. Throws on missing
 * file or non-2xx HTTP.
 *
 * Centralized so image tools, embed dispatch, and anywhere else that needs
 * "give me bytes for this source string" share one implementation.
 */
export async function loadBytesFromSource(source: string): Promise<{
  bytes: Uint8Array;
  mediaType?: string;
}> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${source}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mediaType =
      res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ||
      undefined;
    return { bytes, mediaType };
  }
  const file = Bun.file(source);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${source}`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, mediaType: file.type || undefined };
}

/**
 * Race a promise against an abort signal. Rejects with the signal's reason
 * when aborted; otherwise resolves with the promise's value. The underlying
 * promise's work may continue if it doesn't natively support cancellation —
 * we just stop waiting on it.
 */
export async function abortable<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise as Promise<T>;
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
