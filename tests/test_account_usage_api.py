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

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
MODULE_NAME = "usage_stats_test_account_usage"
SPEC = importlib.util.spec_from_file_location(MODULE_NAME, ROOT / "dashboard" / "plugin_api.py")
assert SPEC and SPEC.loader
plugin_api = importlib.util.module_from_spec(SPEC)
sys.modules[MODULE_NAME] = plugin_api
SPEC.loader.exec_module(plugin_api)


@pytest.fixture(autouse=True)
def _reset_account_usage_cache():
    """`/account_usage` caches for 45s; without this the first test's
    response leaks into every later /account_usage test."""
    plugin_api._account_usage_cache.clear()
    yield
    plugin_api._account_usage_cache.clear()


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
    per provider slug, and report which slugs were asked.  Scoped through
    ``monkeypatch`` so the stub never leaks into other test modules."""
    calls = []

    def fetch(provider, *, base_url=None, api_key=None):
        calls.append(provider)
        return snapshots.get(provider)

    # plugin_api imports `from agent.account_usage import fetch_account_usage`
    # at call time inside the route — a stub module in sys.modules satisfies it.
    fake = types.ModuleType("agent.account_usage")
    setattr(fake, "fetch_account_usage", fetch)
    if "agent" not in sys.modules:
        monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.account_usage", fake)
    plugin_api._account_usage_cache.clear()
    return calls


def install_fake_fetcher_fn(monkeypatch, fetch):
    """Same, but with a caller-supplied fetch function (raising fakes)."""
    fake = types.ModuleType("agent.account_usage")
    setattr(fake, "fetch_account_usage", fetch)
    if "agent" not in sys.modules:
        monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.account_usage", fake)
    plugin_api._account_usage_cache.clear()


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

    install_fake_fetcher_fn(monkeypatch, raise_fetcher)

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
    # two providers probed once each (parallel fetch: order not guaranteed);
    # second request served purely from cache
    assert sorted(calls) == ["anthropic", "openai-codex"]


def test_account_usage_cache_expires_after_ttl(monkeypatch):
    install_fake_fetcher(monkeypatch, {"openai-codex": _codex_snapshot()})
    client = make_client()
    client.get("/api/plugins/usage-stats/account_usage")

    # rewind the cache entry past the TTL → next request re-fetches
    (stamp, payload) = plugin_api._account_usage_cache["account_usage"]
    plugin_api._account_usage_cache["account_usage"] = (
        stamp - plugin_api.ACCOUNT_USAGE_TTL_SECONDS - 1, payload)

    calls2 = install_fake_fetcher(monkeypatch, {"openai-codex": _codex_snapshot()})
    client.get("/api/plugins/usage-stats/account_usage")
    assert sorted(calls2) == ["anthropic", "openai-codex"]


def test_account_usage_clamps_nonfinite_percents(monkeypatch):
    import math

    reset = datetime.now(timezone.utc) + timedelta(hours=4)
    snap = FakeSnapshot("openai-codex", [
        FakeWindow("Session", float("inf"), reset),
        FakeWindow("Weekly", float("nan"), reset),
        FakeWindow("Typed", "12.5", reset),  # numeric strings still coerce
    ], details=(), plan="Plus")
    install_fake_fetcher(monkeypatch, {"openai-codex": snap})

    response = make_client().get("/api/plugins/usage-stats/account_usage")

    assert response.status_code == 200  # audit L1: no 500 on hostile percents
    [out] = response.json()["snapshots"]
    assert [w["used_percent"] for w in out["windows"]] == [None, None, 12.5]
    # only the finite window earns a summary line
    assert len(out["details"]) == 1 and "Typed" in out["details"][0]


def test_account_usage_skips_malformed_snapshot_keeps_healthy(monkeypatch):
    class BadSnapshot:
        # hostile shape: attribute access itself explodes, so conversion
        # must fail inside the per-provider guard — never as a route 500.
        provider = "anthropic"
        available = True

        @property
        def windows(self):
            raise TypeError("hostile windows")

        details = ()
        plan = None
        title = "t"

    install_fake_fetcher(monkeypatch, {
        "openai-codex": _codex_snapshot(),
        "anthropic": BadSnapshot(),
    })

    response = make_client().get("/api/plugins/usage-stats/account_usage")

    # audit L1: malformed provider skipped, healthy snapshot survives
    assert response.status_code == 200
    assert [s["provider"] for s in response.json()["snapshots"]] == ["openai-codex"]


def test_account_usage_serves_stale_cache_when_poll_fails(monkeypatch):
    install_fake_fetcher(monkeypatch, {"openai-codex": _codex_snapshot()})
    client = make_client()
    first = client.get("/api/plugins/usage-stats/account_usage").json()
    assert len(first["snapshots"]) == 1

    def fail_all(provider, *, base_url=None, api_key=None):
        raise RuntimeError("upstream down")

    # install the failing fetcher first (it clears the cache), then restore
    # the good payload as an EXPIRED entry → poll fails, stale entry served
    install_fake_fetcher_fn(monkeypatch, fail_all)
    import time

    plugin_api._account_usage_cache["account_usage"] = (
        time.monotonic() - plugin_api.ACCOUNT_USAGE_TTL_SECONDS - 1, first)
    second = client.get("/api/plugins/usage-stats/account_usage").json()
    assert second == first
