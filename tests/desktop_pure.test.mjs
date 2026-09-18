// Pure-function contract tests for desktop/plugin.js.
//
// plugin.js imports '@hermes/plugin-sdk' / 'react', which only resolve inside
// the Desktop runtime — so instead of importing it, we slice the dependency-
// free pure functions (providerIdFor / resetCountdown) out of the source and
// evaluate them. This pins the model-gating and countdown contracts that the
// pytest suite cannot reach.
//
// Run: node --test tests/desktop_pure.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'desktop', 'plugin.js'), 'utf8')

const start = src.indexOf('// Map a model config')
const end = src.indexOf('function WindowBadge')
assert.ok(start > 0 && end > start, 'pure-function slice markers not found')

const factory = new Function(`${src.slice(start, end)}\nreturn { providerIdFor, resetCountdown, widgetProviders, windowParts }`)
const { providerIdFor, resetCountdown, widgetProviders, windowParts } = factory()

const minutesFromNow = (m) => new Date(Date.now() + m * 60_000).toISOString()

test('providerIdFor maps every key-based provider slug', () => {
  assert.equal(providerIdFor('opencode-go', ''), 'opencode')
  assert.equal(providerIdFor('openrouter', ''), 'openrouter')
  assert.equal(providerIdFor('deepseek', ''), 'deepseek')
  assert.equal(providerIdFor('kimi', ''), 'kimi')
  assert.equal(providerIdFor('moonshot', ''), 'kimi')
  assert.equal(providerIdFor('novita', ''), 'novita')
  assert.equal(providerIdFor('zai', ''), 'zai')
  assert.equal(providerIdFor('glm', ''), 'zai')
  assert.equal(providerIdFor('alibaba', ''), 'alibaba')
  assert.equal(providerIdFor('arcee', ''), 'arcee')
  assert.equal(providerIdFor('anthropic', ''), 'anthropic')
  assert.equal(providerIdFor('openai-codex', ''), 'openai-codex')
})

test('providerIdFor maps base_urls by hostname', () => {
  assert.equal(providerIdFor(null, 'https://open.bigmodel.cn/api/paas/v4'), 'zai')
  assert.equal(providerIdFor(null, 'https://api.novita.ai/v3'), 'novita')
  assert.equal(providerIdFor(null, 'https://dashscope.aliyuncs.com/api/v1'), 'alibaba')
  assert.equal(providerIdFor(null, 'https://api.arcee.ai/v2'), 'arcee')
  assert.equal(providerIdFor(null, 'https://api.moonshot.cn/v1'), 'kimi')
  assert.equal(providerIdFor(null, 'https://opencode.ai/zen/go/v1'), 'opencode')
})

test('providerIdFor ignores base_url paths on unrelated hosts', () => {
  // Regression: substring matching over the full URL mapped a proxy whose
  // PATH mentioned a provider to that provider's stats.
  assert.equal(providerIdFor('my-proxy', 'https://gw.example.com/kimi-route'), null)
  assert.equal(providerIdFor('my-proxy', 'https://gateway.internal/arcee-mirror'), null)
})

test('providerIdFor returns null for unknown providers', () => {
  assert.equal(providerIdFor('gemini', 'https://generativelanguage.googleapis.com/v1'), null)
  assert.equal(providerIdFor(null, null), null)
})

test('resetCountdown formats minutes, hours, days', () => {
  assert.equal(resetCountdown(minutesFromNow(0.5)), '<1m')
  assert.equal(resetCountdown(minutesFromNow(38)), '38m')
  assert.equal(resetCountdown(minutesFromNow(90)), '1h')
  assert.equal(resetCountdown(minutesFromNow(47 * 60)), '47h')
  assert.equal(resetCountdown(minutesFromNow(64 * 60)), '3d')
})

test('resetCountdown handles past, missing, malformed, far-future', () => {
  assert.equal(resetCountdown(new Date(Date.now() - 1000).toISOString()), 'now')
  assert.equal(resetCountdown(null), null)
  assert.equal(resetCountdown('not-a-date'), null)
  // Sentinel timestamps must not render '(2927702d)'.
  assert.equal(resetCountdown('9999-12-31T00:00:00Z'), null)
})

test('windowParts exposes every window with rounded percent', () => {
  const parts = windowParts([
    { id: 'rolling', label: '5h', percent: 0 },
    { id: 'weekly', label: 'W', percent: 78.6 },
    { id: 'monthly', label: 'M', percent: null },
  ])
  assert.deepEqual(parts, [
    { id: 'rolling', label: '5h', percent: 0, text: '0%' },
    { id: 'weekly', label: 'W', percent: 78.6, text: '79%' },
    { id: 'monthly', label: 'M', percent: null, text: '—' },
  ])
})

test('windowParts returns null without windows', () => {
  assert.equal(windowParts([]), null)
  assert.equal(windowParts(undefined), null)
  // Balance providers carry no windows — single-label rendering applies.
})

test('widgetProviders lists only providers with data', () => {
  const all = [
    { id: 'opencode', display: 'OC', kind: 'percent', label: '38%', error: null },
    { id: 'deepseek', display: 'DS', kind: null, label: null, error: 'no-api-key' },
    { id: 'openrouter', display: 'OR', kind: 'balance', label: '$1.82', error: 'http-403' },
    { id: 'gw:kimi', gatewaySlug: 'kimi', kind: 'percent', label: '12%', error: null },
    { id: 'gw:nous', gatewaySlug: 'nous', kind: 'note', label: '—', error: null },
  ]
  const listed = widgetProviders(all)
  // Unconfigured key-based entries and empty gateway notes never show;
  // a configured key with a failed fetch still shows (with its error).
  assert.deepEqual(listed.map((p) => p.id), ['opencode', 'openrouter', 'gw:kimi'])
})

test('plugin.js parses as strict ESM under loader-style rewriting', async () => {
  // Regression: `node --check` on the .js file gives a FALSE PASS on some
  // unbalanced-bracket states (lenient goal), while Hermes imports the
  // rewritten source as a blob module — always strict ESM. Replicate the
  // loader: rewrite bare specifiers to stub data-URLs, then import.
  const importRe = /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g
  const needed = new Map()
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)
    needed.set(m[2], [...(needed.get(m[2]) ?? []), ...names])
  }
  const out = src.replace(importRe, (whole, pre, quote, spec) => {
    if (!needed.has(spec)) return whole
    const stub = `export default {}\n` + needed.get(spec).map((n) => `export const ${n} = undefined`).join('\n')
    return `${pre}${quote}data:text/javascript,${encodeURIComponent(stub)}${quote}`
  })
  const url = `data:text/javascript,${encodeURIComponent(out)}`
  const mod = await import(url)
  assert.equal(mod.default?.id, 'usage-stats')
  assert.equal(typeof mod.default?.register, 'function')
})

test('widgetProviders tolerates missing payload', () => {
  assert.deepEqual(widgetProviders(undefined), [])
  assert.deepEqual(widgetProviders(null), [])
})

// --- focused-session model gate (session.info live routes) -------------------

// Slice the UsageChip's gate-resolution logic out of the component. The
// component itself needs React + the plugin SDK; this reproduces its exact
// resolution order over pure inputs so the contract is testable:
//   focused session live route → composer persisted pick → backend default.
function resolveActiveProvider({ liveRoute, storedProvider, modelSlug }) {
  let provider = liveRoute
    ? (providerIdFor(liveRoute.provider, '') || providerIdFor(liveRoute.model, ''))
    : null
  if (!provider) provider = providerIdFor(storedProvider, '') || providerIdFor(modelSlug, '')
  return provider
}

test('live session route wins over the persisted composer pick', () => {
  // The bug: composer localStorage stays 'deepseek' (profile-global default)
  // while the focused chat switched to a Codex model — the chip must follow
  // the session, not the default.
  assert.equal(
    resolveActiveProvider({ liveRoute: { provider: 'openai-codex', model: 'gpt-5-codex' }, storedProvider: 'deepseek', modelSlug: 'deepseek-chat' }),
    'openai-codex')
})

test('gate falls back to the composer pick without a live route', () => {
  // Draft chats (no session yet) still resolve from the persisted provider;
  // a bare model slug alone is a weaker heuristic (vendor-prefixed openrouter
  // ids match their prefix's token, which is why tier 2 prefers stored).
  assert.equal(resolveActiveProvider({ liveRoute: null, storedProvider: 'opencode-go', modelSlug: 'ox-alpha-free' }), 'opencode')
  assert.equal(resolveActiveProvider({ liveRoute: undefined, storedProvider: '', modelSlug: 'deepseek/deepseek-v4-pro' }), 'deepseek')
})

test('gate yields to the backend default when composer state is empty', () => {
  // null here means "ask rest('/active_provider')" — the component's third tier.
  assert.equal(resolveActiveProvider({ liveRoute: null, storedProvider: '', modelSlug: '' }), null)
})

// --- gateway-native snapshot mapping -----------------------------------------

// mapGatewayProviders is dependency-free; extract it (and the provider dict
// it reads) straight from source so the test cannot drift from the shipping
// GATEWAY_PROVIDERS table.
const mapGatewayProviders = new Function(
  `${src.slice(src.indexOf('const GATEWAY_PROVIDERS'), src.indexOf('// --- Config dialog'))}\nreturn mapGatewayProviders`)()

test('mapGatewayProviders consumes the /account_usage snapshot shape', () => {
  const account = {
    snapshots: [{
      provider: 'openai-codex',
      plan: 'Plus',
      windows: [
        { label: 'Session', used_percent: 8.0, resetsAt: minutesFromNow(240) },
        { label: 'Weekly', used_percent: 76.0, resetsAt: minutesFromNow(2 * 24 * 60) },
      ],
      details: ['You have 1 reset credit banked'],
    }],
  }
  const [chip] = mapGatewayProviders(account, null)
  assert.equal(chip.id, 'gw:openai-codex')
  assert.equal(chip.gatewaySlug, 'openai-codex')
  assert.equal(chip.kind, 'percent')
  assert.equal(chip.value, 8) // headline = first window, used_percent as-is
  assert.deepEqual(chip.windows.map((w) => w.percent), [8, 76])
})

test('mapGatewayProviders degrades cleanly on empty or missing payloads', () => {
  assert.deepEqual(mapGatewayProviders(null, null), [])
  assert.deepEqual(mapGatewayProviders({ snapshots: [] }, null), [])
  // a snapshot for an unknown provider slug is skipped, not rendered blank
  assert.deepEqual(mapGatewayProviders({ snapshots: [{ provider: 'gemini', windows: [] }] }, null), [])
})

// --- per-profile backend gate -------------------------------------------------

// Second slice: the backend-missing classifier sits below `WindowBadge`, so it
// falls outside the pure-function block sliced above.
const restStart = src.indexOf('function restMissingRoute')
assert.ok(restStart > 0, 'restMissingRoute slice marker not found')
let restDepth = 0
let restEnd = -1
for (let i = src.indexOf('{', restStart); i < src.length; i += 1) {
  if (src[i] === '{') restDepth += 1
  else if (src[i] === '}') {
    restDepth -= 1
    if (restDepth === 0) {
      restEnd = i + 1
      break
    }
  }
}
assert.ok(restEnd > restStart, 'restMissingRoute body not closed')
const restMissingRoute = new Function(`${src.slice(restStart, restEnd)}\nreturn restMissingRoute`)()

test('restMissingRoute recognizes an unmounted plugin backend', () => {
  // The agent half mounts per profile (plugins.enabled) while the desktop half
  // is app-level, so this 404 is the ordinary state of a profile that never
  // enabled the plugin — not a broken key.
  assert.equal(restMissingRoute(new Error('404: Not Found')), true)
  assert.equal(restMissingRoute('404: {"detail":"Not Found"}'), true)
  assert.equal(restMissingRoute(new Error('405: Method Not Allowed')), true)
})

test('restMissingRoute leaves real faults and working backends alone', () => {
  assert.equal(restMissingRoute(new Error('401: Unauthorized')), false)
  assert.equal(restMissingRoute(new Error('500: Internal Server Error')), false)
  assert.equal(restMissingRoute(new Error('Hermes desktop bridge unavailable')), false)
  assert.equal(restMissingRoute(undefined), false)
})
