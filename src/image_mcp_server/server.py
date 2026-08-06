"""MCP server exposing an OpenAI-compatible text-to-image API as MCP tools.

Server name: **GPT-image**.

The backend endpoint, API key, model and other defaults live in a JSON
config file so they can be edited by hand *or* changed at runtime through
the ``get_config`` / ``set_config`` tools — no restart needed.

Config file location (first match wins):
  1. ``$IMAGE_CONFIG_PATH``  — explicit absolute path
  2. ``<package_dir>/config.json`` — next to the installed server

Config schema (config.json):

    {
      "api_base_url": "https://2xa.cc.cd/v1",
      "api_key":      "sk-...",
      "model":        "gpt-image-2",
      "size":         "1024x1024",
      "save_dir":     ""
    }

Tools:
  * ``generate_image``   — generate image(s) from a text prompt
  * ``get_config``       — show current config (API key masked)
  * ``set_config``       — update one or more config fields, persisted to disk
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from mcp.server.mcpserver import MCPServer

# --------------------------------------------------------------------------- #
# Built-in defaults (used when a field is missing from config.json)           #
# --------------------------------------------------------------------------- #
DEFAULTS: dict[str, Any] = {
    "api_base_url": "https://2xa.cc.cd/v1",
    "api_key": "",
    "model": "gpt-image-2",
    "size": "1024x1024",
    "save_dir": "",
    # Pre-generation moderation gate. When enabled, every prompt is sent to a
    # classification model BEFORE the image API is called; prompts the model
    # judges as disallowed are rejected, which keeps the request (and the
    # account) away from content that could trip upstream risk controls.
    "moderation": {
        "enabled": False,
        "api_base_url": "",     # OpenAI-compatible chat endpoint, e.g. http://host:8080/v1
        "api_key": "",          # Bearer token for the moderation endpoint
        "model": "",            # classifier model id, e.g. deepseek-v4-flash
        "prompt": "",           # system prompt describing what is forbidden
    },
}

# Browser-like UA — the backend's Cloudflare front blocks Python-urllib's
# default UA (error 1010 browser_signature_banned).
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# Known image-capable model ids, for flagging in list output.
_KNOWN_IMAGE_MODEL_HINTS = {"gpt-image-2", "dall-e-3", "dall-e-2", "stable-diffusion"}

# Where the config file lives.
_CONFIG_PATH = Path(os.environ.get("IMAGE_CONFIG_PATH") or (Path(__file__).resolve().parent / "config.json"))

# Serialize config read/write — MCP may call tools concurrently.
_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# Config persistence                                                          #
# --------------------------------------------------------------------------- #
class ConfigError(RuntimeError):
    """Raised on config read/write problems."""


def _load_config() -> dict[str, Any]:
    """Return the current config, merged over DEFAULTS (one level deep).

    Environment variables override the file so that one-command installs can
    pass the user's own API key without editing any file (same pattern as the
    BigModel/Zhipu vision MCP server):
      * IMAGE_API_KEY        — bearer token for the image API
      * IMAGE_API_BASE_URL   — optional override for the API root (to /v1)
    """
    cfg: dict[str, Any] = json.loads(json.dumps(DEFAULTS))  # deep copy of defaults
    if _CONFIG_PATH.exists():
        try:
            data = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for k, v in data.items():
                    if k not in DEFAULTS:
                        continue
                    if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                        cfg[k] = {**cfg[k], **v}  # merge nested (moderation)
                    else:
                        cfg[k] = v
        except (json.JSONDecodeError, OSError) as exc:
            raise ConfigError(f"Could not parse {_CONFIG_PATH}: {exc}") from exc
    env_key = os.environ.get("IMAGE_API_KEY", "").strip()
    if env_key:
        cfg["api_key"] = env_key
    env_base = os.environ.get("IMAGE_API_BASE_URL", "").strip().rstrip("/")
    if env_base:
        cfg["api_base_url"] = env_base
    return cfg


def _save_config(cfg: dict[str, Any]) -> None:
    """Persist the full config dict to disk."""
    _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def _mask_key(key: str) -> str:
    if not key:
        return "(not set)"
    if len(key) <= 10:
        return key[:2] + "***"
    return f"{key[:6]}...{key[-4:]}"


# --------------------------------------------------------------------------- #
# Backend client                                                              #
# --------------------------------------------------------------------------- #
class ImageAPIError(RuntimeError):
    """Raised when the upstream image API returns an error."""


def _post_json(url: str, payload: dict[str, Any], api_key: str, *, timeout: float = 180.0) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ImageAPIError(f"Upstream HTTP {exc.code}: {detail[:500]}") from exc
    except urllib.error.URLError as exc:
        raise ImageAPIError(f"Could not reach {url}: {exc.reason}") from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ImageAPIError(f"Upstream returned non-JSON: {raw[:200]}") from exc


def _get_json(url: str, api_key: str, *, timeout: float = 30.0) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ImageAPIError(f"HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:300]}") from exc
    except urllib.error.URLError as exc:
        raise ImageAPIError(f"Could not reach {url}: {exc.reason}") from exc


def _download(url: str, timeout: float = 60.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - trusted upstream
        return resp.read()


def _save_to_disk(data: bytes, *, prompt: str, ext: str, save_dir: str) -> str:
    if not save_dir:
        return ""
    os.makedirs(save_dir, exist_ok=True)
    slug = "".join(c if c.isalnum() else "-" for c in prompt[:30]).strip("-") or "image"
    path = os.path.join(save_dir, f"{int(time.time())}_{slug}.{ext}")
    with open(path, "wb") as fh:
        fh.write(data)
    return path


# --------------------------------------------------------------------------- #
# Moderation gate                                                             #
# --------------------------------------------------------------------------- #
class ModerationError(RuntimeError):
    """Raised when a prompt is rejected (or moderation itself fails fatally)."""


def _moderate(prompt: str, mod: dict[str, Any]) -> None:
    """Run the prompt through the moderation model; raise ModerationError if denied.

    Resilient by default: if the moderation endpoint is unreachable or errors,
    we let the request through rather than block all generation (fail-open).
    Set moderation ``fail_closed`` semantics by editing this if you prefer.
    """
    if not mod.get("enabled"):
        return
    base = (mod.get("api_base_url") or "").rstrip("/")
    key = mod.get("api_key") or ""
    model = mod.get("model") or ""
    if not (base and key and model):
        return  # moderation enabled but misconfigured → fail open with a warning

    system_prompt = mod.get("prompt") or (
        "You are a content moderator for an image generator. Decide whether the "
        "user's prompt is ALLOWED or DENIED based on typical platform rules: "
        "deny sexual content involving minors, realistic violence/gore, "
        "non-consensual sexual content, real-person defamation, hate imagery, "
        "and other content likely to violate policy. Reply with exactly one line: "
        "'ALLOW' or 'DENY: <short reason>'."
    )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.0,
        "max_tokens": 100,
    }
    try:
        data = _post_json(f"{base}/chat/completions", payload, key, timeout=30.0)
    except ImageAPIError as exc:
        # Moderation endpoint problem — fail open so generation still works.
        print(f"[GPT-image] moderation endpoint error (fail-open): {exc}", flush=True)
        return

    try:
        reply = data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError):
        reply = ""

    upper = reply.upper().strip()
    if upper.startswith("DENY"):
        reason = reply.split(":", 1)[1].strip() if ":" in reply else ""
        raise ModerationError(reason or "prompt disallowed by moderation")
    # ALLOW or anything else → proceed



# --------------------------------------------------------------------------- #
# Server & tools                                                              #
# --------------------------------------------------------------------------- #
mcp = MCPServer("GPT-image")


@mcp.tool(
    name="get_config",
    title="Show GPT-image config",
    description=(
        "Show the current GPT-image configuration: API endpoint, model, default "
        "size, save directory, and config file path. The API key is masked. "
        "Use set_config to change any of these values."
    ),
)
def get_config() -> str:
    """Return the current config as a human-readable report (key masked)."""
    with _lock:
        cfg = _load_config()
    mod = cfg.get("moderation") or {}
    lines = [
        f"config_file: {_CONFIG_PATH}",
        f"api_base_url: {cfg['api_base_url']}",
        f"api_key: {_mask_key(cfg['api_key'])}",
        f"model: {cfg['model']}",
        f"size: {cfg['size']}",
        f"save_dir: {cfg['save_dir'] or '(disabled)'}",
        "",
        f"moderation.enabled: {mod.get('enabled', False)}",
        f"moderation.api_base_url: {mod.get('api_base_url') or '(not set)'}",
        f"moderation.api_key: {_mask_key(mod.get('api_key') or '')}",
        f"moderation.model: {mod.get('model') or '(not set)'}",
        f"moderation.prompt: {(mod.get('prompt') or '(default)')[:80]}{'...' if len(mod.get('prompt') or '') > 80 else ''}",
    ]
    return "\n".join(lines)


@mcp.tool(
    name="set_config",
    title="Update GPT-image config",
    description=(
        "Update one or more GPT-image settings and persist them to the config "
        "file. Any field left null/omitted is unchanged. Changes take effect "
        "immediately for subsequent generate_image calls — no restart needed. "
        "Fields: api_base_url, api_key, model, size, save_dir."
    ),
)
def set_config(
    api_base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    size: str | None = None,
    save_dir: str | None = None,
) -> str:
    """Update config fields and persist to disk.

    Args:
        api_base_url: OpenAI-compatible API root, e.g. ``https://2xa.cc.cd/v1``.
        api_key: Bearer token for the API. Pass an empty string to clear it.
        model: Default model id, e.g. ``gpt-image-2``.
        size: Default image size, e.g. ``1024x1024``.
        save_dir: Directory to auto-save generated images (``""`` to disable).
    """
    updates: dict[str, Any] = {}
    if api_base_url is not None:
        updates["api_base_url"] = api_base_url.rstrip("/") or DEFAULTS["api_base_url"]
    if api_key is not None:
        updates["api_key"] = api_key
    if model is not None:
        updates["model"] = model
    if size is not None:
        updates["size"] = size
    if save_dir is not None:
        updates["save_dir"] = save_dir

    if not updates:
        return "No changes — every field was null. Call get_config to see current values."

    with _lock:
        cfg = _load_config()
        cfg.update(updates)
        _save_config(cfg)

    changed = ", ".join(updates)
    return f"Updated {changed}.\n\n{get_config()}"


@mcp.tool(
    name="set_moderation",
    title="Configure pre-generation moderation",
    description=(
        "Configure the moderation gate that screens every prompt BEFORE it "
        "reaches the image API. When enabled, prompts judged as disallowed are "
        "rejected to protect the account from risk control. Any argument left "
        "null is unchanged. Changes persist to config.json and take effect "
        "immediately. Pass enabled=false to turn moderation off."
    ),
)
def set_moderation(
    enabled: bool | None = None,
    api_base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    prompt: str | None = None,
) -> str:
    """Update moderation settings and persist to disk.

    Args:
        enabled: Turn the moderation gate on (true) or off (false).
        api_base_url: OpenAI-compatible chat endpoint for the classifier,
            e.g. ``http://host:8080/v1``.
        api_key: Bearer token for the moderation endpoint.
        model: Classifier model id, e.g. ``deepseek-v4-flash``.
        prompt: System prompt describing what is forbidden. Leave null to keep
            the current/built-in default.
    """
    updates: dict[str, Any] = {}
    if enabled is not None:
        updates["enabled"] = bool(enabled)
    if api_base_url is not None:
        updates["api_base_url"] = api_base_url.rstrip("/")
    if api_key is not None:
        updates["api_key"] = api_key
    if model is not None:
        updates["model"] = model
    if prompt is not None:
        updates["prompt"] = prompt

    if not updates:
        return "No changes — every argument was null."

    with _lock:
        cfg = _load_config()
        mod = cfg.get("moderation") or {}
        mod.update(updates)
        cfg["moderation"] = mod
        _save_config(cfg)

    changed = ", ".join(f"moderation.{k}" for k in updates)
    return f"Updated {changed}.\n\n{get_config()}"


@mcp.tool(
    name="generate_image",
    title="Generate image (GPT-image)",
    description=(
        "Generate one or more images from a text prompt via the configured "
        "OpenAI-compatible image API. Endpoint, key and default model come "
        "from config (see get_config / set_config); per-call args override them. "
        "Returns the image URL, and the local path if save_dir is set or save=true."
    ),
)
def generate_image(
    prompt: str,
    model: str | None = None,
    size: str | None = None,
    quality: str | None = None,
    n: int = 1,
    save: bool = False,
) -> str:
    """Generate an image from a text prompt.

    Args:
        prompt: Text description of the image to create.
        model: Model id; defaults to config ``model`` (e.g. ``gpt-image-2``).
        size: Size such as ``1024x1024`` / ``1024x1536`` / ``1536x1024``.
        quality: Optional quality hint (``low`` / ``medium`` / ``high``).
        n: How many images to generate (default 1, max 10).
        save: When true, also download each image to config ``save_dir``.

    Returns:
        A text report with the image URL(s) and metadata.
    """
    if not prompt or not prompt.strip():
        raise ValueError("`prompt` must not be empty.")

    with _lock:
        cfg = _load_config()

    if not cfg["api_key"]:
        raise ImageAPIError(
            "API key is not set. Use set_config(api_key=...) or edit the config file."
        )

    api_base = cfg["api_base_url"].rstrip("/")
    use_model = model or cfg["model"]
    use_size = size or cfg["size"]
    save_dir = cfg["save_dir"]

    # Pre-generation moderation gate. Raises ModerationError if denied;
    # fails open (lets the request through) if the endpoint is unreachable.
    mod = cfg.get("moderation") or {}
    if mod.get("enabled"):
        _moderate(prompt, mod)

    payload: dict[str, Any] = {
        "model": use_model,
        "prompt": prompt,
        "size": use_size,
        "n": max(1, min(int(n), 10)),
        "response_format": "url",
    }
    if quality:
        payload["quality"] = quality

    result = _post_json(f"{api_base}/images/generations", payload, cfg["api_key"])
    items = (result or {}).get("data") or []
    if not items:
        raise ImageAPIError(f"Upstream returned no images: {json.dumps(result)[:300]}")

    lines = [f"Generated {len(items)} image(s) | model='{use_model}' size='{use_size}'."]
    for idx, item in enumerate(items, 1):
        url = item.get("url", "") or ""
        revised = item.get("revised_prompt", "") or ""
        b64 = item.get("b64_json", "") or ""
        lines.append(f"\n[Image {idx}]")
        if url:
            lines.append(f"image_url: {url}")
        if revised:
            lines.append(f"revised_prompt: {revised}")
        if save and url and save_dir:
            try:
                data = _download(url)
                local = _save_to_disk(data, prompt=prompt, ext="png", save_dir=save_dir)
                lines.append(f"saved_to: {local}")
            except Exception as exc:  # noqa: BLE001
                lines.append(f"saved_to: (failed: {exc})")
        elif b64 and not url:
            lines.append(f"b64_json_length: {len(b64)}")

    usage = result.get("usage")
    if usage:
        lines.append(f"\nusage: {json.dumps(usage)}")
    return "\n".join(lines)


@mcp.tool(
    name="list_image_models",
    title="List backend models",
    description="List the models exposed by the configured image backend (GET /models).",
)
def list_image_models() -> str:
    """Return the backend's model list, highlighting image-capable ones."""
    with _lock:
        cfg = _load_config()
    if not cfg["api_key"]:
        raise ImageAPIError("API key is not set. Use set_config(api_key=...) first.")
    api_base = cfg["api_base_url"].rstrip("/")
    data = _get_json(f"{api_base}/models", cfg["api_key"])
    models = data.get("data") or []
    lines = [f"Backend {api_base} exposes {len(models)} model(s):"]
    for m in models:
        mid = m.get("id", "?")
        flag = " [image]" if mid in _KNOWN_IMAGE_MODEL_HINTS or "image" in mid.lower() else ""
        title = m.get("display_name") or m.get("owned_by") or ""
        lines.append(f"  - {mid}{flag}" + (f"  ({title})" if title else ""))
    return "\n".join(lines)


def main() -> None:
    """Entry point — run the MCP server over stdio."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
