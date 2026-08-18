# OpenCode Usage for Hermes Agent

A unified Hermes Agent plugin that shows OpenCode Go usage in the Hermes Desktop status bar:

```text
OC 5h 39% · W 15% · M 13%
```

It contains two coordinated halves:

- `desktop/plugin.js` — the Desktop status-bar chip
- `dashboard/plugin_api.py` — the authenticated backend proxy mounted at `/api/plugins/opencode-usage`

## Requirements

- A recent Hermes Agent/Hermes Desktop release with the Desktop Plugin SDK
- An OpenCode Go API key
- The same Hermes profile selected by Desktop and by the backend

## Install

### Standard installation

Clone the **whole repository** into the active profile's plugin directory. Do not copy only `desktop/plugin.js`: the Python API half and `dashboard/manifest.json` are required.

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
git clone https://github.com/meviusisback/opencode-usage-v2.git \
  "$HERMES_HOME/plugins/opencode-usage"
hermes plugins enable opencode-usage
```

If the destination already exists, update it instead:

```bash
git -C "${HERMES_HOME:-$HOME/.hermes}/plugins/opencode-usage" pull --ff-only
hermes plugins enable opencode-usage
```

### Named profiles

Run the commands against that profile, or set `HERMES_HOME` to its directory:

```bash
hermes --profile coder plugins enable opencode-usage
```

The plugin must physically exist under the same profile home, for example:

```text
~/.hermes/profiles/coder/plugins/opencode-usage/
```

## Configure the API key

Add the key to the active profile's `.env`:

```bash
OPENCODE_GO_API_KEY=your-key-here
```

For the default profile this is `~/.hermes/.env`; for a named profile it is `~/.hermes/profiles/<name>/.env`.

The backend also accepts `OPENCODE_GO_API_KEY` from its process environment.

## Restart and enable the Desktop half

Backend API routes are mounted only when the Hermes backend/dashboard starts. After installing or updating:

1. Restart the Hermes dashboard/backend used by Desktop.
2. Fully quit and reopen Hermes Desktop.
3. Open **Settings → Plugins** and enable **OpenCode Usage** under Desktop plugins.

A simple “Reload desktop plugins” may not be enough after replacing an existing plugin file, especially with macOS Desktop connected to an OrbStack/Linux backend.

## macOS Desktop + OrbStack/Linux backend

The backend and Desktop plugin roots are on different machines/filesystems:

- Linux VM backend: `/home/<user>/.hermes/plugins/opencode-usage/`
- macOS Desktop: `/Users/<user>/.hermes/plugins/opencode-usage/desktop/plugin.js`

Install the full repository in the Linux VM, then copy the Desktop half to the Mac-local unified plugin door:

```bash
mkdir -p /Users/<user>/.hermes/plugins/opencode-usage/desktop
cp /Users/<user>/OrbStack/<vm>/home/<user>/.hermes/plugins/opencode-usage/desktop/plugin.js \
  /Users/<user>/.hermes/plugins/opencode-usage/desktop/plugin.js
```

Do not symlink it; the Desktop loader does not reliably follow plugin symlinks. Fully quit and reopen Hermes Desktop after copying.

## Verify

The backend health route should return JSON after authentication:

```text
GET /api/plugins/opencode-usage/health
```

Expected body:

```json
{"status":"ok","api_key_configured":true}
```

The usage route is:

```text
GET /api/plugins/opencode-usage/usage
```

If the chip reports `404: {"detail":"Plugin not found"}`, check all of these:

- the complete repository is at `$HERMES_HOME/plugins/opencode-usage`
- `dashboard/manifest.json` exists and declares `"api": "plugin_api.py"`
- `opencode-usage` is in `plugins.enabled`
- the backend was restarted after installation
- Desktop and backend are using the same profile

## Development and tests

```bash
python -m pytest tests -q
node --check desktop/plugin.js
python -m py_compile dashboard/plugin_api.py
```

The backend sanitizes the upstream response and returns only the documented usage-window fields; it never returns the API key or request headers.

## License

MIT
