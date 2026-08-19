import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_dashboard_manifest_is_api_only_and_loadable():
    manifest = json.loads((ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8"))

    assert manifest["name"] == "opencode-usage"
    assert manifest["api"] == "plugin_api.py"
    assert manifest["tab"]["hidden"] is True
    assert (ROOT / "dashboard" / manifest["entry"]).is_file()


def test_agent_manifest_uses_a_supported_kind_and_registration_shim():
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    package = (ROOT / "__init__.py").read_text(encoding="utf-8")

    assert "name: usage-stats" in text
    assert "kind: standalone" in text
    assert "def register(ctx)" in package


def test_unified_desktop_plugin_is_the_only_desktop_source():
    assert (ROOT / "desktop" / "plugin.js").is_file()
    assert not (ROOT / "desktop-plugins").exists()

    source = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    assert "const ID = 'usage-stats'" in source
    assert "ctx.rest" in source
    assert "area: 'statusBar.right'" in source
    assert "render:" in source
    assert "host.request('plugin.rest'" not in source
    assert "kind: 'status-bar'" not in source
    assert "component:" not in source
