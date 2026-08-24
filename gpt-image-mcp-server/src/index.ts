#!/usr/bin/env node
/**
 * GPT-image MCP Server (npm edition)
 *
 * Text-to-image generation via an OpenAI-compatible images API, exposed as MCP
 * tools. One-command install for end users:
 *
 *   npx gpt-image-mcp-server
 *
 * The caller's own API key is passed through the IMAGE_API_KEY environment
 * variable (same pattern as the BigModel/Zhipu vision MCP server), so usage is
 * billed against each user's own key. IMAGE_API_BASE_URL optionally overrides
 * the endpoint (defaults to the built-in provider).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

// --------------------------------------------------------------------------- //
// Defaults & config                                                           //
// --------------------------------------------------------------------------- //

interface ModerationConfig {
  enabled: boolean;
  api_base_url: string;
  api_key: string;
  model: string;
  prompt: string;
}

interface AppConfig {
  api_base_url: string;
  api_key: string;
  model: string;
  size: string;
  save_dir: string;
  moderation: ModerationConfig;
}

const DEFAULTS: AppConfig = {
  api_base_url: "https://2xa.cc.cd/v1",
  api_key: "",
  model: "gpt-image-2",
  size: "1024x1024",
  save_dir: "",
  moderation: {
    enabled: false,
    api_base_url: "",
    api_key: "",
    model: "",
    prompt: "",
  },
};

const CONFIG_PATH = process.env.IMAGE_CONFIG_PATH
  ? path.resolve(process.env.IMAGE_CONFIG_PATH)
  : path.join(os.homedir(), ".gpt-image-mcp", "config.json");

// Input image guards: real-format validation via sharp, 50 MB hard limit, and
// auto-downscale of oversized uploads (>4 MB or >1024 px) before multipart POST.
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const SOFT_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_EDGE_PX = 1024;
const EXT_BY_FORMAT: Record<string, string> = {
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp",
  gif: ".gif",
};
const MIME_BY_FORMAT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// --------------------------------------------------------------------------- //
// Config persistence (env > file > defaults)                                  //
// --------------------------------------------------------------------------- //

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function loadConfig(): AppConfig {
  const cfg = deepClone(DEFAULTS);
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      if (data && typeof data === "object") {
        for (const k of Object.keys(cfg)) {
          if (k in data) {
            const v = (data as Record<string, unknown>)[k];
            if (k === "moderation" && v && typeof v === "object") {
              cfg.moderation = { ...cfg.moderation, ...(v as ModerationConfig) };
            } else if (typeof v === "string" || typeof v === "boolean") {
              (cfg as unknown as Record<string, unknown>)[k] = v;
            }
          }
        }
      }
    }
  } catch {
    // Unreadable config file: fall through to defaults + env.
  }
  const envKey = (process.env.IMAGE_API_KEY ?? "").trim();
  if (envKey) cfg.api_key = envKey;
  const envBase = (process.env.IMAGE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (envBase) cfg.api_base_url = envBase;
  return cfg;
}

function saveConfig(cfg: AppConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

function maskKey(key: string): string {
  if (!key) return "(not set)";
  if (key.length <= 10) return key.slice(0, 2) + "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

// --------------------------------------------------------------------------- //
// Path allowlist: local image inputs must live under home or IMAGE_ALLOWED_ROOTS
// --------------------------------------------------------------------------- //
function allowedRoots(): string[] {
  const home = path.resolve(os.homedir());
  const extra = (process.env.IMAGE_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
  return [...new Set([home, ...extra])];
}

function isWithin(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertAllowedPath(p: string): void {
  const resolved = path.resolve(p);
  if (!allowedRoots().some((root) => isWithin(resolved, root))) {
    throw new ImageAPIError(
      `Path ${p} is outside the allowed roots (home + IMAGE_ALLOWED_ROOTS). ` +
        `Add the directory to IMAGE_ALLOWED_ROOTS to read it.`,
    );
  }
}

// --------------------------------------------------------------------------- //
// HTTP helpers                                                                //
// --------------------------------------------------------------------------- //

class ImageAPIError extends Error {}

async function httpJson(
  url: string,
  apiKey: string,
  init: { method?: string; body?: unknown } = {},
  timeoutMs = 180_000,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  let body: string | FormData | undefined;
  if (init.body instanceof FormData) {
    // Multipart upload (images/edits): fetch sets Content-Type + boundary itself.
    body = init.body;
  } else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: init.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new ImageAPIError(
      `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new ImageAPIError(`Upstream HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ImageAPIError(`Upstream returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function moderate(prompt: string, mod: ModerationConfig): Promise<void> {
  if (!mod.enabled) return;
  const base = mod.api_base_url.replace(/\/+$/, "");
  if (!(base && mod.api_key && mod.model)) return; // misconfigured -> fail open

  const systemPrompt =
    mod.prompt ||
    "You are a content moderator for an image generator. Decide whether the " +
      "user's prompt is ALLOWED or DENIED based on typical platform rules: " +
      "deny sexual content involving minors, realistic violence/gore, " +
      "non-consensual sexual content, real-person defamation, hate imagery, " +
      "and other content likely to violate policy. Reply with exactly one line: " +
      "'ALLOW' or 'DENY: <short reason>'.";

  let data: unknown;
  try {
    data = await httpJson(
      `${base}/chat/completions`,
      mod.api_key,
      {
        method: "POST",
        body: {
          model: mod.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: 100,
        },
      },
      30_000,
    );
  } catch {
    // Moderation endpoint problem -> fail open so generation still works.
    console.error("[GPT-image] moderation endpoint error (fail-open)");
    return;
  }

  const reply = String(
    (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message
      ?.content ?? "",
  ).trim();
  const upper = reply.toUpperCase();
  if (upper.startsWith("DENY")) {
    const reason = reply.includes(":") ? reply.slice(reply.indexOf(":") + 1).trim() : "";
    throw new ImageAPIError(reason || "prompt disallowed by moderation");
  }
}

async function download(url: string, timeoutMs = 60_000): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------------------- //
// Image input resolution (for edit_image)                                     //
// --------------------------------------------------------------------------- //

interface ResolvedImage {
  buffer: Buffer;
  filename: string;
  mime: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function mimeForName(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? "image/png";
}

/** ASCII-safe filename stem, plus a known extension when one is provided. */
function asciiStem(name: string, index: number): string {
  const ext = path.extname(name).toLowerCase();
  const stem =
    path.basename(name, ext).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    `image${index + 1}`;
  return stem.slice(0, 40);
}

function asciiSafeName(name: string, index: number): string {
  const ext = path.extname(name).toLowerCase();
  const safeExt = MIME_BY_EXT[ext] ? ext : ".png";
  return `${asciiStem(name, index)}${safeExt}`;
}

const RAW_BASE64_RE = /^[A-Za-z0-9+/=\r\n]+$/;

/**
 * Turn an image reference into raw bytes + upload metadata. Accepted forms:
 * local file path, http(s) URL, `data:image/...;base64,...` URI, raw base64.
 */
async function resolveImageInput(ref: string, index: number): Promise<ResolvedImage> {
  const s = ref.trim();
  if (!s) throw new ImageAPIError("Image reference must not be empty.");

  const dataUri = s.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
  if (dataUri) {
    const mime = dataUri[1].toLowerCase();
    const buffer = Buffer.from(dataUri[2], "base64");
    if (!buffer.length) throw new ImageAPIError("data: URI contains no image data.");
    return { buffer, filename: `image${index + 1}${EXT_BY_MIME[mime] ?? ".png"}`, mime };
  }

  if (/^https?:\/\//i.test(s)) {
    let buffer: Buffer;
    try {
      buffer = await download(s);
    } catch (err) {
      throw new ImageAPIError(
        `Could not download image ${s}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!buffer.length) throw new ImageAPIError(`Image URL returned no data: ${s}`);
    const name = decodeURIComponent(new URL(s).pathname.split("/").pop() ?? "") || `image${index + 1}`;
    return { buffer, filename: asciiSafeName(name, index), mime: mimeForName(name) };
  }

  if (fs.existsSync(s) && fs.statSync(s).isFile()) {
    assertAllowedPath(s);
    const buffer = fs.readFileSync(s);
    if (!buffer.length) throw new ImageAPIError(`Image file is empty: ${s}`);
    return { buffer, filename: asciiSafeName(path.basename(s), index), mime: mimeForName(s) };
  }

  if (s.length >= 64 && RAW_BASE64_RE.test(s)) {
    const buffer = Buffer.from(s, "base64");
    if (buffer.length) return { buffer, filename: `image${index + 1}.png`, mime: "image/png" };
  }

  throw new ImageAPIError(
    `Unrecognized image input: "${s.slice(0, 60)}${s.length > 60 ? "..." : ""}". ` +
      "Provide a local file path, an http(s) URL, a data: URI, or raw base64.",
  );
}

function saveImageFile(data: Buffer, prompt: string, saveDir: string): string {
  const slug = prompt.slice(0, 30).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "image";
  fs.mkdirSync(saveDir, { recursive: true });
  const p = path.join(saveDir, `${Date.now()}_${slug}.png`);
  fs.writeFileSync(p, data);
  return p;
}

/**
 * Validate + normalize an input image before upload: 50 MB hard cap, real-format
 * sniffing via sharp (rejects non-images, fixes filename/mime), and auto-downscale
 * of oversized inputs (>4 MB or any edge >1024 px) to keep uploads under the
 * upstream's practical limits.
 */
async function normalizeImage(img: ResolvedImage, label: string): Promise<ResolvedImage> {
  if (img.buffer.length > MAX_INPUT_BYTES) {
    throw new ImageAPIError(`${label} exceeds the 50 MB upload limit.`);
  }
  interface ImageMeta {
    format?: string;
    width?: number;
    height?: number;
  }
  let meta: ImageMeta;
  try {
    meta = (await sharp(img.buffer, { animated: true }).metadata()) as ImageMeta;
  } catch {
    throw new ImageAPIError(`${label} is not a valid image file.`);
  }
  const fmt = meta.format ?? "";
  if (!MIME_BY_FORMAT[fmt]) {
    throw new ImageAPIError(`${label} has unsupported image format${fmt ? ` (${fmt})` : ""}.`);
  }
  const wide = meta.width ?? 0;
  const tall = meta.height ?? 0;
  if (img.buffer.length > SOFT_INPUT_BYTES || wide > MAX_EDGE_PX || tall > MAX_EDGE_PX) {
    const resized = await sharp(img.buffer)
      .rotate()
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return {
      buffer: resized,
      filename: `${asciiStem(img.filename, 0)}.png`,
      mime: "image/png",
    };
  }
  // Align filename extension with the real format (a "cat.jpg" that is actually
  // a PNG gets uploaded as cat.png).
  const ext = EXT_BY_FORMAT[fmt];
  return { buffer: img.buffer, filename: `${asciiStem(img.filename, 0)}${ext}`, mime: MIME_BY_FORMAT[fmt] };
}

interface FormatResult {
  report: string;
  buffers: Buffer[];
  savedPaths: string[];
  usage: unknown;
}

/** Render an images API response (generations or edits) into the tool report. */
async function formatImagesResult(
  result: unknown,
  ctx: { prefix: string; model: string; size: string; prompt: string; save: boolean; saveDir: string },
): Promise<FormatResult> {
  const typed = result as {
    data?: { url?: string; revised_prompt?: string; b64_json?: string }[];
    usage?: unknown;
  };
  const items = typed?.data ?? [];
  if (!items.length) {
    throw new ImageAPIError(`Upstream returned no images: ${JSON.stringify(result).slice(0, 300)}`);
  }
  const lines = [`${ctx.prefix} -> ${items.length} image(s) | model='${ctx.model}' size='${ctx.size}'.`];
  const buffers: Buffer[] = [];
  const savedPaths: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    lines.push(`\n[Image ${i + 1}]`);
    if (item.url) lines.push(`image_url: ${item.url}`);
    if (item.revised_prompt) lines.push(`revised_prompt: ${item.revised_prompt}`);
    let data: Buffer | null = null;
    if (item.url) {
      try {
        data = await download(item.url);
      } catch (err) {
        lines.push(`download: (failed: ${err instanceof Error ? err.message : String(err)})`);
      }
    } else if (item.b64_json) {
      lines.push(`b64_json_length: ${item.b64_json.length}`);
      data = Buffer.from(item.b64_json, "base64");
    }
    if (data) {
      buffers.push(data);
      if (ctx.save && ctx.saveDir) {
        try {
          const p = saveImageFile(data, ctx.prompt, ctx.saveDir);
          lines.push(`saved_to: ${p}`);
          savedPaths.push(p);
        } catch (err) {
          lines.push(`saved_to: (failed: ${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
  }
  if (typed.usage) lines.push(`\nusage: ${JSON.stringify(typed.usage)}`);
  return { report: lines.join("\n"), buffers, savedPaths, usage: typed.usage };
}

/** Inline JPEG previews (512px) as MCP image content blocks. */
async function previewBlocks(buffers: Buffer[], count: number): Promise<{ type: "image"; data: string; mimeType: string }[]> {
  const blocks: { type: "image"; data: string; mimeType: string }[] = [];
  for (const buf of buffers.slice(0, count)) {
    try {
      const jpeg = await sharp(buf)
        .rotate()
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      blocks.push({ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
    } catch {
      // Skip previews that fail to decode; the text report still carries URLs.
    }
  }
  return blocks;
}

/** Strip the API key / bearer tokens from error text before returning to clients. */
function redactError(err: unknown, cfg: AppConfig): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (cfg.api_key) msg = msg.split(cfg.api_key).join("<redacted>");
  msg = msg.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>");
  return msg.slice(0, 2000);
}

// --------------------------------------------------------------------------- //
// Tool implementations                                                        //
// --------------------------------------------------------------------------- //

function getConfigText(): string {
  const cfg = loadConfig();
  const mod = cfg.moderation;
  const lines = [
    `config_file: ${CONFIG_PATH}`,
    `api_base_url: ${cfg.api_base_url}`,
    `api_key: ${maskKey(cfg.api_key)}`,
    `model: ${cfg.model}`,
    `size: ${cfg.size}`,
    `save_dir: ${cfg.save_dir ? cfg.save_dir : "(disabled)"}`,
    "",
    `moderation.enabled: ${mod.enabled}`,
    `moderation.api_base_url: ${mod.api_base_url || "(not set)"}`,
    `moderation.api_key: ${maskKey(mod.api_key)}`,
    `moderation.model: ${mod.model || "(not set)"}`,
    `moderation.prompt: ${(mod.prompt || "(default)").slice(0, 80)}`,
  ];
  return lines.join("\n");
}

async function generateImage(
  prompt: string,
  opts: {
    model?: string;
    size?: string;
    quality?: string;
    n?: number;
    save?: boolean;
  },
): Promise<FormatResult> {
  if (!prompt || !prompt.trim()) throw new ImageAPIError("`prompt` must not be empty.");
  const cfg = loadConfig();
  if (!cfg.api_key) {
    throw new ImageAPIError(
      "API key is not set. Set the IMAGE_API_KEY environment variable, " +
        "or use set_config(api_key=...).",
    );
  }
  if (cfg.moderation.enabled) await moderate(prompt, cfg.moderation);

  const payload: Record<string, unknown> = {
    model: opts.model || cfg.model,
    prompt,
    size: opts.size || cfg.size,
    n: Math.max(1, Math.min(Math.trunc(opts.n ?? 1), 10)),
    response_format: "url",
  };
  if (opts.quality) payload.quality = opts.quality;

  const result = await httpJson(
    `${cfg.api_base_url.replace(/\/+$/, "")}/images/generations`,
    cfg.api_key,
    { method: "POST", body: payload },
  );

  return formatImagesResult(result, {
    prefix: "Generated",
    model: String(payload.model),
    size: String(payload.size),
    prompt,
    save: Boolean(opts.save),
    saveDir: cfg.save_dir,
  });
}

/**
 * Image + text -> image (img2img). Uploads the input images (and optional mask)
 * to the OpenAI-compatible /images/edits endpoint as multipart form data.
 */
async function editImage(
  images: string[],
  prompt: string,
  opts: {
    model?: string;
    size?: string;
    quality?: string;
    n?: number;
    save?: boolean;
    mask?: string;
  },
): Promise<FormatResult> {
  if (!prompt || !prompt.trim()) throw new ImageAPIError("`prompt` must not be empty.");
  const refs = images.map((x) => String(x).trim()).filter(Boolean);
  if (!refs.length) {
    throw new ImageAPIError("`images` must contain at least one image reference.");
  }
  if (refs.length > 10) throw new ImageAPIError("`images` supports at most 10 images.");

  const cfg = loadConfig();
  if (!cfg.api_key) {
    throw new ImageAPIError(
      "API key is not set. Set the IMAGE_API_KEY environment variable, " +
        "or use set_config(api_key=...).",
    );
  }
  if (cfg.moderation.enabled) await moderate(prompt, cfg.moderation);

  const files = await Promise.all(
    refs.map((ref, i) => resolveImageInput(ref, i).then((img) => normalizeImage(img, `input image ${i + 1}`))),
  );

  const model = opts.model || cfg.model;
  const size = opts.size || cfg.size;
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("n", String(Math.max(1, Math.min(Math.trunc(opts.n ?? 1), 10))));
  form.append("response_format", "url");
  if (opts.quality) form.append("quality", opts.quality);
  // OpenAI convention: single input uses "image", multiple inputs use "image[]".
  const field = files.length === 1 ? "image" : "image[]";
  for (const f of files) {
    form.append(field, new Blob([new Uint8Array(f.buffer)], { type: f.mime }), f.filename);
  }
  if (opts.mask) {
    const maskRef = String(opts.mask).trim();
    if (!maskRef) throw new ImageAPIError("`mask` must not be empty.");
    const mask = await resolveImageInput(maskRef, 0).then((img) => normalizeImage(img, "mask"));
    form.append("mask", new Blob([new Uint8Array(mask.buffer)], { type: mask.mime }), mask.filename);
  }

  const result = await httpJson(
    `${cfg.api_base_url.replace(/\/+$/, "")}/images/edits`,
    cfg.api_key,
    { method: "POST", body: form },
  );

  return formatImagesResult(result, {
    prefix:
      `Edited ${files.length} input image(s)` +
      (opts.mask ? " + mask" : "") +
      ` (inputs: ${refs.map((r) => (r.length > 50 ? `${r.slice(0, 50)}...` : r)).join(", ")})`,
    model,
    size,
    prompt,
    save: Boolean(opts.save),
    saveDir: cfg.save_dir,
  });
}

async function listImageModels(): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    throw new ImageAPIError(
      "API key is not set. Set the IMAGE_API_KEY environment variable, " +
        "or use set_config(api_key=...).",
    );
  }
  const base = cfg.api_base_url.replace(/\/+$/, "");
  const data = (await httpJson(`${base}/models`, cfg.api_key, {}, 30_000)) as {
    data?: { id?: string; display_name?: string; owned_by?: string }[];
  };
  const models = data?.data ?? [];
  const hints = new Set(["gpt-image-2", "dall-e-3", "dall-e-2", "stable-diffusion"]);
  const lines = [`Backend ${base} exposes ${models.length} model(s):`];
  for (const m of models) {
    const mid = m.id ?? "?";
    const flag = hints.has(mid) || mid.toLowerCase().includes("image") ? " [image]" : "";
    const title = m.display_name || m.owned_by || "";
    lines.push(`  - ${mid}${flag}${title ? `  (${title})` : ""}`);
  }
  return lines.join("\n");
}

function updateConfig(updates: Partial<Omit<AppConfig, "moderation">>): string {
  const cfg = loadConfig();
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    if (k === "api_base_url") cfg.api_base_url = String(v).replace(/\/+$/, "") || DEFAULTS.api_base_url;
    else (cfg as unknown as Record<string, unknown>)[k] = v;
  }
  saveConfig(cfg);
  const changed = Object.keys(updates).filter((k) => updates[k as keyof typeof updates] !== undefined);
  return `Updated: ${changed.join(", ")}. Use get_config to review.`;
}

function updateModeration(updates: Partial<ModerationConfig>): string {
  const cfg = loadConfig();
  cfg.moderation = { ...cfg.moderation, ...updates };
  saveConfig(cfg);
  const changed = Object.keys(updates).filter((k) => updates[k as keyof ModerationConfig] !== undefined);
  return `Updated moderation: ${changed.join(", ")}.`;
}

// --------------------------------------------------------------------------- //
// MCP server                                                                  //
// --------------------------------------------------------------------------- //

const server = new McpServer({ name: "GPT-image", version: "0.3.1" });

server.registerTool(
  "generate_image",
  {
    title: "Generate image",
    description:
      "Generate image(s) from a text prompt using the configured OpenAI-compatible " +
      "image API. Returns image URL(s) and metadata. Optionally saves locally.",
    inputSchema: z.object({
      prompt: z.string().describe("Text description of the image to create."),
      model: z.string().optional().describe("Model id; defaults to config model (e.g. gpt-image-2)."),
      size: z.string().optional().describe("e.g. 1024x1024 / 1024x1536 / 1536x1024."),
      quality: z.enum(["low", "medium", "high"]).optional().describe("Optional quality hint."),
      n: z.number().int().min(1).max(10).optional().describe("How many images (default 1)."),
      save: z.boolean().optional().describe("Also download each image to config save_dir."),
      include_preview: z.boolean().optional().describe(
        "Return inline JPEG previews (default false; enable only if your client renders MCP image blocks — some Responses-streaming clients fail on them).",
      ),
      preview_count: z.number().int().min(0).max(4).optional().describe("How many previews (default 1)."),
    }),
  },
  async (args: Record<string, unknown>) => {
    try {
      const includePreview = args.include_preview === undefined ? false : Boolean(args.include_preview);
      const previewCount =
        args.preview_count === undefined ? 1 : Math.max(0, Math.min(Math.trunc(Number(args.preview_count)), 4));
      const result = await generateImage(String(args.prompt), {
        model: args.model === undefined ? undefined : String(args.model),
        size: args.size === undefined ? undefined : String(args.size),
        quality: args.quality === undefined ? undefined : String(args.quality),
        n: args.n === undefined ? undefined : Number(args.n),
        save: args.save === undefined ? undefined : Boolean(args.save),
      });
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: result.report },
      ];
      if (includePreview) content.push(...(await previewBlocks(result.buffers, previewCount)));
      return {
        content,
        structuredContent: {
          ok: true,
          kind: "generate",
          files: result.savedPaths.map((p) => ({ path: p, uri: pathToFileURL(p).href })),
          usage: result.usage ?? null,
        },
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${redactError(err, loadConfig())}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "edit_image",
  {
    title: "Edit image(s) (img2img)",
    description:
      "Edit, transform, combine or extend one or more input images following a text " +
      "prompt (image + text to image, aka img2img / 图生图) via the configured " +
      "OpenAI-compatible images/edits API. Each image reference can be a local file " +
      "path, an http(s) URL, a data: URI, or raw base64. Returns the edited image " +
      "URL(s) and metadata; optionally saves locally.",
    inputSchema: z.object({
      images: z
        .union([z.string(), z.array(z.string()).min(1).max(10)])
        .describe(
          "1-10 input image references: local file path, http(s) URL, data: URI or " +
            "raw base64. A single string is also accepted.",
        ),
      prompt: z.string().describe("What to change or how to transform the image(s)."),
      mask: z.string().optional().describe(
        "Optional mask image (local path / URL / data URI / base64) marking the " +
          "region to regenerate; applies to the first input image.",
      ),
      model: z.string().optional().describe("Model id; defaults to config model (e.g. gpt-image-2)."),
      size: z.string().optional().describe("e.g. 1024x1024 / 1024x1536 / 1536x1024."),
      quality: z.enum(["low", "medium", "high"]).optional().describe("Optional quality hint."),
      n: z.number().int().min(1).max(10).optional().describe("How many images (default 1)."),
      save: z.boolean().optional().describe("Also download each image to config save_dir."),
      include_preview: z.boolean().optional().describe(
        "Return inline JPEG previews (default false; enable only if your client renders MCP image blocks — some Responses-streaming clients fail on them).",
      ),
      preview_count: z.number().int().min(0).max(4).optional().describe("How many previews (default 1)."),
    }),
  },
  async (args: Record<string, unknown>) => {
    try {
      const includePreview = args.include_preview === undefined ? false : Boolean(args.include_preview);
      const previewCount =
        args.preview_count === undefined ? 1 : Math.max(0, Math.min(Math.trunc(Number(args.preview_count)), 4));
      const raw = args.images;
      const images = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x));
      const result = await editImage(images, String(args.prompt), {
        model: args.model === undefined ? undefined : String(args.model),
        size: args.size === undefined ? undefined : String(args.size),
        quality: args.quality === undefined ? undefined : String(args.quality),
        n: args.n === undefined ? undefined : Number(args.n),
        save: args.save === undefined ? undefined : Boolean(args.save),
        mask: args.mask === undefined ? undefined : String(args.mask),
      });
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: result.report },
      ];
      if (includePreview) content.push(...(await previewBlocks(result.buffers, previewCount)));
      return {
        content,
        structuredContent: {
          ok: true,
          kind: "edit",
          files: result.savedPaths.map((p) => ({ path: p, uri: pathToFileURL(p).href })),
          usage: result.usage ?? null,
        },
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${redactError(err, loadConfig())}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_config",
  {
    title: "Show GPT-image config",
    description:
      "Show the current GPT-image configuration: API endpoint, model, default size, " +
      "save directory and moderation settings (API keys masked).",
    inputSchema: z.object({}),
  },
  async () => ({ content: [{ type: "text" as const, text: getConfigText() }] }),
);

server.registerTool(
  "set_config",
  {
    title: "Update GPT-image config",
    description:
      "Update one or more GPT-image settings and persist them to the config file. " +
      "Any field left null/omitted is unchanged. Changes take effect immediately. " +
      "Fields: api_base_url, api_key, model, size, save_dir. Note: IMAGE_API_KEY / " +
      "IMAGE_API_BASE_URL environment variables always take precedence.",
    inputSchema: z.object({
      api_base_url: z.string().optional().describe("OpenAI-compatible API root, to /v1."),
      api_key: z.string().optional().describe("Bearer token for the API. Empty string clears it."),
      model: z.string().optional().describe("Default model id."),
      size: z.string().optional().describe("Default image size."),
      save_dir: z.string().optional().describe("Directory to auto-save images ('' disables)."),
    }),
  },
  async (args: Record<string, unknown>) => {
    try {
      const result = updateConfig({
        api_base_url: args.api_base_url === undefined ? undefined : String(args.api_base_url),
        api_key: args.api_key === undefined ? undefined : String(args.api_key),
        model: args.model === undefined ? undefined : String(args.model),
        size: args.size === undefined ? undefined : String(args.size),
        save_dir: args.save_dir === undefined ? undefined : String(args.save_dir),
      });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "set_moderation",
  {
    title: "Configure AI moderation gate",
    description:
      "Configure the pre-generation moderation gate. When enabled, every prompt is " +
      "sent to a moderation model (OpenAI-compatible chat endpoint) before generation; " +
      "DENY rejects the prompt. Fails open if the moderation service is unreachable.",
    inputSchema: z.object({
      enabled: z.boolean().optional().describe("Turn the gate on (true) or off (false)."),
      api_base_url: z.string().optional().describe("Moderation chat endpoint root (to /v1)."),
      api_key: z.string().optional().describe("Bearer token for the moderation endpoint."),
      model: z.string().optional().describe("Classifier model id."),
      prompt: z.string().optional().describe("System prompt describing forbidden content ('' = built-in)."),
    }),
  },
  async (args: Record<string, unknown>) => {
    try {
      const updates: Partial<ModerationConfig> = {};
      if (args.enabled !== undefined) updates.enabled = Boolean(args.enabled);
      if (args.api_base_url !== undefined) updates.api_base_url = String(args.api_base_url);
      if (args.api_key !== undefined) updates.api_key = String(args.api_key);
      if (args.model !== undefined) updates.model = String(args.model);
      if (args.prompt !== undefined) updates.prompt = String(args.prompt);
      const result = updateModeration(updates);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "list_image_models",
  {
    title: "List backend models",
    description: "List the models exposed by the configured image backend (GET /models).",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const result = await listImageModels();
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
