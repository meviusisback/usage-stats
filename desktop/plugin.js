/**
 * OpenCode Usage — Hermes Desktop status-bar plugin (multi-provider, model-gated).
 *
 * Shows usage/balance for ONLY the provider backing the currently-selected
 * model, and switches automatically when the model changes:
 *   OpenCode Go → 5h / W / M windows (% used)
 *   OpenRouter   → remaining credit balance ($)
 *   DeepSeek     → remaining balance ($)
 *
 * The active provider is resolved from the gateway config
 * (`config.get full` → `config.model.provider`). If that RPC fails, the chip
 * degrades to showing ALL configured providers rather than disappearing.
 */
import { Tip, cn, host, useValue } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useCallback, useEffect, useState } from 'react'

const ID = 'opencode-usage'
const REFRESH_MS = 60_000

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

// Map a provider slug / base URL to a tracked plugin id (null = untracked).
function providerIdFor(provider, baseUrl) {
  for (const value of [provider, baseUrl]) {
    if (!value) continue
    const v = String(value).toLowerCase()
    if (v.includes('opencode')) return 'opencode'
    if (v.includes('openrouter')) return 'openrouter'
    if (v.includes('deepseek')) return 'deepseek'
  }
  return null
}

function WindowBadge({ w }) {
  const text = w.percent == null ? '—' : `${Math.round(w.percent)}%`
  return jsx(Tip, {
    label: `${w.label} window: ${text} used`,
    children: jsx('span', {
      className: 'inline-flex items-center gap-0.5 text-[0.625rem] font-mono',
      children: [
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: w.label }),
        jsx('span', { style: { color: percentTone(w.percent) }, children: text }),
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

// Render one provider as an array of badge nodes (OC → windows, else single).
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

function UsageChip({ rest }) {
  const [summary, setSummary] = useState(null)
  const [fetchError, setFetchError] = useState(null)
  const [activeProvider, setActiveProvider] = useState(null)
  const [providerResolved, setProviderResolved] = useState(false)
  const modelSlug = useValue(host.state.model)

  // Resolve the active model's provider from the gateway config.
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
      const response = await rest('/summary', { method: 'GET', timeoutMs: 20_000 })
      setSummary(response)
      setFetchError(null)
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : String(error))
    }
  }, [rest])

  // Re-detect the active provider the instant the model slug changes.
  useEffect(() => {
    void checkProvider()
  }, [checkProvider, modelSlug])

  // Periodic refresh + provider re-check.
  useEffect(() => {
    void checkProvider()
    void refresh()
    const timer = setInterval(() => {
      void checkProvider()
      void refresh()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [checkProvider, refresh])

  if (fetchError && !summary) {
    return jsx(Tip, {
      label: `Usage — ${fetchError}`,
      children: jsx('span', {
        className: 'inline-flex h-full items-center px-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
        children: 'Usage ⚠',
      }),
    })
  }

  if (!summary) {
    return jsx('span', {
      className: 'inline-flex h-full items-center px-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
      children: 'Usage …',
    })
  }

  const providers = Array.isArray(summary.providers) ? summary.providers : []
  if (providers.length === 0) return null

  const active = providers.find((p) => p.id === activeProvider)

  let badges
  if (active) {
    badges = renderProvider(active)
  } else if (providerResolved) {
    // Active model is from a provider we don't track → hide the chip.
    return null
  } else {
    // Provider resolution failed → show every configured provider instead.
    badges = providers.flatMap((p, i) => {
      const sep = i > 0
        ? [jsx('span', { key: `sep-${p.id}`, className: 'text-(--ui-text-quaternary)', children: '·' })]
        : []
      return [...sep, ...renderProvider(p)]
    })
  }

  return jsx('button', {
    className: cn(
      'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
      'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
    ),
    type: 'button',
    onClick: () => void refresh(),
    children: badges,
  })
}

export default {
  id: ID,
  name: 'Usage',
  description: 'Usage & balance for the active model’s provider (OpenCode, OpenRouter, DeepSeek).',
  defaultEnabled: false,
  register(ctx) {
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 200,
      render: () => jsx(UsageChip, { rest: ctx.rest }),
    })
  },
}