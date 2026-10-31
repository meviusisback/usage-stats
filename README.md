<div align="center">

# usage-stats

**Your model spend, in the Hermes status bar.** One chip shows the usage or balance of the provider behind your active model — OpenCode, OpenRouter, DeepSeek, Kimi, NovitaAI, ZAI, Alibaba, Arcee, plus gateway-native Claude, Codex, Cursor and Nous.

[![License: MIT](https://img.shields.io/github/license/meviusisback/usage-stats)](LICENSE)
![Linux](https://img.shields.io/badge/linux-supported-1793d1)

</div>

## Why it exists

Every provider hides its numbers in a different dashboard, and you only ever care about the one backing your current model. usage-stats puts that single number where you already look — the Desktop status bar — and hides itself when the active provider has nothing to report.

| Read | Decide | Delegate |
|---|---|---|
| One chip: `% used + reset time` or `$ balance` for the active provider | Click the chip for a popover of every provider with data | OpenCode three-window split (5h / week / month) so a quiet window never hides a busy one |
| Switches automatically when you change models | Right-click to refresh or configure keys | Reset countdowns per window, computed at render time |
| Unsupported provider → chip hides, never blocks the bar | Key dialog copies `KEY=VALUE` lines to your local clipboard only | Parallel fetch via thread pool, resilient per-provider errors |

Example chip text:

```text
OC 5h 40% (3h) · W 64% (2d) · M 38% (12d)
OR $1.82
DS $6.90
```

## What it does

- **Model-gated display** — the chip shows only the active model's provider, switches automatically on model change (60s safety poll). Unsupported provider → chip hidden.
- **Click widget** — left-click opens a small popover with every provider that has data (configured key or gateway-native); unconfigured ones are omitted. Active provider highlighted; hover a row for details.
- **OpenCode three-window split** — rolling (5h), weekly, monthly usage percentages with color thresholds (green / accent / red).
- **Reset countdowns per window** — each OpenCode window shows its time-to-reset inline (`5h 79% (2d)`; minutes under an hour, hours under 48h, days beyond). Windows without a usable `resetsAt` simply omit it.
- **Right-click menu** — `↻ Refresh` (force refresh) and `⚙ Configure keys` (open the key dialog).
- **⌘K command** — `Usage Stats: Configure keys` opens the key dialog directly.
- **Key config dialog** — on first run (no provider key configured) a popup opens with masked `password` inputs for all 8 providers. Copying writes the formatted `KEY=VALUE` lines to the **local clipboard only** — never over the network.
- **Resilient error handling** — distinguishes missing API key, HTTP 403, and network errors in the tooltip; never blocks the status bar.
- **Parallel fetch** — all providers queried concurrently via a thread pool.
- **Secure** — the backend never returns API keys or upstream headers, only sanitized usage numbers; `/summary` returns only a boolean `apiKeyConfigured` map.

## Install

Clone the **whole repository** into the active profile's plugin directory. Do not copy only `desktop/plugin.js`: the Python API half and `dashboard/manifest.json` are required.

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

Named profiles: run the commands against that profile — the plugin must physically exist under the same profile home, e.g. `~/.hermes/profiles/coder/plugins/usage-stats/`.

```bash
hermes --profile coder plugins enable usage-stats
```

## First run in three steps

1. Add the API keys you use to the active profile's `.env` (see Configuration), then fully quit and reopen Hermes Desktop (⌘Q) so the backend reloads `.env`.
2. Add `usage-stats` to `plugins.enabled` in `config.yaml` and restart the Hermes dashboard/backend; then enable **Usage Stats** under Settings → Plugins.
3. The chip appears for the active model — left-click it for the full provider overview.

## Requirements

- A recent Hermes Agent / Hermes Desktop release with the Desktop Plugin SDK
- API keys for whichever providers you want to track (add only what you use)
- The same Hermes profile selected by Desktop and by the backend

## Configuration

Two ways to set keys (backend reads them from the process environment at startup, populated by `~/.hermes/.env`):

1. **Manually** — add to the active profile's `.env`:

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

2. **Via the in-app dialog** — on first run (or right-click chip → `⚙ Configure keys`, or ⌘K → `Usage Stats: Configure keys`): enter keys in the masked inputs and click **Copy to clipboard**, then paste into `~/.hermes/.env`. The dialog only auto-opens when **no** provider key is configured — a single key (any provider) suppresses it.

> Keys are only picked up after the Hermes backend starts. Fully quit and reopen Hermes Desktop (⌘Q) after editing `.env`.

Backend half needs `usage-stats` in `plugins.enabled` in `config.yaml` (the in-app Desktop toggle alone is not enough), plus a backend restart. A plain "Reload desktop plugins" may not be enough after replacing a plugin file, especially with macOS Desktop connected to an OrbStack/Linux backend — copy the full repo into the Linux VM (`/home/<user>/.hermes/plugins/usage-stats/`) and the Desktop half to the Mac-local plugin dir; do not symlink it.

## How it works

Two coordinated halves: `desktop/plugin.js` (status-bar chip) and `dashboard/plugin_api.py` (authenticated backend proxy at `/api/plugins/usage-stats`).

| Source | Providers | Needs a key? | Mechanism |
|--------|-----------|--------------|-----------|
| **Key-based** (Python backend) | OpenCode Go/Zen, OpenRouter, DeepSeek, Kimi, NovitaAI, ZAI, Alibaba, Arcee | ✅ yes (`.env`) | `rest('/summary')` → backend calls each vendor API |
| **Gateway-native** (no backend) | Claude/Anthropic, Codex, Cursor, Kimi, OpenRouter, Nous | ❌ no | Reads `account.usage` / `usage.bars` RPCs directly |

| Display | Provider | Metric |
|---------|----------|--------|
| `OC` | OpenCode Go (+ Zen, same account) | % used + reset time (5h / week / month) |
| `OR` | OpenRouter | USD credits remaining |
| `DS` | DeepSeek | USD balance |
| `KI` | Kimi / Moonshot | CNY balance |
| `NV` | NovitaAI | USD balance |
| `Z`  | ZAI / Zhipu | CNY balance |
| `AB` | Alibaba / DashScope | CNY usage |
| `AR` | Arcee AI | USD balance |

Not supported (no public usage/balance API): Anthropic, OpenAI, Fireworks, xAI, NVIDIA NIM, Gemini, Minimax, StepFun, Tencent, Xiaomi, Nous, Ollama, LM Studio, GitHub Copilot, Bedrock, Vertex, Azure, CommandCode, and all OAuth/local providers. These return `null` in the chip but never crash it.

Verify the backend after install: `GET /api/plugins/usage-stats/health` → `{"status":"ok","api_key_configured":true}`, and `GET /api/plugins/usage-stats/summary` for all providers. If the chip reports `404: {"detail":"Plugin not found"}`, check the repo is complete at `$HERMES_HOME/plugins/usage-stats`, `dashboard/manifest.json` exists, `usage-stats` is in `plugins.enabled`, the backend was restarted, and Desktop and backend use the same profile.

## Contributing

```bash
python -m pytest tests -q --ignore=tests/desktop_pure.test.mjs
node --test tests/desktop_pure.test.mjs
python -m py_compile dashboard/plugin_api.py
```

## Removal

```bash
rm -rf "${HERMES_HOME:-$HOME/.hermes}/plugins/usage-stats"
```

Then remove `usage-stats` from `plugins.enabled` in `config.yaml`, restart the backend, and fully quit and reopen Hermes Desktop. Your `.env` keys are untouched — delete them manually if you want a full purge.

## License

MIT — see [LICENSE](LICENSE).
