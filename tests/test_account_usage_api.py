"""GET /account_usage — gateway-native (OAuth) snapshots.

These tests pin the contract mapGatewayProviders() consumes and the fail-open
behavior the endpoint owes callers; Hermes' own fetcher is faked so no real
OAuth credentials or network are required.
"""
import importlib.util
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
MODULE_NAME = "usage_stats_test_account_usage"
SPEC = importlib.util.spec_from_file_location(MODULE_NAME, ROOT / "dashboard" / "plugin_api.py")
assert SPEC and SPEC.loader
plugin_api = importlib.util.module_from_spec(SPEC)
sys.modules[MODULE_NAME] = plugin_api
SPEC.loader.exec_module(plugin_api)


def make_client():
    app = FastAPI()
    app.include_router(plugin_api.router, prefix="/api/plugins/usage-stats")
    return TestClient(app)


class FakeWindow:
    def __init__(self, label, used_percent, reset_at=None):
        self.label = label
        self.used_percent = used_percent
        self.reset_at = reset_at


class FakeSnapshot:
    def __init__(self, provider, windows, details=(), plan=None, available=True):
        self.provider = provider
        self.windows = windows
        self.details = details
        self.plan = plan
        self.title = "Account limits"
        self.available = available


def install_fake_fetcher(monkeypatch, snapshots):
    """Inject a fake agent.account_usage module whose fetch returns *snapshots*
    per provider slug, and report which slugs were asked."""
    calls = []

    def fetch(provider, *, base_url=None, api_key=None):
        calls.append(provider)
        return snapshots.get(provider)

    # plugin_api imports `from agent.account_usage import fetch_account_usage`
    # at call time inside the route — a stub module in sys.modules satisfies it.
    fake = types.ModuleType("agent.account_usage")
    setattr(fake, "fetch_account_usage", fetch)
    sys.modules.setdefault("agent", types.ModuleType("agent"))
    sys.modules["agent.account_usage"] = fake
    plugin_api._account_usage_cache.clear()
    return calls


def _codex_snapshot():
    reset = datetime.now(timezone.utc) + timedelta(hours=4)
    return FakeSnapshot("openai-codex", [
        FakeWindow("Session", 8.0, reset),
        FakeWindow("Weekly", 76.0, reset + timedelta(days=2)),
    ], details=("You have 1 reset credit banked",), plan="Plus")


def test_account_usage_returns_snapshot_shape_the_chip_consumes(monkeypatch):
    install_fake_fetcher(monkeypatch, {"openai-codex": _codex_snapshot()})

    response = make_client().get("/api/plugins/usage-stats/account_usage")

    assert response.status_code == 200
    snaps = response.json()["snapshots"]
    assert len(snaps) == 1
    snap = snaps[0]
    assert snap["provider"] == "openai-codex"
    assert snap["plan"] == "Plus"
    # mapGatewayProviders() reads windows[].label + used_percent and renders
    # reset countdowns from resetsAt — both must be present and JSON-safe.
    assert [(w["label"], w["used_percent"]) for w in snap["windows"]] == [("Session", 8.0), ("Weekly", 76.0)]
    for window in snap["windows"]:
        datetime.fromisoformat(window["resetsAt"])  # parses, ISO-8601
    # upstream details survive, and the per-window summary lines are appended
    assert snap["details"][0] == "You have 1 reset credit banked"
    assert any(w["label"] in line for line in snap["details"][1:] for w in snap["windows"])


def test_account_usage_skips_unavailable_and_raising_providers(monkeypatch):
    def raise_fetcher(provider, *, base_url=None, api_key=None):
        if provider == "anthropic":
            raise RuntimeError("upstream exploded")
        return None  # no credential → Hermes fetcher returns None

    fake = types.ModuleType("agent.account_usage")
    setattr(fake, "fetch_account_usage", raise_fetcher)
    sys.modules.setdefault("agent", types.ModuleType("agent"))
    sys.modules["agent.account_usage"] = fake
    plugin_api._account_usage_cache.clear()

    response = make_client().get("/api/plugins/usage-stats/account_usage")

    assert response.status_code == 200
    assert response.json() == {"snapshots": []}


def test_account_usage_drops_unavailable_snapshots(monkeypatch):
    snap = _codex_snapshot()
    snap.available = False
    install_fake_fetcher(monkeypatch, {"openai-codex": snap})

    response = make_client().get("/api/plugins/usage-stats/account_usage")

    assert response.json()["snapshots"] == []


def test_account_usage_is_cached_for_45s(monkeypatch):
    calls = install_fake_fetcher(monkeypatch, {"openai-codex": _codex_snapshot()})
    client = make_client()

    first = client.get("/api/plugins/usage-stats/account_usage").json()
    second = client.get("/api/plugins/usage-stats/account_usage").json()

    assert first == second
    # two providers probed once each; second request served purely from cache
    assert calls == ["openai-codex", "anthropic"]
