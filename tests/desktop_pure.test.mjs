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

const factory = new Function(`${src.slice(start, end)}\nreturn { providerIdFor, resetCountdown, widgetProviders }`)
const { providerIdFor, resetCountdown, widgetProviders } = factory()

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

test('widgetProviders tolerates missing payload', () => {
  assert.deepEqual(widgetProviders(undefined), [])
  assert.deepEqual(widgetProviders(null), [])
})
