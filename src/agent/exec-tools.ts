import { isAbsolute, resolve } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Detect actual image MIME from the file's magic bytes. Filename extension
 * lies often (e.g. `sips -Z` writes PNG content into a .jpg-named file).
 * Anthropic vision rejects mismatched MIME, so we use what's really there.
 * Returns null for unknown formats; caller falls back to extension-based MIME.
 */
export function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38 (GIF8)
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  // WebP: "RIFF" + 4-byte size + "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export type ExecOptions = {
  /** Default cwd for bash and base for relative paths in read/write/edit. */
  workspace: string;
};

/**
 * bash, read, write, edit tools. The workspace is just a preferred cwd —
 * absolute paths anywhere on the host work too. This is a self-hosted
 * personal bot, so we trust approved users with full filesystem access.
 */
export function buildExecTools({ workspace }: ExecOptions): ToolSet {
  let ensured = false;
  async function ensureWorkspace(): Promise<void> {
    if (ensured) return;
    await Bun.write(resolve(workspace, ".gitkeep"), "");
    ensured = true;
  }

  function resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(workspace, p);
  }

  return {
    bash: tool({
      description:
        "Execute a shell command. Cwd defaults to your workspace; absolute paths work for accessing anywhere on the host. Returns full stdout, stderr, exit code. Default timeout 30s.\n\nNon-interactive: stdin is closed. Anything that prompts (sudo password, brew confirmations, ssh-keygen passphrase, apt-get without -y, npx without -y, …) will fail immediately on EOF, not hang. Pass non-interactive flags (e.g. `-y`, `--yes`, `NEEDRESTART_MODE=a`, `DEBIAN_FRONTEND=noninteractive`) when available; otherwise tell the user to run the command in their own terminal and report back.\n\nNo size cap on output, so be careful with commands that print huge amounts (gigabyte logs, recursive find on /, etc.) — pipe through `head` / `tail` / `grep` if you don't actually need everything.",
      inputSchema: z.object({
        command: z.string().min(1).describe("Shell command to execute."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in milliseconds. Default 30000."),
      }),
      execute: async ({ command, timeout_ms }, options) => {
        await ensureWorkspace();
        const timeoutCtl = new AbortController();
        const timer = setTimeout(
          () => timeoutCtl.abort(),
          timeout_ms ?? DEFAULT_TIMEOUT_MS,
        );
        const signal = options?.abortSignal
          ? AbortSignal.any([timeoutCtl.signal, options.abortSignal])
          : timeoutCtl.signal;
        try {
          const proc = Bun.spawn(["bash", "-lc", command], {
            cwd: workspace,
            // Closed stdin so any interactive prompt (sudo password, brew
            // confirmation, ssh-keygen passphrase, etc.) sees EOF and fails
            // immediately instead of hanging forever waiting for input.
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            signal,
          });
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          const exitCode = await proc.exited;
          return {
            exitCode,
            stdout,
            stderr,
          };
        } catch (err) {
          return {
            exitCode: -1,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
          };
        } finally {
          clearTimeout(timer);
        }
      },
    }),

    read: tool({
      description:
        "Read a file. Relative paths resolve against your workspace; absolute paths work anywhere on the host. Returns full file contents (no size cap — be reasonable with truly huge files; for those use `bash sed -n 'A,Bp' <path>` for ranges). If the file is an image (png/jpeg/gif/webp/...), the bytes are attached as a vision part so you can actually see it — useful when an earlier tool result mentioned an image path or you've downloaded one with `bash curl`.",
      inputSchema: z.object({
        path: z.string().min(1).describe("File path. Relative or absolute."),
      }),
      execute: async ({ path }) => {
        await ensureWorkspace();
        try {
          const resolved = resolvePath(path);
          const file = Bun.file(resolved);
          if (!(await file.exists())) {
            return { ok: false, error: `File not found: ${path}` };
          }
          const mediaType = file.type;
          if (mediaType.startsWith("image/")) {
            // Anthropic vision caps tool-result image content at 5MB base64.
            // Base64 ≈ 4/3 of raw bytes, so cap raw at ~3.5MB to stay safe.
            const RAW_IMAGE_LIMIT = 3.5 * 1024 * 1024;
            if (file.size > RAW_IMAGE_LIMIT) {
              const sizeMB = (file.size / 1024 / 1024).toFixed(1);
              return {
                ok: false,
                error: `Image is ${sizeMB}MB — too large for vision (Anthropic caps tool-result images at 5MB base64, ~3.5MB raw). Resize first via bash, then read the smaller copy. Try one of:\n  bash sips -Z 1600 "${resolved}" --out /tmp/small.jpg     # macOS, built-in\n  bash magick "${resolved}" -resize 1600x1600 /tmp/small.jpg  # ImageMagick\n  bash ffmpeg -y -i "${resolved}" -vf scale=1600:-1 /tmp/small.jpg  # ffmpeg\nThen call read on /tmp/small.jpg.`,
              };
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            // Use magic-byte detection over the filename extension so we
            // don't tell Anthropic "this is image/jpeg" while actually
            // shipping PNG bytes (common after a botched `sips -Z` resize).
            const realMime = detectImageMime(bytes) ?? mediaType;
            const data = Buffer.from(bytes).toString("base64");
            return {
              ok: true,
              path,
              kind: "image" as const,
              mediaType: realMime,
              data,
            };
          }
          return {
            ok: true,
            path,
            kind: "text" as const,
            content: await file.text(),
          };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      toModelOutput: ({ output }) => {
        if (
          output &&
          typeof output === "object" &&
          "ok" in output &&
          (output as { ok: unknown }).ok === true &&
          "kind" in output &&
          (output as { kind: unknown }).kind === "image"
        ) {
          const r = output as {
            path: string;
            mediaType: string;
            data: string;
          };
          // image-data with raw base64 + separate mediaType is what
          // Anthropic accepts as `source.type: base64`. The `image-url`
          // path on Anthropic is URL-source and rejects `data:` URLs
          // ("Only HTTPS URLs are supported"). OpenAI's provider auto-
          // wraps image-data into a data URL on its side. xAI/Grok don't
          // accept any image content in tool_result, so we strip these
          // parts upstream for those models — see modelSupportsToolImages.
          return {
            type: "content" as const,
            value: [
              {
                type: "text" as const,
                text: `Read ${r.path} (${r.mediaType})`,
              },
              {
                type: "image-data" as const,
                mediaType: r.mediaType,
                data: r.data,
              },
            ],
          };
        }
        return {
          type: "text" as const,
          value:
            typeof output === "string" ? output : JSON.stringify(output),
        };
      },
    }),

    write: tool({
      description:
        "Write content to a file (overwrites if exists). Relative paths resolve against your workspace; absolute paths work anywhere on the host. Parent directories auto-created. For surgical changes prefer `edit`.",
      inputSchema: z.object({
        path: z.string().min(1).describe("File path. Relative or absolute."),
        content: z.string().describe("Full file contents to write."),
      }),
      execute: async ({ path, content }) => {
        await ensureWorkspace();
        try {
          await Bun.write(resolvePath(path), content);
          return { ok: true, path, bytes: content.length };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),

    edit: tool({
      description:
        "Replace an exact substring in a file. Fails if `old_string` is not unique unless `replace_all` is true. Relative paths resolve against your workspace; absolute paths work anywhere on the host.",
      inputSchema: z.object({
        path: z.string().min(1).describe("File path. Relative or absolute."),
        old_string: z
          .string()
          .min(1)
          .describe("Exact text to replace (must be unique by default)."),
        new_string: z.string().describe("Replacement text."),
        replace_all: z
          .boolean()
          .optional()
          .describe("If true, replace every occurrence. Defaults to false."),
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        await ensureWorkspace();
        try {
          const resolved = resolvePath(path);
          const file = Bun.file(resolved);
          if (!(await file.exists())) {
            return { ok: false, error: `File not found: ${path}` };
          }
          const text = await file.text();
          const occurrences = text.split(old_string).length - 1;
          if (occurrences === 0) {
            return { ok: false, error: "old_string not found in file" };
          }
          if (occurrences > 1 && !replace_all) {
            return {
              ok: false,
              error: `old_string matches ${occurrences} times. Make it unique or set replace_all: true.`,
            };
          }
          const updated = replace_all
            ? text.split(old_string).join(new_string)
            : text.replace(old_string, new_string);
          await Bun.write(resolved, updated);
          return { ok: true, path, replacements: occurrences };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),
  };
}
