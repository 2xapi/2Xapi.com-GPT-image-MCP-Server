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
const DEFAULTS = {
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
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// --------------------------------------------------------------------------- //
// Config persistence (env > file > defaults)                                  //
// --------------------------------------------------------------------------- //
function deepClone(v) {
    return JSON.parse(JSON.stringify(v));
}
function loadConfig() {
    const cfg = deepClone(DEFAULTS);
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
            if (data && typeof data === "object") {
                for (const k of Object.keys(cfg)) {
                    if (k in data) {
                        const v = data[k];
                        if (k === "moderation" && v && typeof v === "object") {
                            cfg.moderation = { ...cfg.moderation, ...v };
                        }
                        else if (typeof v === "string" || typeof v === "boolean") {
                            cfg[k] = v;
                        }
                    }
                }
            }
        }
    }
    catch {
        // Unreadable config file: fall through to defaults + env.
    }
    const envKey = (process.env.IMAGE_API_KEY ?? "").trim();
    if (envKey)
        cfg.api_key = envKey;
    const envBase = (process.env.IMAGE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
    if (envBase)
        cfg.api_base_url = envBase;
    return cfg;
}
function saveConfig(cfg) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}
function maskKey(key) {
    if (!key)
        return "(not set)";
    if (key.length <= 10)
        return key.slice(0, 2) + "***";
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
// --------------------------------------------------------------------------- //
// HTTP helpers                                                                //
// --------------------------------------------------------------------------- //
class ImageAPIError extends Error {
}
async function httpJson(url, apiKey, init = {}, timeoutMs = 180_000) {
    const headers = {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
    };
    let body;
    if (init.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(init.body);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
        resp = await fetch(url, {
            method: init.method ?? (body ? "POST" : "GET"),
            headers,
            body,
            signal: ctrl.signal,
        });
    }
    catch (err) {
        throw new ImageAPIError(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    finally {
        clearTimeout(timer);
    }
    const text = await resp.text();
    if (!resp.ok) {
        throw new ImageAPIError(`Upstream HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new ImageAPIError(`Upstream returned non-JSON: ${text.slice(0, 200)}`);
    }
}
async function moderate(prompt, mod) {
    if (!mod.enabled)
        return;
    const base = mod.api_base_url.replace(/\/+$/, "");
    if (!(base && mod.api_key && mod.model))
        return; // misconfigured -> fail open
    const systemPrompt = mod.prompt ||
        "You are a content moderator for an image generator. Decide whether the " +
            "user's prompt is ALLOWED or DENIED based on typical platform rules: " +
            "deny sexual content involving minors, realistic violence/gore, " +
            "non-consensual sexual content, real-person defamation, hate imagery, " +
            "and other content likely to violate policy. Reply with exactly one line: " +
            "'ALLOW' or 'DENY: <short reason>'.";
    let data;
    try {
        data = await httpJson(`${base}/chat/completions`, mod.api_key, {
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
        }, 30_000);
    }
    catch {
        // Moderation endpoint problem -> fail open so generation still works.
        console.error("[GPT-image] moderation endpoint error (fail-open)");
        return;
    }
    const reply = String(data?.choices?.[0]?.message
        ?.content ?? "").trim();
    const upper = reply.toUpperCase();
    if (upper.startsWith("DENY")) {
        const reason = reply.includes(":") ? reply.slice(reply.indexOf(":") + 1).trim() : "";
        throw new ImageAPIError(reason || "prompt disallowed by moderation");
    }
}
async function download(url, timeoutMs = 60_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: ctrl.signal });
        if (!resp.ok)
            throw new Error(`HTTP ${resp.status}`);
        return Buffer.from(await resp.arrayBuffer());
    }
    finally {
        clearTimeout(timer);
    }
}
// --------------------------------------------------------------------------- //
// Tool implementations                                                        //
// --------------------------------------------------------------------------- //
function getConfigText() {
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
async function generateImage(prompt, opts) {
    if (!prompt || !prompt.trim())
        throw new ImageAPIError("`prompt` must not be empty.");
    const cfg = loadConfig();
    if (!cfg.api_key) {
        throw new ImageAPIError("API key is not set. Set the IMAGE_API_KEY environment variable, " +
            "or use set_config(api_key=...).");
    }
    if (cfg.moderation.enabled)
        await moderate(prompt, cfg.moderation);
    const payload = {
        model: opts.model || cfg.model,
        prompt,
        size: opts.size || cfg.size,
        n: Math.max(1, Math.min(Math.trunc(opts.n ?? 1), 10)),
        response_format: "url",
    };
    if (opts.quality)
        payload.quality = opts.quality;
    const result = (await httpJson(`${cfg.api_base_url.replace(/\/+$/, "")}/images/generations`, cfg.api_key, { method: "POST", body: payload }));
    const items = result?.data ?? [];
    if (!items.length)
        throw new ImageAPIError(`Upstream returned no images: ${JSON.stringify(result).slice(0, 300)}`);
    const lines = [`Generated ${items.length} image(s) | model='${payload.model}' size='${payload.size}'.`];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        lines.push(`\n[Image ${i + 1}]`);
        if (item.url)
            lines.push(`image_url: ${item.url}`);
        if (item.revised_prompt)
            lines.push(`revised_prompt: ${item.revised_prompt}`);
        if (opts.save && item.url && cfg.save_dir) {
            try {
                const data = await download(item.url);
                const slug = prompt.slice(0, 30).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "image";
                fs.mkdirSync(cfg.save_dir, { recursive: true });
                const p = path.join(cfg.save_dir, `${Date.now()}_${slug}.png`);
                fs.writeFileSync(p, data);
                lines.push(`saved_to: ${p}`);
            }
            catch (err) {
                lines.push(`saved_to: (failed: ${err instanceof Error ? err.message : String(err)})`);
            }
        }
        else if (item.b64_json && !item.url) {
            lines.push(`b64_json_length: ${item.b64_json.length}`);
        }
    }
    if (result.usage)
        lines.push(`\nusage: ${JSON.stringify(result.usage)}`);
    return lines.join("\n");
}
async function listImageModels() {
    const cfg = loadConfig();
    if (!cfg.api_key) {
        throw new ImageAPIError("API key is not set. Set the IMAGE_API_KEY environment variable, " +
            "or use set_config(api_key=...).");
    }
    const base = cfg.api_base_url.replace(/\/+$/, "");
    const data = (await httpJson(`${base}/models`, cfg.api_key, {}, 30_000));
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
function updateConfig(updates) {
    const cfg = loadConfig();
    for (const [k, v] of Object.entries(updates)) {
        if (v === undefined)
            continue;
        if (k === "api_base_url")
            cfg.api_base_url = String(v).replace(/\/+$/, "") || DEFAULTS.api_base_url;
        else
            cfg[k] = v;
    }
    saveConfig(cfg);
    const changed = Object.keys(updates).filter((k) => updates[k] !== undefined);
    return `Updated: ${changed.join(", ")}. Use get_config to review.`;
}
function updateModeration(updates) {
    const cfg = loadConfig();
    cfg.moderation = { ...cfg.moderation, ...updates };
    saveConfig(cfg);
    const changed = Object.keys(updates).filter((k) => updates[k] !== undefined);
    return `Updated moderation: ${changed.join(", ")}.`;
}
// --------------------------------------------------------------------------- //
// MCP server                                                                  //
// --------------------------------------------------------------------------- //
const server = new McpServer({ name: "GPT-image", version: "0.1.0" });
server.registerTool("generate_image", {
    title: "Generate image",
    description: "Generate image(s) from a text prompt using the configured OpenAI-compatible " +
        "image API. Returns image URL(s) and metadata. Optionally saves locally.",
    inputSchema: z.object({
        prompt: z.string().describe("Text description of the image to create."),
        model: z.string().optional().describe("Model id; defaults to config model (e.g. gpt-image-2)."),
        size: z.string().optional().describe("e.g. 1024x1024 / 1024x1536 / 1536x1024."),
        quality: z.enum(["low", "medium", "high"]).optional().describe("Optional quality hint."),
        n: z.number().int().min(1).max(10).optional().describe("How many images (default 1)."),
        save: z.boolean().optional().describe("Also download each image to config save_dir."),
    }),
}, async (args) => {
    try {
        const result = await generateImage(String(args.prompt), {
            model: args.model === undefined ? undefined : String(args.model),
            size: args.size === undefined ? undefined : String(args.size),
            quality: args.quality === undefined ? undefined : String(args.quality),
            n: args.n === undefined ? undefined : Number(args.n),
            save: args.save === undefined ? undefined : Boolean(args.save),
        });
        return { content: [{ type: "text", text: result }] };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
server.registerTool("get_config", {
    title: "Show GPT-image config",
    description: "Show the current GPT-image configuration: API endpoint, model, default size, " +
        "save directory and moderation settings (API keys masked).",
    inputSchema: z.object({}),
}, async () => ({ content: [{ type: "text", text: getConfigText() }] }));
server.registerTool("set_config", {
    title: "Update GPT-image config",
    description: "Update one or more GPT-image settings and persist them to the config file. " +
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
}, async (args) => {
    try {
        const result = updateConfig({
            api_base_url: args.api_base_url === undefined ? undefined : String(args.api_base_url),
            api_key: args.api_key === undefined ? undefined : String(args.api_key),
            model: args.model === undefined ? undefined : String(args.model),
            size: args.size === undefined ? undefined : String(args.size),
            save_dir: args.save_dir === undefined ? undefined : String(args.save_dir),
        });
        return { content: [{ type: "text", text: result }] };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
server.registerTool("set_moderation", {
    title: "Configure AI moderation gate",
    description: "Configure the pre-generation moderation gate. When enabled, every prompt is " +
        "sent to a moderation model (OpenAI-compatible chat endpoint) before generation; " +
        "DENY rejects the prompt. Fails open if the moderation service is unreachable.",
    inputSchema: z.object({
        enabled: z.boolean().optional().describe("Turn the gate on (true) or off (false)."),
        api_base_url: z.string().optional().describe("Moderation chat endpoint root (to /v1)."),
        api_key: z.string().optional().describe("Bearer token for the moderation endpoint."),
        model: z.string().optional().describe("Classifier model id."),
        prompt: z.string().optional().describe("System prompt describing forbidden content ('' = built-in)."),
    }),
}, async (args) => {
    try {
        const updates = {};
        if (args.enabled !== undefined)
            updates.enabled = Boolean(args.enabled);
        if (args.api_base_url !== undefined)
            updates.api_base_url = String(args.api_base_url);
        if (args.api_key !== undefined)
            updates.api_key = String(args.api_key);
        if (args.model !== undefined)
            updates.model = String(args.model);
        if (args.prompt !== undefined)
            updates.prompt = String(args.prompt);
        const result = updateModeration(updates);
        return { content: [{ type: "text", text: result }] };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
server.registerTool("list_image_models", {
    title: "List backend models",
    description: "List the models exposed by the configured image backend (GET /models).",
    inputSchema: z.object({}),
}, async () => {
    try {
        const result = await listImageModels();
        return { content: [{ type: "text", text: result }] };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
