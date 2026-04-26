import { InputFile } from "grammy";
import { detectImageMime } from "../agent/exec-tools.ts";
import { loadBytesFromSource } from "../agent/util.ts";

/**
 * Resolve an `[embed:...]` / `[file:...]` source (URL or local path) into
 * the right shape for Telegram's send methods, plus a hint about whether
 * it should be sent as a photo (compressed inline) or document (raw).
 *
 * For URLs we download bytes ourselves rather than passing the URL to
 * Telegram. Telegram's URL fetcher fails on signed CDN URLs, anti-bot
 * protections, weird Content-Types, etc. Multipart upload from bytes is
 * boring and reliable.
 *
 * `isImageBytes` looks at magic bytes first (the only true source of
 * truth — extensions and Content-Type headers lie), then falls back to
 * Content-Type for non-magic formats (svg, etc.) and to file.type for
 * local files without sniffable headers.
 */
export async function resolveEmbed(source: string): Promise<{
  file: InputFile;
  isImageBytes: boolean;
}> {
  if (/^https?:\/\//i.test(source)) {
    const { bytes, mediaType } = await loadBytesFromSource(source);
    const magicMime = detectImageMime(bytes);
    const isImage =
      magicMime !== null || (mediaType?.startsWith("image/") ?? false);
    let filename: string | undefined;
    try {
      const last = new URL(source)
        .pathname.split("/")
        .filter(Boolean)
        .pop();
      filename = last ? decodeURIComponent(last) : undefined;
    } catch {
      // ignore — Telegram falls back to a default filename
    }
    return { file: new InputFile(bytes, filename), isImageBytes: isImage };
  }

  // Local path — let grammy stream from disk (no need to read bytes).
  const localFile = Bun.file(source);
  return {
    file: new InputFile(source),
    isImageBytes: localFile.type.startsWith("image/"),
  };
}
