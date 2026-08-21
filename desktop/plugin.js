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
 * Right-click the chip: "Aggiorna" / "Nascondi" / "Configura chiavi".
 * Re-show: ⌘K → "Usage Stats: Mostra".
 *
 * SECURITY: API keys are NEVER transmitted over the network by this plugin.
 * The "Configura chiavi" dialog collects them in masked password inputs and
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
  PALETTE_AREA,
} from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useState } from 'react'

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
function providerIdFor(provider, baseUrl) {
  for (const value of [provider, baseUrl]) {
    if (!value) continue
    const v = String(value).toLowerCase()
    if (v.includes('opencode')) return 'opencode'
    if (v.includes('openrouter')) return 'openrouter'
    if (v.includes('deepseek')) return 'deepseek'
    if (v.includes('kimi') || v.includes('moonshot')) return 'kimi'
    if (v.includes('anthropic') || v.includes('claude')) return 'anthropic'
    if (v.includes('codex')) return 'openai-codex'
    if (v.includes('cursor')) return 'cursor'
    if (v.includes('nous')) return 'nous'
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
  return `${Math.round(hours / 24)}d`
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
  return out
}

// --- Config dialog: masked inputs → copy to local clipboard (NEVER network) ---
function ConfigDialog({ open, onOpenChange, configured }) {
  const [values, setValues] = useState({})
  const [copied, setCopied] = useState(false)

  const rows = useMemo(() => KEY_SPECS.map((spec) => ({
    ...spec,
    configured: configured ? !!configured[spec.id]?.configured : false,
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
            jsx(DialogTitle, { key: 't', children: 'Configura chiavi provider' }),
            jsx(DialogDescription, {
              key: 'd',
              children: 'Le chiavi sono mascherate e copiate solo negli appunti locali — non transitano mai sulla rete. Incolla poi il testo in ~/.hermes/.env',
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
                  row.configured ? jsx('span', { key: 'ok', className: 'text-(--ui-text-quaternary)', children: '(già configurata)' }) : null,
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
              children: copied ? 'Copiato! ✓' : 'Copia negli appunti',
              disabled: KEY_SPECS.every((s) => !values[s.autoKey]),
            }),
            jsx('button', {
              type: 'button',
              className: 'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[0.75rem] text-(--ui-text-secondary) hover:bg-accent',
              onClick: () => onOpenChange(false),
              children: 'Chiudi',
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

  const refresh = useCallback(async () => {
    try {
      if (rest) {
        const response = await rest('/summary', { method: 'GET', timeoutMs: 20_000 })
        setSummary(response)
        setFetchError(null)
      }
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : String(error))
    }
    // Gateway-native providers — no backend, no keys.
    try {
      const [acc, bars] = await Promise.all([
        host.request('account.usage', {}).catch(() => null),
        host.request('usage.bars', {}).catch(() => null),
      ])
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

  if (hidden) return null

  // Merge key-based + gateway-native providers for display.
  const keyProviders = Array.isArray(summary?.providers) ? summary.providers : []
  const allProviders = [...keyProviders, ...gatewayProviders]

  let chipChildren
  if (fetchError && !summary && !gatewayProviders.length) {
    chipChildren = [
      jsx('span', { key: 'name', className: 'font-semibold text-(--ui-text-quaternary)', children: 'US' }),
      jsx('span', { key: 'err', className: 'text-[0.625rem] text-(--destructive)', children: '⚠' }),
    ]
  } else if (!allProviders.length) {
    chipChildren = [
      jsx('span', { key: 'name', className: 'font-semibold text-(--ui-text-quaternary)', children: 'US' }),
      jsx('span', { key: 'dots', className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: '…' }),
    ]
  } else {
    // Prefer the active gateway-native provider when model-gated.
    const active = allProviders.find(
      (p) => p.gatewaySlug && providerIdFor(p.gatewaySlug, '') === activeProvider,
    ) || allProviders.find((p) => p.id === activeProvider)
    if (active) {
      chipChildren = renderProvider(active)
    } else if (providerResolved) {
      return null
    } else {
      chipChildren = allProviders.flatMap((p, i) => {
        const sep = i > 0
          ? [jsx('span', { key: `sep-${p.id}`, className: 'text-(--ui-text-quaternary)', children: '·' })]
          : []
        return [...sep, ...renderProvider(p)]
      })
    }
  }

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
          jsx(ContextMenuTrigger, { key: 'trigger', children: chip }),
          jsx(ContextMenuContent, {
            key: 'menu',
            children: [
              jsx(ContextMenuItem, { key: 'refresh', onSelect: () => void refresh(), children: '↻ Aggiorna' }),
              jsx(ContextMenuItem, { key: 'config', onSelect: () => setConfigOpen(true), children: '⚙ Configura chiavi' }),
              jsx(ContextMenuSeparator, { key: 'sep' }),
              jsx(ContextMenuItem, { key: 'hide', onSelect: hide, children: '✕ Nascondi dalla status bar' }),
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
        label: 'Usage Stats: Mostra',
        keywords: ['usage', 'stats', 'provider', 'balance', 'mostra', 'show', 'configura', 'chiavi'],
        run: () => {
          try { window.__usageStatsShow?.() } catch { /* ok */ }
          host.notify({ kind: 'info', message: 'Usage Stats chip ripristinato.' })
        },
      },
    })

    // ⌘K command to open the key config dialog directly.
    ctx.register({
      id: 'config-command',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.config`,
        label: 'Usage Stats: Configura chiavi',
        keywords: ['usage', 'stats', 'provider', 'api key', 'configura', 'chiavi'],
        run: () => { try { window.__usageStatsOpen?.() } catch { /* ok */ } },
      },
    })
  },
}
