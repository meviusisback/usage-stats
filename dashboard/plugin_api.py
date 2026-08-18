"""OpenCode Usage → multi-provider usage/balance for the Hermes desktop plugin.

Hermes discovers this file through ``dashboard/manifest.json`` and mounts the
module-level FastAPI ``router`` under ``/api/plugins/opencode-usage``.

Endpoints
---------
GET /health   → liveness + which providers have a key configured
GET /usage    → OpenCode Go usage only (backward-compatible shape)
GET /summary  → usage/balance for EVERY configured provider (the real one)
"""

from __future__ import annotations

import json
import logging
import os
import ssl
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

from fastapi import APIRouter

logger = logging.getLogger(__name__)
router = APIRouter()

USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage"
OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"
DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"
TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 4096
USER_AGENT = "Mozilla/5.0 (Hermes-Agent; opencode-usage)"
WINDOWS = [
    {"id": "rolling", "label": "5h"},
    {"id": "weekly", "label": "W"},
    {"id": "monthly", "label": "M"},
]


def _read_key(env_name: str) -> str | None:
    """Read a provider key from the process environment.

    load_hermes_dotenv() runs at process startup before any plugin is mounted,
    so all .env values are already in os.environ.  No manual file scan needed.
    """
    value = os.environ.get(env_name, "").strip()
    return value or None


def _read_api_key() -> str | None:
    # OpenCode Go and Zen share one account; the Go key is preferred.
    return _read_key("OPENCODE_GO_API_KEY") or _read_key("OPENCODE_ZEN_API_KEY")


def _request_json(url: str, api_key: str) -> Any:
    # OpenCode's edge rejects the default Python-urllib User-Agent with 403,
    # so we send a browser-like one everywhere.
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS, context=context) as response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("response-too-large")
    return json.loads(raw.decode("utf-8", errors="replace"))


def _request_usage(api_key: str) -> Any:
    return _request_json(USAGE_API_URL, api_key)


# --- normalizers (OpenCode Go, backward-compatible) ---------------------------

def _normalize_usage(body: Any) -> dict[str, dict[str, Any] | None] | None:
    raw_usage = body.get("usage") if isinstance(body, dict) else None
    if not isinstance(raw_usage, dict):
        return None

    normalized: dict[str, dict[str, Any] | None] = {}
    for window in WINDOWS:
        window_id = window["id"]
        raw = raw_usage.get(window_id)
        if not isinstance(raw, dict):
            normalized[window_id] = None
            continue

        try:
            percent = round(float(raw["percent"]), 1) if raw.get("percent") is not None else None
        except (TypeError, ValueError):
            percent = None

        normalized[window_id] = {
            "status": raw.get("status") if isinstance(raw.get("status"), str) else None,
            "percent": percent,
            "resetsAt": raw.get("resetsAt") if isinstance(raw.get("resetsAt"), str) else None,
        }
    return normalized


def _payload(*, error: str | None, usage: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "id": "opencode-go",
        "name": "OpenCode Go",
        "windows": WINDOWS,
        "error": error,
        "usage": usage,
    }


# --- provider metrics (summary) ----------------------------------------------

def _pct(value: Any) -> str:
    return f"{round(value)}%" if value is not None else "—"


def _fetch_opencode(api_key: str) -> dict[str, Any]:
    body = _request_usage(api_key)
    norm = _normalize_usage(body)
    if norm is None:
        return {"error": "unexpected-response"}

    windows = [
        {
            "id": window["id"],
            "label": window["label"],
            "percent": (norm.get(window["id"]) or {}).get("percent"),
        }
        for window in WINDOWS
    ]

    rolling = norm.get("rolling") or {}
    weekly = norm.get("weekly") or {}
    monthly = norm.get("monthly") or {}
    rolling_pct = rolling.get("percent")
    weekly_pct = weekly.get("percent")
    monthly_pct = monthly.get("percent")

    headline = rolling_pct if rolling_pct is not None else (weekly_pct if weekly_pct is not None else monthly_pct)
    detail = (
        f"rolling 5h {_pct(rolling_pct)} · weekly {_pct(weekly_pct)} · monthly {_pct(monthly_pct)}"
    )
    return {
        "kind": "percent",
        "label": _pct(headline),
        "value": headline,
        "detail": detail,
        "windows": windows,
    }


def _fetch_openrouter(api_key: str) -> dict[str, Any]:
    body = _request_json(OPENROUTER_CREDITS_URL, api_key)
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict) or data.get("total_credits") is None or data.get("total_usage") is None:
        return {"error": "unexpected-response"}

    try:
        total = float(data["total_credits"])
        used = float(data["total_usage"])
    except (TypeError, ValueError):
        return {"error": "unexpected-response"}

    remaining = max(0.0, total - used)
    pct_used = (used / total * 100.0) if total > 0 else 0.0
    return {
        "kind": "balance",
        "label": f"${remaining:,.2f}",
        "value": round(remaining, 2),
        "used": round(used, 2),
        "total": round(total, 2),
        "detail": f"${remaining:,.2f} left of ${total:,.2f} ({pct_used:.0f}% used)",
    }


def _fetch_deepseek(api_key: str) -> dict[str, Any]:
    body = _request_json(DEEPSEEK_BALANCE_URL, api_key)
    infos = body.get("balance_infos") if isinstance(body, dict) else None
    if not isinstance(infos, list) or not infos:
        return {"error": "unexpected-response"}

    total = 0.0
    currency = "USD"
    for info in infos:
        if not isinstance(info, dict):
            continue
        currency = info.get("currency") or currency
        try:
            total += float(info.get("total_balance") or 0)
        except (TypeError, ValueError):
            continue

    value = round(total, 2)
    return {
        "kind": "balance",
        "label": f"{value:,.2f} {currency}",
        "value": value,
        "currency": currency,
        "detail": f"balance {value:,.2f} {currency}",
    }


# id, display label, env keys (first found wins), fetcher
PROVIDER_SPECS: list[dict[str, Any]] = [
    {
        "id": "opencode",
        "name": "OpenCode Go",
        "display": "OC",
        "key_envs": ["OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY"],
        "fetch": _fetch_opencode,
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "display": "OR",
        "key_envs": ["OPENROUTER_API_KEY"],
        "fetch": _fetch_openrouter,
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "display": "DS",
        "key_envs": ["DEEPSEEK_API_KEY"],
        "fetch": _fetch_deepseek,
    },
]


def _transport_error(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"http-{exc.code}"
    if isinstance(exc, (urllib.error.URLError, TimeoutError, OSError)):
        return "network-error"
    if isinstance(exc, (json.JSONDecodeError, UnicodeDecodeError, ValueError)):
        return "unexpected-response"
    return "unknown-error"


# --- routes -------------------------------------------------------------------

@router.get("/health")
def health() -> dict[str, Any]:
    configured = [spec["id"] for spec in PROVIDER_SPECS if any(_read_key(env) for env in spec["key_envs"])]
    return {
        "status": "ok",
        "api_key_configured": _read_api_key() is not None,
        "providers_configured": configured,
    }


@router.get("/usage")
def usage() -> dict[str, Any]:
    api_key = _read_api_key()
    if not api_key:
        return _payload(error="no-api-key", usage=None)

    try:
        body = _request_usage(api_key)
    except Exception as exc:  # noqa: BLE001 - sanitize into the payload
        logger.warning("OpenCode usage request failed", exc_info=True)
        return _payload(error=_transport_error(exc), usage=None)

    normalized = _normalize_usage(body)
    if normalized is None:
        return _payload(error="unexpected-response", usage=None)
    return _payload(error=None, usage=normalized)


@router.get("/summary")
def summary() -> dict[str, Any]:
    """Usage/balance for every configured provider, fetched in parallel."""
    providers: list[dict[str, Any]] = [None] * len(PROVIDER_SPECS)  # type: ignore[list-item]

    def _fetch_one(spec: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        entry: dict[str, Any] = {
            "id": spec["id"],
            "name": spec["name"],
            "display": spec["display"],
            "kind": None,
            "label": None,
            "value": None,
            "detail": None,
            "error": None,
        }

        key: str | None = None
        for env in spec["key_envs"]:
            key = _read_key(env)
            if key:
                break

        if not key:
            entry["error"] = "no-api-key"
            return entry  # type: ignore[return-value]

        fetcher: Callable[[str], dict[str, Any]] = spec["fetch"]
        try:
            metric = fetcher(key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Provider %s fetch failed", spec["id"], exc_info=True)
            metric = {"error": _transport_error(exc)}

        entry.update(metric)
        return entry  # type: ignore[return-value]

    with ThreadPoolExecutor(max_workers=len(PROVIDER_SPECS)) as pool:
        futures = {
            pool.submit(_fetch_one, spec): idx
            for idx, spec in enumerate(PROVIDER_SPECS)
        }
        for future in as_completed(futures):
            idx = futures[future]
            providers[idx] = future.result()

    return {"providers": providers}
