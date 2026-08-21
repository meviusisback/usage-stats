"""Usage Stats → multi-provider usage/balance for the Hermes desktop plugin.

Hermes discovers this file through ``dashboard/manifest.json`` and mounts the
module-level FastAPI ``router`` under ``/api/plugins/opencode-usage``.

Endpoints
---------
GET /health   → liveness + which providers have a key configured
GET /usage    → OpenCode Go usage only (backward-compatible shape)
GET /summary  → usage/balance for EVERY configured provider (the real one)

Supported providers
-------------------
- OpenCode Go  (% used: rolling 5h / weekly / monthly)
- OpenRouter   (credit balance $)
- DeepSeek     (account balance $)
- Kimi         (balance ¥ — Moonshot/Kimi Coding)
- NovitaAI     (account balance)
- ZAI / Zhipu  (balance ¥)
- Alibaba      (DashScope billing)
- Arcee AI     (balance)
"""

from __future__ import annotations

import json
import logging
import math
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

from fastapi import APIRouter

import yaml

logger = logging.getLogger(__name__)
router = APIRouter()

USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage"
OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"
DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"
KIMI_BALANCE_URL = "https://api.moonshot.cn/v1/users/me/balance"
NOVITA_BALANCE_URL = "https://api.novita.ai/v3/account/balance"
ZAI_BALANCE_URL = "https://open.bigmodel.cn/api/paas/v4/user/balance"
ALIBABA_BILLING_URL = "https://dashscope.aliyuncs.com/api/v1/services/billing/usage"
ARCEE_BALANCE_URL = "https://api.arcee.ai/v2/user/balance"
TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 4096
USER_AGENT = "Mozilla/5.0 (Hermes-Agent; usage-stats)"
WINDOWS = [
    {"id": "rolling", "label": "5h"},
    {"id": "weekly", "label": "W"},
    {"id": "monthly", "label": "M"},
]

# In-memory cache for /summary to limit upstream load and abuse (finding #6).
_SUMMARY_CACHE_TTL_SECONDS = 45
_summary_cache: dict[str, tuple[float, dict[str, Any]]] = {}


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


class _StrictRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Only follow redirects to the SAME https host.

    urllib's default handler forwards the Authorization header to redirect
    targets and even permits https→http downgrades (CWE-319/CWE-522), which
    would re-send provider API keys in cleartext or leak them to a third
    host. Returning None makes HTTPRedirectHandler raise the 3xx as an
    HTTPError instead of following it; _transport_error maps that to
    'http-<code>'.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        parts = urllib.parse.urlparse(newurl)
        origin = urllib.parse.urlparse(req.full_url)
        if parts.scheme != "https" or parts.netloc != origin.netloc:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(
    _StrictRedirectHandler,
    urllib.request.HTTPSHandler(context=ssl.create_default_context()),
)


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
    with _OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:
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
            percent = float(raw["percent"]) if raw.get("percent") is not None else None
        except (TypeError, ValueError):
            percent = None
        # 1e999 parses to inf; round(inf) would raise OverflowError downstream.
        if percent is not None and not math.isfinite(percent):
            percent = None
        percent = round(percent, 1) if percent is not None else None

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


# --- helpers ------------------------------------------------------------------

def _pct(value: Any) -> str:
    return f"{round(value)}%" if value is not None else "—"


def _safe_float(value: Any, default: float = 0.0) -> float:
    """Coerce to a finite float; null/inf/nan strings fall back to ``default``.

    Non-finite values must never reach labels ('$inf') or JSON (which
    serializes them as null), so they are treated like unparsable input.
    """
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def _extract_balance(
    body: dict[str, Any],
    field_names: tuple[str, ...],
    *,
    unwrap_data: bool = False,
) -> float | None:
    """Find a numeric balance value in a response dict.

    Tries ``field_names`` (and ``data.<field>`` when ``unwrap_data``) in order.
    Returns ``None`` if no named field holds a usable (non-null) number — never
    infers a balance from an arbitrary numeric field (e.g. ``code`` /
    ``request_id``), which would show a wrong balance to the user.  The caller
    maps ``None`` to an error payload.
    """
    inner = body.get("data") if unwrap_data and isinstance(body.get("data"), dict) else body
    for key in field_names:
        value = inner.get(key)
        # A present-but-null field means "no data", not "$0.00" — skip it so
        # the caller's `balance is None → unexpected-response` guard fires.
        if value is None:
            continue
        return _safe_float(value)
    return None


# --- provider fetchers --------------------------------------------------------

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
            "resetsAt": (norm.get(window["id"]) or {}).get("resetsAt"),
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

    total = _safe_float(data["total_credits"])
    used = _safe_float(data["total_usage"])
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
    found = False
    for info in infos:
        if not isinstance(info, dict):
            continue
        currency = info.get("currency") or currency
        raw_total = info.get("total_balance")
        if raw_total is None:
            continue
        total += _safe_float(raw_total)
        found = True

    if not found:
        return {"error": "unexpected-response"}

    value = round(total, 2)
    return {
        "kind": "balance",
        "label": f"{value:,.2f} {currency}",
        "value": value,
        "currency": currency,
        "detail": f"balance {value:,.2f} {currency}",
    }


def _fetch_kimi(api_key: str) -> dict[str, Any]:
    """Kimi / Moonshot balance — GET api.moonshot.cn/v1/users/me/balance.

    Response shape (from platform.kimi.ai docs):
        {available: float, voucher: float, cash: float}
    Currency: CNY.
    """
    body = _request_json(KIMI_BALANCE_URL, api_key)
    if not isinstance(body, dict) or body.get("available") is None:
        return {"error": "unexpected-response"}

    available = _safe_float(body.get("available"))
    voucher = _safe_float(body.get("voucher"))
    cash = _safe_float(body.get("cash"))
    return {
        "kind": "balance",
        "label": f"¥{available:,.2f}",
        "value": round(available, 2),
        "currency": "CNY",
        "detail": f"balance ¥{available:,.2f} (voucher ¥{voucher:,.2f}, cash ¥{cash:,.2f})",
    }


def _fetch_novita(api_key: str) -> dict[str, Any]:
    """NovitaAI balance — GET api.novita.ai/v3/account/balance."""
    body = _request_json(NOVITA_BALANCE_URL, api_key)
    if not isinstance(body, dict):
        return {"error": "unexpected-response"}

    balance = _extract_balance(body, ("balance", "credits", "remaining", "available"))
    if balance is None:
        return {"error": "unexpected-response"}

    return {
        "kind": "balance",
        "label": f"${balance:,.2f}",
        "value": round(balance, 2),
        "currency": "USD",
        "detail": f"balance ${balance:,.2f}",
    }


def _fetch_zai(api_key: str) -> dict[str, Any]:
    """ZAI / Zhipu balance — GET open.bigmodel.cn/api/paas/v4/user/balance."""
    body = _request_json(ZAI_BALANCE_URL, api_key)
    if not isinstance(body, dict):
        return {"error": "unexpected-response"}

    balance = _extract_balance(body, ("balance", "remaining", "available", "quota"), unwrap_data=True)
    if balance is None:
        return {"error": "unexpected-response"}

    return {
        "kind": "balance",
        "label": f"¥{balance:,.2f}",
        "value": round(balance, 2),
        "currency": "CNY",
        "detail": f"balance ¥{balance:,.2f}",
    }


def _fetch_alibaba(api_key: str) -> dict[str, Any]:
    """Alibaba / DashScope billing — GET dashscope.aliyuncs.com/api/v1/services/billing/usage."""
    body = _request_json(ALIBABA_BILLING_URL, api_key)
    if not isinstance(body, dict):
        return {"error": "unexpected-response"}

    inner = body.get("data") if isinstance(body.get("data"), dict) else body
    balance = _extract_balance(body, ("balance", "remaining", "available", "total_cost", "quota"), unwrap_data=True)
    if balance is None:
        return {"error": "unexpected-response"}

    currency = str(inner.get("currency", "CNY")) if isinstance(inner, dict) else "CNY"
    return {
        "kind": "balance",
        "label": f"{balance:,.2f} {currency}",
        "value": round(balance, 2),
        "currency": currency,
        "detail": f"balance {balance:,.2f} {currency}",
    }


def _fetch_arcee(api_key: str) -> dict[str, Any]:
    """Arcee AI balance — GET api.arcee.ai/v2/user/balance."""
    body = _request_json(ARCEE_BALANCE_URL, api_key)
    if not isinstance(body, dict):
        return {"error": "unexpected-response"}

    balance = _extract_balance(body, ("balance", "credits", "remaining", "available"))
    if balance is None:
        return {"error": "unexpected-response"}

    return {
        "kind": "balance",
        "label": f"${balance:,.2f}",
        "value": round(balance, 2),
        "currency": "USD",
        "detail": f"balance ${balance:,.2f}",
    }


# --- provider registry --------------------------------------------------------

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
    {
        "id": "kimi",
        "name": "Kimi",
        "display": "KI",
        "key_envs": ["KIMI_API_KEY"],
        "fetch": _fetch_kimi,
    },
    {
        "id": "novita",
        "name": "NovitaAI",
        "display": "NV",
        "key_envs": ["NOVITA_API_KEY"],
        "fetch": _fetch_novita,
    },
    {
        "id": "zai",
        "name": "ZAI",
        "display": "Z",
        "key_envs": ["ZAI_API_KEY", "GLM_API_KEY"],
        "fetch": _fetch_zai,
    },
    {
        "id": "alibaba",
        "name": "Alibaba",
        "display": "AB",
        "key_envs": ["DASHSCOPE_API_KEY"],
        "fetch": _fetch_alibaba,
    },
    {
        "id": "arcee",
        "name": "Arcee AI",
        "display": "AR",
        "key_envs": ["ARCEE_API_KEY"],
        "fetch": _fetch_arcee,
    },
]


# --- transport error mapping --------------------------------------------------

def _transport_error(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"http-{exc.code}"
    if isinstance(exc, (urllib.error.URLError, TimeoutError, OSError)):
        return "network-error"
    if isinstance(exc, (json.JSONDecodeError, UnicodeDecodeError, ValueError, OverflowError)):
        return "unexpected-response"
    return "unknown-error"


# --- configured-provider resolution -------------------------------------------

# Same token table as the desktop chip's providerIdFor: maps free text (a
# provider slug or base_url) to one of this plugin's provider ids.
_PROVIDER_TOKENS: list[tuple[str, tuple[str, ...]]] = [
    ("opencode", ("opencode",)),
    ("openrouter", ("openrouter",)),
    ("deepseek", ("deepseek",)),
    ("kimi", ("kimi", "moonshot")),
    ("novita", ("novita",)),
    ("zai", ("zai", "glm", "zhipu", "bigmodel")),
    ("alibaba", ("dashscope", "alibaba", "aliyuncs")),
    ("arcee", ("arcee",)),
]


def _provider_id_for(text: str | None) -> str | None:
    value = (text or "").lower()
    for provider_id, tokens in _PROVIDER_TOKENS:
        if any(token in value for token in tokens):
            return provider_id
    return None


def _configured_provider() -> str | None:
    """Provider id of the agent's configured default model (config.yaml).

    The Desktop composer reports a bare model id ('ox-alpha-free') with no
    provider hint, so the chip asks the backend which provider serves it.
    """
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    with open(os.path.join(home, "config.yaml"), encoding="utf-8") as handle:
        config = yaml.safe_load(handle) or {}
    model_config = config.get("model") or {}
    return (
        _provider_id_for(model_config.get("provider"))
        or _provider_id_for(model_config.get("base_url"))
    )


@router.get("/active_provider")
def active_provider() -> dict[str, Any]:
    """Provider id (or null) serving the agent's configured default model."""
    try:
        return {"provider": _configured_provider()}
    except Exception:  # noqa: BLE001 - missing/invalid config is not a 500
        return {"provider": None}


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
    """Usage/balance for every configured provider, fetched in parallel.

    Results are cached in-memory for ``_SUMMARY_CACHE_TTL_SECONDS`` to avoid
    re-hitting every upstream provider on each poll and to limit abuse.
    """
    now = time.monotonic()
    cached = _summary_cache.get("summary")
    if cached is not None and (now - cached[0]) < _SUMMARY_CACHE_TTL_SECONDS:
        return cached[1]

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

    providers: list[dict[str, Any]] = [None] * len(PROVIDER_SPECS)
    with ThreadPoolExecutor(max_workers=len(PROVIDER_SPECS)) as pool:
        futures = {
            pool.submit(_fetch_one, spec): idx
            for idx, spec in enumerate(PROVIDER_SPECS)
        }
        for future in as_completed(futures):
            idx = futures[future]
            providers[idx] = future.result()

    result: dict[str, Any] = {
        "providers": providers,
        "apiKeyConfigured": {
            spec["id"]: any(_read_key(env) for env in spec["key_envs"])
            for spec in PROVIDER_SPECS
        },
    }
    _summary_cache["summary"] = (time.monotonic(), result)
    return result
