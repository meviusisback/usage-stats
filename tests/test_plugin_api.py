import importlib.util
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
MODULE_NAME = "usage_stats_test_plugin_api"
SPEC = importlib.util.spec_from_file_location(MODULE_NAME, ROOT / "dashboard" / "plugin_api.py")
assert SPEC and SPEC.loader
plugin_api = importlib.util.module_from_spec(SPEC)
sys.modules[MODULE_NAME] = plugin_api
SPEC.loader.exec_module(plugin_api)

PROVIDER_ENV_KEYS = [
    "OPENCODE_GO_API_KEY",
    "OPENCODE_ZEN_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "KIMI_API_KEY",
    "NOVITA_API_KEY",
    "ZAI_API_KEY",
    "GLM_API_KEY",
    "DASHSCOPE_API_KEY",
    "ARCEE_API_KEY",
]


def make_client():
    app = FastAPI()
    app.include_router(plugin_api.router, prefix="/api/plugins/usage-stats")
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_summary_cache():
    """`/summary` caches for 45s; without this the first test's response
    leaks into every later /summary test."""
    plugin_api._summary_cache.clear()
    yield
    plugin_api._summary_cache.clear()


def clear_provider_keys(monkeypatch):
    for name in PROVIDER_ENV_KEYS:
        monkeypatch.delenv(name, raising=False)


# --- health / usage (backward-compatible) ------------------------------------

def test_health_route_is_mounted_at_the_desktop_namespace(monkeypatch):
    clear_provider_keys(monkeypatch)
    monkeypatch.setenv("HERMES_HOME", str(ROOT / "tests" / "fixtures" / "empty-home"))

    response = make_client().get("/api/plugins/usage-stats/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "api_key_configured": False,
        "providers_configured": [],
    }


def test_active_provider_resolves_from_config_yaml(monkeypatch, tmp_path):
    (tmp_path / "config.yaml").write_text(
        "model:\n  default: ox-alpha-free\n  provider: opencode-go\n"
        "  base_url: https://opencode.ai/zen/go/v1\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    body = make_client().get("/api/plugins/usage-stats/active_provider").json()

    assert body == {"provider": "opencode"}


def test_active_provider_unknown_config_returns_null(monkeypatch, tmp_path):
    (tmp_path / "config.yaml").write_text(
        "model:\n  default: some-model\n  provider: gemini\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    body = make_client().get("/api/plugins/usage-stats/active_provider").json()

    assert body == {"provider": None}


def test_active_provider_missing_config_returns_null(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    body = make_client().get("/api/plugins/usage-stats/active_provider").json()

    assert body == {"provider": None}


def test_health_lists_configured_providers(monkeypatch):
    clear_provider_keys(monkeypatch)
    monkeypatch.setenv("HERMES_HOME", str(ROOT / "tests" / "fixtures" / "empty-home"))
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")

    body = make_client().get("/api/plugins/usage-stats/health").json()

    assert body["status"] == "ok"
    assert body["api_key_configured"] is False
    assert set(body["providers_configured"]) == {"openrouter", "deepseek"}


def test_usage_without_key_returns_sanitized_plugin_payload(monkeypatch):
    clear_provider_keys(monkeypatch)
    monkeypatch.setenv("HERMES_HOME", str(ROOT / "tests" / "fixtures" / "empty-home"))

    response = make_client().get("/api/plugins/usage-stats/usage")

    assert response.status_code == 200
    assert response.json() == {
        "id": "opencode-go",
        "name": "OpenCode Go",
        "windows": plugin_api.WINDOWS,
        "error": "no-api-key",
        "usage": None,
    }


def test_usage_normalizes_upstream_response(monkeypatch):
    upstream = {
        "usage": {
            "rolling": {"percent": "39.45", "status": "ok", "resetsAt": "2026-08-18T20:00:00Z"},
            "weekly": {"percent": 15, "status": "ok"},
            "monthly": {"percent": None, "status": "ok"},
            "secret": {"token": "must-not-leak"},
        }
    }
    monkeypatch.setattr(plugin_api, "_read_api_key", lambda: "test-key")
    monkeypatch.setattr(plugin_api, "_request_usage", lambda _key: upstream)

    response = make_client().get("/api/plugins/usage-stats/usage")

    assert response.status_code == 200
    body = response.json()
    assert body["error"] is None
    assert body["usage"] == {
        "rolling": {"status": "ok", "percent": 39.5, "resetsAt": "2026-08-18T20:00:00Z"},
        "weekly": {"status": "ok", "percent": 15.0, "resetsAt": None},
        "monthly": {"status": "ok", "percent": None, "resetsAt": None},
    }
    assert "secret" not in body["usage"]


def test_request_sends_browser_user_agent(monkeypatch):
    captured = {}

    class FakeResponse:
        status = 200

        def read(self, _n):
            return b'{"usage":{}}'

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def fake_open(request, timeout=None):
        captured["request"] = request
        return FakeResponse()

    # Patch the module-level opener — _request_json no longer calls the
    # module-global urlopen (it uses the strict-redirect opener).
    monkeypatch.setattr(plugin_api._OPENER, "open", fake_open)

    plugin_api._request_usage("test-key")

    user_agent = captured["request"].get_header("User-agent")
    assert user_agent, "request must set a User-Agent header"
    assert "Python-urllib" not in user_agent


def test_strict_redirect_handler_refuses_downgrades_and_cross_host():
    req = urllib.request.Request("https://api.novita.ai/v3/account/balance")
    handler = plugin_api._StrictRedirectHandler()

    # https→http downgrade would re-send the Bearer key in cleartext.
    assert handler.redirect_request(req, None, 302, "moved", {}, "http://api.novita.ai/x") is None
    # Cross-host https would leak the key to a third party.
    assert handler.redirect_request(req, None, 302, "moved", {}, "https://evil.example/x") is None
    # Same-host https redirects are still followed.
    followed = handler.redirect_request(req, None, 302, "moved", {}, "https://api.novita.ai/v3/other")
    assert followed is not None
    assert followed.full_url == "https://api.novita.ai/v3/other"



# --- /summary (multi-provider) ------------------------------------------------

def test_summary_returns_each_configured_provider(monkeypatch):
    specs = [
        {
            "id": "opencode",
            "name": "OpenCode Go",
            "display": "OC",
            "key_envs": ["OPENCODE_GO_API_KEY"],
            "fetch": lambda key: {"kind": "percent", "label": "38%", "value": 38.0, "detail": "rolling 38%"},
        },
        {
            "id": "openrouter",
            "name": "OpenRouter",
            "display": "OR",
            "key_envs": ["OPENROUTER_API_KEY"],
            "fetch": lambda key: {"kind": "balance", "label": "$1.82", "value": 1.82, "detail": "$1.82 left"},
        },
    ]
    monkeypatch.setattr(plugin_api, "PROVIDER_SPECS", specs)
    monkeypatch.setattr(plugin_api, "_read_key", lambda env: "test-key")

    response = make_client().get("/api/plugins/usage-stats/summary")

    assert response.status_code == 200
    providers = response.json()["providers"]
    assert len(providers) == 2
    assert providers[0]["id"] == "opencode"
    assert providers[0]["label"] == "38%"
    assert providers[0]["error"] is None
    assert providers[1]["id"] == "openrouter"
    assert providers[1]["value"] == 1.82


def test_summary_marks_provider_without_key(monkeypatch):
    specs = [
        {
            "id": "deepseek",
            "name": "DeepSeek",
            "display": "DS",
            "key_envs": ["DEEPSEEK_API_KEY"],
            "fetch": lambda key: {"kind": "balance", "label": "$6.95", "value": 6.95},
        },
    ]
    monkeypatch.setattr(plugin_api, "PROVIDER_SPECS", specs)
    monkeypatch.setattr(plugin_api, "_read_key", lambda env: None)

    body = make_client().get("/api/plugins/usage-stats/summary").json()

    assert body["providers"][0]["error"] == "no-api-key"
    assert body["providers"][0]["label"] is None


def test_summary_exposes_api_key_configured_map(monkeypatch):
    specs = [
        {"id": "opencode", "name": "OpenCode Go", "display": "OC",
         "key_envs": ["OPENCODE_GO_API_KEY"], "fetch": lambda key: {}},
        {"id": "openrouter", "name": "OpenRouter", "display": "OR",
         "key_envs": ["OPENROUTER_API_KEY"], "fetch": lambda key: {}},
    ]
    monkeypatch.setattr(plugin_api, "PROVIDER_SPECS", specs)
    monkeypatch.setattr(plugin_api, "_read_key", lambda env: "x" if env == "OPENCODE_GO_API_KEY" else None)

    body = make_client().get("/api/plugins/usage-stats/summary").json()

    assert body["apiKeyConfigured"] == {"opencode": True, "openrouter": False}


def test_summary_api_key_configured_all_false_when_no_keys(monkeypatch):
    specs = [
        {"id": "opencode", "name": "OpenCode Go", "display": "OC",
         "key_envs": ["OPENCODE_GO_API_KEY"], "fetch": lambda key: {}},
    ]
    monkeypatch.setattr(plugin_api, "PROVIDER_SPECS", specs)
    monkeypatch.setattr(plugin_api, "_read_key", lambda env: None)

    body = make_client().get("/api/plugins/usage-stats/summary").json()

    assert body["apiKeyConfigured"] == {"opencode": False}


def test_summary_sanitizes_transport_errors(monkeypatch):
    def boom(_key):
        raise urllib.error.HTTPError("url", 403, "forbidden", None, None)

    specs = [
        {
            "id": "opencode",
            "name": "OpenCode Go",
            "display": "OC",
            "key_envs": ["OPENCODE_GO_API_KEY"],
            "fetch": boom,
        },
    ]
    monkeypatch.setattr(plugin_api, "PROVIDER_SPECS", specs)
    monkeypatch.setattr(plugin_api, "_read_key", lambda env: "test-key")

    body = make_client().get("/api/plugins/usage-stats/summary").json()

    assert body["providers"][0]["error"] == "http-403"


def test_fetch_opencode_exposes_individual_windows(monkeypatch):
    upstream = {
        "usage": {
            "rolling": {"percent": 40, "status": "ok"},
            "weekly": {"percent": 57, "status": "ok"},
            "monthly": {"percent": 34, "status": "ok"},
        }
    }
    monkeypatch.setattr(plugin_api, "_request_usage", lambda _key: upstream)

    metric = plugin_api._fetch_opencode("test-key")

    assert metric["windows"] == [
        {"id": "rolling", "label": "5h", "percent": 40.0, "resetsAt": None},
        {"id": "weekly", "label": "W", "percent": 57.0, "resetsAt": None},
        {"id": "monthly", "label": "M", "percent": 34.0, "resetsAt": None},
    ]
    assert metric["label"] == "40%"
    assert metric["kind"] == "percent"


def test_fetch_opencode_passes_through_reset_times(monkeypatch):
    upstream = {
        "usage": {
            "rolling": {"percent": 0, "status": "ok", "resetsAt": "2026-08-21T12:28:19.883Z"},
            "weekly": {"percent": 79, "status": "ok", "resetsAt": "2026-08-24T00:00:00.883Z"},
            "monthly": {"percent": 46, "status": "ok", "resetsAt": "not-a-date"},
        }
    }
    monkeypatch.setattr(plugin_api, "_request_usage", lambda _key: upstream)

    metric = plugin_api._fetch_opencode("test-key")

    windows = {w["id"]: w for w in metric["windows"]}
    assert windows["rolling"]["resetsAt"] == "2026-08-21T12:28:19.883Z"
    # Non-string values are sanitized to None; malformed strings pass through
    # and are discarded client-side (Date.parse → NaN → no countdown).
    assert windows["monthly"]["resetsAt"] == "not-a-date"


# --- new providers (mocked fetchers) -----------------------------------------

def test_fetch_kimi_normalizes_response(monkeypatch):
    fake = {"available": 42.50, "voucher": 10.00, "cash": 32.50}
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: fake)

    metric = plugin_api._fetch_kimi("test-key")

    assert metric["kind"] == "balance"
    assert metric["value"] == 42.5
    assert metric["currency"] == "CNY"
    assert "¥42" in metric["label"]
    assert "voucher ¥10" in metric["detail"]
    assert "cash ¥32" in metric["detail"]


def test_fetch_deepseek_caps_api_supplied_currency_length(monkeypatch):
    # API-supplied text is inert (React escapes it) but must not be able to
    # blow up the chip layout with an unbounded label.
    fake = {"balance_infos": [{"currency": "X" * 1000, "total_balance": 5}]}
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: fake)

    metric = plugin_api._fetch_deepseek("test-key")

    assert len(metric["label"]) < 40
    assert metric["currency"] == "X" * 8



def test_fetch_kimi_handles_zero_balance(monkeypatch):
    fake = {"available": 0, "voucher": 0, "cash": 0}
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: fake)

    metric = plugin_api._fetch_kimi("test-key")

    assert metric["kind"] == "balance"
    assert metric["value"] == 0.0
    assert metric["label"] == "¥0.00"


def test_fetch_kimi_unexpected_response(monkeypatch):
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: {"error": "bad"})

    metric = plugin_api._fetch_kimi("test-key")

    assert metric["error"] == "unexpected-response"


def test_fetch_novita_normalizes_response(monkeypatch):
    fake = {"balance": 1500.50}
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: fake)

    metric = plugin_api._fetch_novita("test-key")

    assert metric["kind"] == "balance"
    assert metric["value"] == 1500.5
    assert metric["currency"] == "USD"
    assert "$1,500" in metric["label"]


def test_fetch_novita_with_credits_field(monkeypatch):
    fake = {"credits": 200.0}
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: fake)

    metric = plugin_api._fetch_novita("test-key")

    assert metric["value"] == 200.0


def test_fetch_zai_normalizes_response(monkeypatch):
    fake = {"balance": 88.88}
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: fake)

    metric = plugin_api._fetch_zai("test-key")

    assert metric["kind"] == "balance"
    assert metric["value"] == 88.88
    assert metric["currency"] == "CNY"
    assert "¥88" in metric["label"]


def test_fetch_zai_unwraps_data(monkeypatch):
    fake = {"data": {"balance": 50.0}}
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: fake)

    metric = plugin_api._fetch_zai("test-key")

    assert metric["value"] == 50.0


def test_fetch_alibaba_normalizes_response(monkeypatch):
    fake = {"data": {"total_cost": 123.45, "currency": "CNY"}}
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: fake)

    metric = plugin_api._fetch_alibaba("test-key")

    assert metric["kind"] == "balance"
    assert metric["value"] == 123.45
    assert metric["currency"] == "CNY"


def test_fetch_arcee_normalizes_response(monkeypatch):
    fake = {"balance": 75.00}
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: fake)

    metric = plugin_api._fetch_arcee("test-key")

    assert metric["kind"] == "balance"
    assert metric["value"] == 75.0
    assert metric["currency"] == "USD"
    assert "$75" in metric["label"]


def test_all_providers_registered():
    ids = [spec["id"] for spec in plugin_api.PROVIDER_SPECS]
    assert "opencode" in ids
    assert "openrouter" in ids
    assert "deepseek" in ids
    assert "kimi" in ids
    assert "novita" in ids
    assert "zai" in ids
    assert "alibaba" in ids
    assert "arcee" in ids
    assert len(ids) == 8


# --- _extract_balance: never infer balance from an arbitrary numeric field ---
# Regression test for the security-review finding: a response like
# {"code":0,"balance":12.5} must yield 12.5, NOT 0.0 (the old "first numeric
# value" fallback returned 0.0, misreporting the real balance).
def test_extract_balance_prefers_named_field_over_arbitrary_numeric():
    body = {"code": 0, "msg": "ok", "balance": 12.5}
    assert plugin_api._extract_balance(body, ("balance", "credits", "remaining")) == 12.5


def test_extract_balance_returns_none_when_no_named_field():
    # No named field present → must return None (not a stray numeric code/id).
    body = {"code": 200, "request_id": "abc123", "msg": "ok"}
    assert plugin_api._extract_balance(body, ("balance", "credits", "remaining")) is None


def test_extract_balance_unwraps_data():
    body = {"data": {"balance": 50.0}}
    assert plugin_api._extract_balance(body, ("balance",), unwrap_data=True) == 50.0


# --- code-review regressions: null / non-finite upstream values ---------------

def test_extract_balance_skips_null_field_instead_of_coercing_to_zero():
    # A present-but-null balance means "no data" — must return None so the
    # fetcher maps it to unexpected-response, not a red "$0.00".
    assert plugin_api._extract_balance({"balance": None}, ("balance",)) is None


def test_safe_float_rejects_non_finite_values():
    assert plugin_api._safe_float("inf") == 0.0
    assert plugin_api._safe_float("nan") == 0.0
    assert plugin_api._safe_float(1e999) == 0.0
    assert plugin_api._safe_float(None) == 0.0
    assert plugin_api._safe_float("12.5") == 12.5


def test_normalize_usage_rejects_non_finite_percent():
    body = {"usage": {"rolling": {"percent": 1e999, "status": "ok"}}}
    norm = plugin_api._normalize_usage(body)
    assert norm["rolling"]["percent"] is None


def test_fetch_kimi_null_available_is_unexpected_response(monkeypatch):
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: {"available": None})
    assert plugin_api._fetch_kimi("test-key") == {"error": "unexpected-response"}


def test_fetch_deepseek_all_null_totals_is_unexpected_response(monkeypatch):
    fake = {"balance_infos": [{"currency": "CNY", "total_balance": None}]}
    monkeypatch.setattr(plugin_api, "_request_json", lambda url, key: fake)
    assert plugin_api._fetch_deepseek("test-key") == {"error": "unexpected-response"}
