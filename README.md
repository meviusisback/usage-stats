# Usage Stats for Hermes Agent

A unified Hermes Agent plugin that shows **usage / balance** for the provider
backing the currently-selected model, directly in the Hermes Desktop status bar:

```text
OC 5h 40% (3h) · W 64% (2d) · M 38% (12d)   (OpenCode Go — rolling / weekly /
                                             monthly windows, with time-to-reset)
OR $1.82                                    (OpenRouter — credits remaining)
DS $6.90                                    (DeepSeek — account balance)
KI ¥0.00                                    (Kimi / Moonshot)
NV $—                                       (NovitaAI)
Z ¥—                                        (ZAI / Zhipu)
AB ¥—                                       (Alibaba / DashScope)
AR $—                                       (Arcee AI)
```

The chip is **model-gated**: it shows only the provider of the active model
and switches automatically when you change models in the composer. If the
active provider is not one of the supported ones (e.g. Anthropic, OpenAI),
the chip hides itself.

It contains two coordinated halves:

- `desktop/plugin.js` — the Desktop status-bar chip (React + Desktop Plugin SDK)
- `dashboard/plugin_api.py` — the authenticated backend proxy mounted at
  `/api/plugins/usage-stats`

## Supported providers

| Display | Provider | Metric | Endpoint (key) |
|---------|----------|--------|----------------|
| `OC` | OpenCode Go (+ Zen, same account) | % used + reset time (5h / week / month windows) | `opencode.ai/zen/go/v1/usage` (`OPENCODE_GO_API_KEY`) |
| `OR` | OpenRouter | USD credits remaining | `openrouter.ai/api/v1/credits` (`OPENROUTER_API_KEY`) |
| `DS` | DeepSeek | USD balance | `api.deepseek.com/user/balance` (`DEEPSEEK_API_KEY`) |
| `KI` | Kimi / Moonshot | CNY balance | `api.moonshot.cn/v1/users/me/balance` (`KIMI_API_KEY` / `MOONSHOT_API_KEY`) |
| `NV` | NovitaAI | USD balance | `api.novita.ai/v3/account/balance` (`NOVITA_API_KEY`) |
| `Z`  | ZAI / Zhipu | CNY balance | `open.bigmodel.cn/api/paas/v4/user/balance` (`ZAI_API_KEY`) |
| `AB` | Alibaba / DashScope | CNY usage | `dashscope.aliyuncs.com/.../billing/usage` (`DASHSCOPE_API_KEY`) |
| `AR` | Arcee AI | USD balance | `api.arcee.ai/v2/user/balance` (`ARCEE_API_KEY`) |

> **Not supported (no public usage/balance API):** Anthropic, OpenAI,
> Fireworks, xAI, NVIDIA NIM, Gemini (Google Cloud billing only), Minimax,
> StepFun, Tencent, Xiaomi, Nous, Ollama, LM Studio, GitHub Copilot, Bedrock,
> Vertex, Azure, CommandCode (proxy UI billing only), and all OAuth/local
> providers. These return `null` in the chip but never crash it.

## How it works (hybrid design)

The chip merges **two** data sources so you see every provider you actually use:

| Source | Providers | Needs a key? | Mechanism |
|--------|-----------|--------------|-----------|
| **Key-based** (Python backend) | OpenCode Go/Zen, OpenRouter, DeepSeek, Kimi, NovitaAI, ZAI, Alibaba, Arcee | ✅ yes (`.env`) | `rest('/summary')` → backend calls each vendor API |
| **Gateway-native** (no backend) | Claude/Anthropic, Codex, Cursor, Kimi, OpenRouter, Nous | ❌ no | reads `account.usage` / `usage.bars` RPCs directly |

The gateway already holds credentials for the second group (OAuth tokens, cred
pools), so their usage shows with **no configuration at all**. Only the
key-based group requires adding API keys to `~/.hermes/.env`.

The chip is **strictly model-gated**: it shows ONLY the provider of the active
model and switches automatically when you change models. If the active model
runs on an unsupported/unconfigured provider, the chip hides itself — it never
shows a list of unrelated providers.

**Left-click the chip** for the overview: a small popover listing every
provider that actually reports data (key configured in `.env`, or
gateway-native). Providers without a configured key are never shown. The
active model's provider row is highlighted.

## Features

- **Model-gated display** — the chip shows only the active model's provider,
  switches automatically on model change (60s safety poll). Unsupported
  provider → chip hidden.
- **Click widget** — left-click opens a small popover with every provider
  that has data (configured key or gateway-native); unconfigured ones are
  omitted. Active provider highlighted; hover a row for details. Windowed
  providers (OpenCode) show ALL their windows in the row — `5h 0% · W 79% ·
  M 46%` — not a single headline, so a quiet rolling window never hides
  busy weekly/monthly usage.
- **OpenCode three-window split** — rolling (5h), weekly, monthly usage
  percentages with color thresholds (green / accent / red).
- **Reset countdowns per window** — each OpenCode window shows its
  time-to-reset inline: `5h 79% (2d)`. Minutes under an hour, hours under 48h,
  days beyond (`now` once the timestamp passes). The hover tooltip spells it
  out ("resets in 2d"). Computed at render time and refreshed on every poll,
  so it never goes stale. Windows without a usable `resetsAt` simply omit it.
- **Right-click menu** on the chip: `↻ Refresh` (force refresh) and
  `⚙ Configure keys` (open the key dialog).
- **⌘K command** — `Usage Stats: Configure keys` opens the key dialog directly.
- **Key config dialog** — on first run (no provider key configured) a popup
  opens with masked `password` inputs for all 8 providers. Copying the entered
  keys writes the formatted `KEY=VALUE` lines to the **local clipboard only**
  (via `navigator.clipboard` / the Desktop clipboard bridge) — **never over the
  network**. You then paste them into `~/.hermes/.env` yourself.
- **Resilient error handling** — distinguishes missing API key, HTTP 403, and
  network errors in the tooltip; never blocks the status bar.
- **Parallel fetch** — all providers are queried concurrently via a thread
  pool (no 45s sequential worst case).
- **Secure** — the backend never returns API keys or upstream headers; it only
  forwards sanitized usage numbers. The config dialog never transmits a key to
  the backend; `/summary` returns only a boolean `apiKeyConfigured` map.

## Requirements

- A recent Hermes Agent / Hermes Desktop release with the Desktop Plugin SDK
- API keys for whichever providers you want to track (add only what you use)
- The same Hermes profile selected by Desktop and by the backend

## Install

### Standard installation

Clone the **whole repository** into the active profile's plugin directory. Do
not copy only `desktop/plugin.js`: the Python API half and
`dashboard/manifest.json` are required.

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
git clone https://github.com/meviusisback/usage-stats.git \
  "$HERMES_HOME/plugins/usage-stats"
hermes plugins enable usage-stats
```

If the destination already exists, update it instead:

```bash
git -C "${HERMES_HOME:-$HOME/.hermes}/plugins/usage-stats" pull --ff-only
hermes plugins enable usage-stats
```

### Named profiles

Run the commands against that profile, or set `HERMES_HOME` to its directory:

```bash
hermes --profile coder plugins enable usage-stats
```

The plugin must physically exist under the same profile home, e.g.
`~/.hermes/profiles/coder/plugins/usage-stats/`.

## Configure the API keys

You can configure keys two ways:

1. **Manually** — add them to the active profile's `.env` (the backend reads
   keys from the process environment at startup, populated by `~/.hermes/.env`):

```bash
# ~/.hermes/.env  (or ~/.hermes/profiles/<name>/.env for a named profile)
OPENCODE_GO_API_KEY=your-key-here
OPENROUTER_API_KEY=your-key-here
DEEPSEEK_API_KEY=your-key-here
KIMI_API_KEY=your-key-here
NOVITA_API_KEY=your-key-here
ZAI_API_KEY=your-key-here
DASHSCOPE_API_KEY=your-key-here
ARCEE_API_KEY=your-key-here
```

2. **Via the in-app dialog** — on first run (or via right-click chip →
   `⚙ Configure keys`, or ⌘K → `Usage Stats: Configure keys`), enter the
   keys in the masked inputs and click **Copy to clipboard**. The plugin
   copies the `KEY=VALUE` lines to your **local clipboard only** (never over the
   network); paste them into `~/.hermes/.env`. The dialog only auto-opens when
   **no** provider key is configured — a single key (any provider) suppresses
   it.

> **Important:** keys are only picked up after the Hermes backend starts. If
> you add a key to `.env` (or via the clipboard) while Hermes is running, fully
> quit and reopen Hermes Desktop (⌘Q) so the backend reloads `.env`.

The backend also accepts keys from its process environment.

## Restart and enable the Desktop half

Backend API routes are mounted only when the Hermes backend/dashboard starts,
**and only if the plugin is listed in `plugins.enabled`** in `config.yaml`
(the in-app Desktop toggle alone is not enough for the backend half).

1. Add `usage-stats` to `plugins.enabled` in the relevant `config.yaml`.
2. Restart the Hermes dashboard/backend used by Desktop.
3. Fully quit and reopen Hermes Desktop (⌘Q, not just "Reload desktop plugins").
4. Open **Settings → Plugins** and enable **Usage Stats** under Desktop plugins.

A plain "Reload desktop plugins" may not be enough after replacing an existing
plugin file, especially with macOS Desktop connected to an OrbStack/Linux
backend.

## macOS Desktop + OrbStack/Linux backend

The backend and Desktop plugin roots are on different machines/filesystems:

- Linux VM backend: `/home/<user>/.hermes/plugins/usage-stats/`
- macOS Desktop: `/Users/<user>/.hermes/plugins/usage-stats/`

Install the full repository in the Linux VM, then copy the Desktop half to the
Mac-local unified plugin door:

```bash
rsync -a --exclude '.git' --exclude '__pycache__' \
  /Users/<user>/OrbStack/<vm>/home/<user>/.hermes/plugins/usage-stats/ \
  /Users/<user>/.hermes/plugins/usage-stats/

# or just the changed frontend:
cp /Users/<user>/OrbStack/<vm>/home/<user>/.hermes/plugins/usage-stats/desktop/plugin.js \
  /Users/<user>/.hermes/plugins/usage-stats/desktop/plugin.js
```

Do not symlink it; the Desktop loader does not reliably follow plugin
symlinks. Fully quit and reopen Hermes Desktop after copying.

## Verify

The backend health route should return JSON after authentication:

```text
GET /api/plugins/usage-stats/health
```

Expected body:

```json
{"status":"ok","api_key_configured":true}
```

The summary route (all providers) is:

```text
GET /api/plugins/usage-stats/summary
```
```json
{
  "providers": [
    {
      "id": "opencode", "display": "OC", "label": "40%",
      "windows": [
        { "id": "rolling", "label": "5h", "percent": 40.0, "resetsAt": "2026-08-21T12:28:19.883Z" },
        { "id": "weekly",  "label": "W",  "percent": 64.0, "resetsAt": "2026-08-24T00:00:00.883Z" },
        { "id": "monthly", "label": "M",  "percent": 38.0, "resetsAt": "2026-09-06T17:06:53.883Z" }
      ]
    }
  ],
  "apiKeyConfigured": { "opencode": true, "openrouter": false, "deepseek": true }
}
```

`windows[].resetsAt` is the upstream ISO-8601 UTC reset timestamp; the chip
renders it as a compact countdown. It is `null` when upstream omits it.

A per-provider legacy route is also available at `/usage`.

If the chip reports `404: {"detail":"Plugin not found"}`, check all of these:

- the complete repository is at `$HERMES_HOME/plugins/usage-stats`
- `dashboard/manifest.json` exists and declares `"api": "plugin_api.py"`
- `usage-stats` is in `plugins.enabled`
- the backend was restarted after installation
- Desktop and backend are using the same profile

## Development and tests
```bash
python -m pytest tests -q --ignore=tests/desktop_pure.test.mjs
node --test tests/desktop_pure.test.mjs
python -m py_compile dashboard/plugin_api.py
```

`desktop_pure.test.mjs` slices the dependency-free pure functions out of
`desktop/plugin.js` (model gating, reset countdown) AND re-imports the whole
plugin as strict ESM after loader-style specifier rewriting — Hermes loads
door plugins as blob modules (always ESM), where plain `node --check` on the
`.js` file can give a false pass on unbalanced-bracket states.


The backend sanitizes the upstream response and returns only the documented
usage/balance fields; it never returns the API key or request headers.

## License

MIT
