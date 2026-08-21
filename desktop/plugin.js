/**
 * Usage Stats — Hermes Desktop status-bar plugin (multi-provider, model-gated).
 *
 * Shows usage/balance for ONLY the provider backing the currently-selected
 * model, and switches automatically when the model changes.
 *
 * Two data sources, merged into one model-gated chip:
 *
 *  1. KEY-BASED providers (OpenCode, OpenRouter, DeepSeek, Kimi, NovitaAI,
 *     ZAI, Alibaba, Arcee) — fetched by the Python backend via `rest('/summary')`.
 *     These need an API key in ~/.hermes/.env.
 *
 *  2. GATEWAY-NATIVE providers (Claude/Anthropic, Codex, Cursor, Kimi,
 *     OpenRouter, Nous) — read DIRECTLY from the gateway RPCs
 *     `account.usage` / `usage.bars`. The gateway already holds their
 *     credentials, so NO API key or backend is needed for these. This mirrors
 *     the technique used by the resetwatch plugin.
 *
 * Right-click the chip: "Refresh" / "Hide" / "Configure keys".
 * Re-show: ⌘K → "Usage Stats: Show".
 *
 * The "Configure keys" dialog collects them in masked password inputs and
 * copies the formatted `KEY=VALUE` lines to the local clipboard (or the
 * Desktop's native clipboard bridge) — the user pastes them into ~/.hermes/.env
 * themselves. No key ever leaves the local machine via a plugin request.
 */
import {
  Tip, cn, host, useValue,
  ContextMenu, ContextMenuTrigger, ContextMenuContent,
  ContextMenuItem, ContextMenuSeparator,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Input,
  Popover, PopoverContent, PopoverTrigger,
  PALETTE_AREA,
} from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const ID = 'usage-stats'
const REFRESH_MS = 60_000

// Provider → list of .env keys the plugin looks for (first match wins).
// `name` is shown in the config dialog; `autoKey` is the canonical key name.
const KEY_SPECS = [
  { id: 'opencode', name: 'OpenCode Go', autoKey: 'OPENCODE_GO_API_KEY', altKeys: ['OPENCODE_ZEN_API_KEY'] },
  { id: 'openrouter', name: 'OpenRouter', autoKey: 'OPENROUTER_API_KEY', altKeys: [] },
  { id: 'deepseek', name: 'DeepSeek', autoKey: 'DEEPSEEK_API_KEY', altKeys: [] },
  { id: 'kimi', name: 'Kimi / Moonshot', autoKey: 'KIMI_API_KEY', altKeys: [] },
  { id: 'novita', name: 'NovitaAI', autoKey: 'NOVITA_API_KEY', altKeys: [] },
  { id: 'zai', name: 'ZAI / Zhipu', autoKey: 'ZAI_API_KEY', altKeys: ['GLM_API_KEY'] },
  { id: 'alibaba', name: 'Alibaba / DashScope', autoKey: 'DASHSCOPE_API_KEY', altKeys: [] },
  { id: 'arcee', name: 'Arcee AI', autoKey: 'ARCEE_API_KEY', altKeys: [] },
]

// Gateway-native provider slugs (from account.usage / config) → display info.
// These are read without any API key (the gateway holds the credentials).
const GATEWAY_PROVIDERS = {
  anthropic: { display: 'CL', name: 'Claude' },
  'openai-codex': { display: 'CX', name: 'Codex' },
  codex: { display: 'CX', name: 'Codex' },
  cursor: { display: 'CU', name: 'Cursor' },
  kimi: { display: 'KI', name: 'Kimi' },
  openrouter: { display: 'OR', name: 'OpenRouter' },
  nous: { display: 'NO', name: 'Nous' },
}

function percentTone(value) {
  if (value == null) return 'var(--ui-text-quaternary)'
  if (value >= 90) return 'var(--destructive)'
  if (value >= 70) return 'var(--ui-accent)'
  return 'var(--ui-text-secondary)'
}

function balanceTone(value) {
  if (value == null) return 'var(--ui-text-quaternary)'
  if (value < 1) return 'var(--destructive)'
  if (value < 3) return 'var(--ui-accent)'
  return 'var(--ui-text-secondary)'
}

// Map a model config (provider slug + base_url) to a provider id the chip knows.
// The slug is matched by substring (short, controlled string); a base_url is
// matched only against its HOSTNAME so a path like '/kimi-route' on an
// unrelated proxy cannot map the model to the wrong provider.
const _PROVIDER_TOKENS = [
  ['opencode', ['opencode']],
  ['openrouter', ['openrouter']],
  ['deepseek', ['deepseek']],
  ['kimi', ['kimi', 'moonshot']],
  ['anthropic', ['anthropic', 'claude']],
  ['openai-codex', ['codex']],
  ['cursor', ['cursor']],
  ['nous', ['nous']],
  ['zai', ['zai', 'glm', 'zhipu', 'bigmodel', 'z.ai']],
  ['novita', ['novita']],
  ['alibaba', ['dashscope', 'alibaba', 'aliyuncs']],
  ['arcee', ['arcee']],
]

function providerIdFor(provider, baseUrl) {
  for (const value of [provider, baseUrl]) {
    if (!value) continue
    const raw = String(value).toLowerCase()
    // base_url: match the host only; bare slugs have no URL structure.
    let scope = raw
    if (raw.includes('://')) {
      try { scope = new URL(raw).host } catch { continue }
    }
    for (const [id, tokens] of _PROVIDER_TOKENS) {
      if (tokens.some((t) => scope.includes(t))) return id
    }
  }
  return null
}

// Compact time-to-reset: "<1m"/"38m" under an hour, "5h" under 48h, "2d" beyond.
// Computed at render time — the chip re-renders on every poll (60s), so the
// countdown self-corrects. Returns null when the window has no reset time.
function resetCountdown(resetsAt) {
  if (!resetsAt) return null
  const t = Date.parse(resetsAt)
  if (!Number.isFinite(t)) return null
  const ms = t - Date.now()
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.round(hours / 24)
  // Sentinel/far-future timestamps would render '(2927702d)' — treat as none.
  if (days > 365) return null
  return `${days}d`
}

// Per-window value parts for the widget row: OpenCode's headline is the
// rolling window, which is often 0% while weekly/monthly are the interesting
// ones — so rows show every window instead of one overall number.
function windowParts(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return null
  return windows.map((w) => ({
    id: w.id,
    label: w.label,
    percent: typeof w.percent === 'number' ? w.percent : null,
    text: w.percent == null ? '—' : `${Math.round(w.percent)}%`,
  }))
}

// Providers worth listing in the click-widget: everything that reports real
// data — key-based entries whose key is configured (anything else carries
// error 'no-api-key') plus gateway-native entries with actual windows. The
// user asked for configured providers ONLY; unconfigured ones never show.
function widgetProviders(allProviders) {
  return (Array.isArray(allProviders) ? allProviders : []).filter((p) =>
    p.error !== 'no-api-key' && !(p.gatewaySlug && p.kind === 'note'))
}

function WindowBadge({ w }) {
  const text = w.percent == null ? '—' : `${Math.round(w.percent)}%`
  const reset = resetCountdown(w.resetsAt)
  const tooltip = reset && reset !== 'now'
    ? `${w.label} window: ${text} used — resets in ${reset}`
    : `${w.label} window: ${text} used`
  return jsx(Tip, {
    label: tooltip,
    children: jsx('span', {
      className: 'inline-flex items-center gap-0.5 text-[0.625rem] font-mono',
      children: [
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: w.label }),
        jsx('span', { style: { color: percentTone(w.percent) }, children: text }),
        reset ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: `(${reset})` }) : null,
      ],
    }),
  })
}

function ProviderBadge({ provider }) {
  const label = provider.error ? '⚠' : (provider.label ?? '—')
  const tooltip = provider.error
    ? `${provider.name} — ${provider.error}`
    : (provider.detail || `${provider.name}: ${provider.label}`)

  return jsx(Tip, {
    label: tooltip,
    children: jsx('span', {
      className: 'inline-flex items-center gap-0.5 text-[0.625rem] font-mono',
      children: [
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: provider.display }),
        jsx('span', { style: { color: balanceTone(provider.value) }, children: label }),
      ],
    }),
  })
}

function renderProvider(provider) {
  if (provider.id === 'opencode' && Array.isArray(provider.windows) && provider.windows.length > 0) {
    const badges = [
      jsx('span', { key: 'name', className: 'font-semibold text-(--ui-text-quaternary)', children: provider.display }),
    ]
    provider.windows.forEach((w) => {
      badges.push(jsx('span', { key: `sep-${w.id}`, className: 'text-(--ui-text-quaternary)', children: '·' }))
      badges.push(jsx(WindowBadge, { key: w.id, w }))
    })
    return badges
  }
  return [jsx(ProviderBadge, { key: provider.id, provider })]
}

// One row of the click-widget: display id + name on the left, measure (or
// sanitized error) on the right. `active` highlights the provider whose
// model is currently selected in the composer.
function WidgetRow({ p, active }) {
  const parts = windowParts(p.windows)
  const value = p.error
    ? jsx('span', {
        key: 'v',
        className: 'font-mono text-[0.625rem] text-(--destructive)',
        children: `⚠ ${p.error}`,
      })
    : parts
      ? jsx('span', {
          key: 'v',
          className: 'flex items-center gap-1 font-mono text-[0.6875rem]',
          children: parts.flatMap((part, i) => {
            const item = [
              jsx('span', { key: part.id, className: 'inline-flex items-center gap-0.5', children: [
                jsx('span', { className: 'text-(--ui-text-quaternary)', children: part.label }),
                jsx('span', { style: { color: percentTone(part.percent) }, children: part.text }),
              ] }),
            return i === 0 ? item : [jsx('span', { key: `sep-${part.id}`, className: 'text-(--ui-text-quaternary)', children: '·' }), ...item]
          }),
        })
      : jsx('span', {
          key: 'v',
          className: 'font-mono text-[0.6875rem]',
          style: { color: p.kind === 'balance' ? balanceTone(p.value) : percentTone(p.value) },
          children: p.label ?? '—',
        })
  return jsx(Tip, {
    label: p.error ? `${p.name} — ${p.error}` : (p.detail || `${p.name}: ${p.label}`),
    children: jsx('div', {
      className: cn(
        'flex items-center justify-between gap-3 rounded-md px-1.5 py-1',
        active && 'bg-(--chrome-action-hover)',
      ),
      children: [
        jsx('span', {
          key: 'n',
          className: 'whitespace-nowrap text-[0.625rem]',
          children: [
            jsx('span', { key: 'd', className: 'font-mono text-(--ui-text-quaternary)', children: p.display }),
            jsx('span', { key: 's', className: 'text-(--ui-text-secondary)', children: ` ${p.name}` }),
          ],
        }),
        value,
      ],
    }),
  })
}

// --- Gateway-native: read account.usage / usage.bars (no keys needed) --------
function mapGatewayProviders(account, bars) {
  const out = []
  const snaps = (account && account.snapshots) || []
  for (const snap of snaps) {
    const slug = snap.provider
    if (!slug) continue
    const info = GATEWAY_PROVIDERS[String(slug).toLowerCase()]
    if (!info) continue
    const windows = (snap.windows || []).map((win) => ({
      id: String(win.label || '').toLowerCase(),
      label: win.label,
      percent: typeof win.used_percent === 'number' ? win.used_percent : (typeof win.remaining_percent === 'number' ? 100 - win.remaining_percent : null),
    }))
    const first = windows[0]
    out.push({
      id: 'gw:' + slug,
      gatewaySlug: slug,
      name: info.name,
      display: info.display,
      kind: windows.length ? 'percent' : 'note',
      label: first ? `${Math.round(first.percent)}%` : '—',
      value: first ? first.percent : null,
      detail: (snap.details || []).join(' · ') || `${info.name} usage`,
      windows,
      error: null,
    })
  }
  if (bars && (bars.plan_bar || bars.topup_bar)) {
    const rem = bars.plan_bar?.pct_used != null ? 100 - bars.plan_bar.pct_used : null
    out.push({
      id: 'gw:nous',
      gatewaySlug: 'nous',
      name: 'Nous Portal',
      display: 'NO',
      kind: 'percent',
      label: rem != null ? `${Math.round(rem)}%` : '—',
      value: rem,
      detail: bars.subscription_remaining_display || 'Nous Portal credits',
      windows: [],
      error: null,
    })
  }
  // A 'nous' account.snapshot and the bars-derived portal entry would both
  // emit id 'gw:nous' → duplicate React keys downstream. First one wins.
  const seen = new Set()
  return out.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
}

// --- Config dialog: masked inputs → copy to local clipboard (NEVER network) ---
function ConfigDialog({ open, onOpenChange, configured }) {
  const [values, setValues] = useState({})
  const [copied, setCopied] = useState(false)

  // Drop typed keys from memory when the dialog closes — they live on the
  // local clipboard only by design; no reason to keep them in React state.
  useEffect(() => {
    if (!open) { setValues({}); setCopied(false) }
  }, [open])

  const rows = useMemo(() => KEY_SPECS.map((spec) => ({
    ...spec,
    configured: configured ? !!configured[spec.id] : false,
  })), [configured])

  const onChange = useCallback((key, value) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setCopied(false)
  }, [])

  const copyAll = useCallback(async () => {
    const lines = KEY_SPECS
      .map((spec) => {
        const v = values[spec.autoKey]
        return v ? `${spec.autoKey}=${v}` : null
      })
      .filter(Boolean)
    if (lines.length === 0) return
    try {
      if (window.hermesDesktop?.writeClipboard) {
        await window.hermesDesktop.writeClipboard(lines.join('\n'))
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(lines.join('\n'))
      } else {
        return
      }
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }, [values])

  return jsx(Dialog, {
    open,
    onOpenChange,
    children: jsx(DialogContent, {
      className: 'max-w-md',
      children: [
        jsx(DialogHeader, {
          key: 'h',
          children: [
            jsx(DialogTitle, { key: 't', children: 'Configure provider keys' }),
            jsx(DialogDescription, {
              key: 'd',
              children: 'Keys are masked and copied to the local clipboard only — they never travel over the network. Then paste the text into ~/.hermes/.env',
            }),
          ],
        }),
        jsx('div', {
          key: 'body',
          className: 'flex flex-col gap-2 py-2',
          children: rows.map((row) => jsx('div', {
            key: row.id,
            className: 'flex flex-col gap-1',
            children: [
              jsx('label', {
                className: 'text-[0.7rem] text-(--ui-text-secondary) flex items-center gap-1',
                children: [
                  row.name,
                  row.configured ? jsx('span', { key: 'ok', className: 'text-(--ui-text-quaternary)', children: '(configured)' }) : null,
                ],
              }),
              jsx(Input, {
                type: 'password',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: row.autoKey,
                value: values[row.autoKey] ?? '',
                'data-1p-ignore': 'true',
                'data-lp-ignore': 'true',
                'data-bw-ignore': 'true',
                onChange: (e) => onChange(row.autoKey, e.target.value),
              }),
            ],
          })),
        }),
        jsx(DialogFooter, {
          key: 'f',
          children: [
            jsx('button', {
              type: 'button',
              className: cn(
                'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[0.75rem]',
                'bg-(--chrome-action) text-(--chrome-action-fg) hover:opacity-90',
              ),
              onClick: () => void copyAll(),
              children: copied ? 'Copied! ✓' : 'Copy to clipboard',
            }),
            jsx('button', {
              type: 'button',
              className: 'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[0.75rem] text-(--ui-text-secondary) hover:bg-accent',
              onClick: () => onOpenChange(false),
              children: 'Close',
            }),
          ],
        }),
      ],
    }),
  })
}

function UsageChip({ rest, storage }) {
  const [summary, setSummary] = useState(null)
  const [gatewayProviders, setGatewayProviders] = useState([])
  const [fetchError, setFetchError] = useState(null)
  const [activeProvider, setActiveProvider] = useState(null)
  const [providerResolved, setProviderResolved] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const modelSlug = useValue(host.state.model)

  useEffect(() => {
    try {
      const stored = storage?.get?.('hidden')
      if (stored) setHidden(true)
    } catch { /* storage unavailable */ }
  }, [storage])

  const checkProvider = useCallback(async () => {
    try {
      const res = await host.request('config.get', { key: 'full' })
      const modelCfg = res && typeof res === 'object' ? (res.config && res.config.model) : null
      const provider = modelCfg && typeof modelCfg === 'object' ? modelCfg.provider : null
      const baseUrl = modelCfg && typeof modelCfg === 'object' ? modelCfg.base_url : null
      setActiveProvider(providerIdFor(provider, baseUrl))
      setProviderResolved(true)
    } catch {
      setActiveProvider(null)
      setProviderResolved(false)
    }
  }, [])

  // Monotonic token: a slow/stalled refresh must never overwrite fresher
  // state written by a later tick or a manual 'Refresh' click.
  const refreshSeq = useRef(0)
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current
    const stale = () => seq !== refreshSeq.current
    try {
      if (rest) {
        const response = await rest('/summary', { method: 'GET', timeoutMs: 20_000 })
        if (stale()) return
        setSummary(response)
        setFetchError(null)
      }
    } catch (error) {
      if (stale()) return
      setFetchError(error instanceof Error ? error.message : String(error))
    }
    // Gateway-native providers — no backend, no keys.
    try {
      const [acc, bars] = await Promise.all([
        host.request('account.usage', {}).catch(() => null),
        host.request('usage.bars', {}).catch(() => null),
      ])
      if (stale()) return
      setGatewayProviders(mapGatewayProviders(acc, bars))
    } catch {
      /* gateway-native data unavailable; key-based providers still work */
    }
  }, [rest])

  useEffect(() => { void checkProvider() }, [checkProvider, modelSlug])

  useEffect(() => {
    void checkProvider()
    void refresh()
    const timer = setInterval(() => { void checkProvider(); void refresh() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [checkProvider, refresh])

  const hide = useCallback(() => {
    setHidden(true)
    try { storage?.set?.('hidden', true) } catch { /* ok */ }
  }, [storage])

  const show = useCallback(() => {
    setHidden(false)
    try { storage?.set?.('hidden', false) } catch { /* ok */ }
  }, [storage])

  useEffect(() => {
    window.__usageStatsShow = show
    window.__usageStatsOpen = () => setConfigOpen(true)
    return () => { delete window.__usageStatsShow; delete window.__usageStatsOpen }
  }, [show])

  const [autoOpened, setAutoOpened] = useState(false)
  useEffect(() => {
    if (!autoOpened && summary && summary.apiKeyConfigured) {
      const anyConfigured = Object.values(summary.apiKeyConfigured).some(Boolean)
      if (!anyConfigured) setConfigOpen(true)
      setAutoOpened(true)
    }
  }, [summary, autoOpened])

  // Merge key-based + gateway-native providers for display.
  const keyProviders = Array.isArray(summary?.providers) ? summary.providers : []
  const allProviders = [...keyProviders, ...gatewayProviders]

  // The provider whose model is currently selected in the composer.
  const active = allProviders.find(
    (p) => p.gatewaySlug && p.kind !== 'note' && providerIdFor(p.gatewaySlug, '') === activeProvider,
  ) || allProviders.find((p) => p.id === activeProvider)

  let chipChildren
  if (!providerResolved) {
    // Model gate still resolving — brief placeholder, never a provider list.
    chipChildren = [
      jsx('span', { key: 'name', className: 'font-semibold text-(--ui-text-quaternary)', children: 'US' }),
      jsx('span', { key: 'dots', className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: '…' }),
    ]
  } else if (active) {
    // STRICT model gating: only the active model's provider on the chip.
    chipChildren = renderProvider(active)
  } else if (fetchError && !summary && !gatewayProviders.length) {
    // Supported provider but its data can't load at all — surface the fault
    // instead of silently hiding a chip the user enabled.
    chipChildren = [
      jsx('span', { key: 'name', className: 'font-semibold text-(--ui-text-quaternary)', children: 'US' }),
      jsx('span', { key: 'err', className: 'text-[0.625rem] text-(--destructive)', children: '⚠' }),
    ]
  } else {
    // Unsupported/unconfigured active provider — hide by design.
    return null
  }

  const panel = jsx(PopoverContent, {
    key: 'panel',
    align: 'end',
    sideOffset: 6,
    className: 'w-64 p-1.5',
      jsx('div', {
        key: 'head',
        className: 'px-1.5 pb-1 pt-0.5 text-[0.625rem] font-semibold text-(--ui-text-quaternary)',
        children: 'Usage — configured providers',
      }),
      listed.length === 0
        ? jsx('div', {
            key: 'empty',
            className: 'px-1.5 py-2 text-[0.625rem] text-(--ui-text-tertiary)',
            children: 'No keys configured — right-click → Configure keys',
          })
        : jsx('div', {
            key: 'rows',
            className: 'flex flex-col gap-0.5',
            children: listed.map((p) => jsx(WidgetRow, {
              key: p.id,
              p,
              active: p === active || (activeProvider != null && p.gatewaySlug && providerIdFor(p.gatewaySlug, '') === activeProvider),
            })),
          }),
    ],
  })

  const chip = jsx('button', {
    className: cn(
      'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
      'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
    ),
    type: 'button',
    onClick: () => void refresh(),
    children: chipChildren,
  })

  return jsx('div', {
    children: [
      jsx(ContextMenu, {
        key: 'ctx',
        children: [
          jsx(ContextMenuTrigger, {
            key: 'trigger',
            asChild: true,
            children: jsx(Popover, {
              key: 'pop',
              open: panelOpen,
              children: [
                jsx(PopoverTrigger, { key: 'pt', asChild: true, children: chip }),
                panel,
              ],
            }),
          }),
          jsx(ContextMenuContent, {
            key: 'menu',
            children: [
              jsx(ContextMenuItem, { key: 'refresh', onSelect: () => void refresh(), children: '↻ Refresh' }),
              jsx(ContextMenuItem, { key: 'config', onSelect: () => setConfigOpen(true), children: '⚙ Configure keys' }),
              jsx(ContextMenuSeparator, { key: 'sep' }),
              jsx(ContextMenuItem, { key: 'hide', onSelect: hide, children: '✕ Hide from status bar' }),
            ],
          }),
        ],
      }),
      jsx(ConfigDialog, {
        key: 'dialog',
        open: configOpen,
        onOpenChange: setConfigOpen,
        configured: summary?.apiKeyConfigured,
      }),
    ],
  })
}

export default {
  id: ID,
  name: 'Usage Stats',
  description: 'Usage & balance for the active model’s provider (OC, OR, DS, KI, NV, Z, AB, AR, + gateway-native Claude/Codex/Cursor/Nous).',
  defaultEnabled: false,
  register(ctx) {
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 200,
      render: () => jsx(UsageChip, { rest: ctx.rest, storage: ctx.storage }),
    })

    ctx.register({
      id: 'show-command',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.show`,
        label: 'Usage Stats: Show',
        keywords: ['usage', 'stats', 'provider', 'balance', 'show', 'mostra'],
        run: () => {
          try { window.__usageStatsShow?.() } catch { /* ok */ }
          host.notify({ kind: 'info', message: 'Usage Stats chip restored.' })
        },
      },
    })

    // ⌘K command to open the key config dialog directly.
    ctx.register({
      id: 'config-command',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.config`,
        label: 'Usage Stats: Configure keys',
        keywords: ['usage', 'stats', 'provider', 'api key', 'keys', 'configure', 'configura', 'chiavi'],
        run: () => { try { window.__usageStatsOpen?.() } catch { /* ok */ } },
      },
    })
  },
}
