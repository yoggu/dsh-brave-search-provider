import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  apply,
  BraveSearchProvider,
  BRAVE_DEFAULT_ENDPOINT,
  Config,
} from './index.js'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const secret = 'secret-brave-subscription-token'
const ctx = (resolve = async () => ({ value: secret })) => ({
  get(name) {
    assert.equal(name, 'credentials')
    return { resolve }
  },
})
const options = (extra = {}) => ({
  endpoint: BRAVE_DEFAULT_ENDPOINT,
  country: 'us',
  searchLang: 'en',
  timeoutMs: 1000,
  apiKeyEnv: 'BRAVE_API_KEY',
  ...extra,
})
const provider = (extra = {}, context = ctx()) => new BraveSearchProvider(context, () => options(extra))

async function rejectsRedacted(operation, code, message) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code)
    assert.equal(error.message, message)
    assert.equal(error.cause, undefined)
    assert.equal(JSON.stringify(error).includes(secret), false)
    return true
  })
}

test('only the fixed Brave endpoint is sent, with redirects disabled', async () => {
  assert.deepEqual(Object.keys(Config.dict).sort(), ['country', 'searchLang', 'timeoutMs'])
  let registered
  apply({
    web: { registerSearchProvider(value) { registered = value } },
    ...ctx(),
  }, {
    endpoint: { get() { throw new Error('obsolete endpoint was read') } },
    country: { get: () => 'de' },
    searchLang: { get: () => 'en' },
    timeoutMs: { get: () => 1000 },
  })
  globalThis.fetch = async (url, init) => {
    assert.equal(url.origin + url.pathname, BRAVE_DEFAULT_ENDPOINT)
    assert.equal(url.searchParams.get('q'), 'hello')
    assert.equal(url.searchParams.get('country'), 'de')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers['x-subscription-token'], secret)
    return { ok: true, json: async () => ({ web: { results: [] } }) }
  }
  assert.equal(registered.available(), true)
  assert.deepEqual(await registered.search({ query: 'hello', maxResults: 3 }), { sources: [], truncated: false })
})

test('rejects a different endpoint before resolving a key or making a request', async () => {
  const malicious = provider({ endpoint: 'https://attacker.example/search' }, {
    get() { throw new Error('credential lookup must not run') },
  })
  globalThis.fetch = () => { throw new Error('fetch must not run') }
  assert.equal(malicious.available(), false)
  await rejectsRedacted(() => malicious.search({ query: 'hello' }), 'WEB_PROVIDER_ERROR',
    'Brave Search endpoint must be the official Brave Web Search API URL')
})

test('redacts credential failures, including nested causes', async () => {
  const broken = provider({}, ctx(async () => {
    throw new WebError(`credential lookup ${secret}`, 'LEAK', { cause: new Error(secret) })
  }))
  await rejectsRedacted(() => broken.search({ query: 'hello' }), 'WEB_PROVIDER_ERROR',
    'Brave Search credential lookup failed')
})

test('redacts upstream response body and exception text, including WebError exceptions', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json() { throw new Error(`response body ${secret} must not be read`) },
  })
  await rejectsRedacted(() => provider().search({ query: 'hello' }), 'WEB_PROVIDER_ERROR',
    'Brave Search API error (HTTP 401)')

  globalThis.fetch = async () => ({ ok: false, status: secret })
  await rejectsRedacted(() => provider().search({ query: 'hello' }), 'WEB_PROVIDER_ERROR',
    'Brave Search API error (HTTP unknown)')

  globalThis.fetch = async () => { throw new WebError(`network ${secret}`, 'LEAK', { cause: new Error(secret) }) }
  await rejectsRedacted(() => provider().search({ query: 'hello' }), 'WEB_PROVIDER_ERROR',
    'Brave Search request failed')

  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error(`JSON ${secret}`) } })
  await rejectsRedacted(() => provider().search({ query: 'hello' }), 'WEB_PROVIDER_ERROR',
    'Brave Search request failed')
})

test('redacts abort reasons before and during credential lookup', async () => {
  const aborted = new AbortController()
  aborted.abort(new Error(secret))
  await rejectsRedacted(() => provider().search({ query: 'hello' }, aborted.signal), 'WEB_ABORTED',
    'Brave Search request aborted')

  const pending = new AbortController()
  const broken = provider({}, ctx(async () => {
    pending.abort(new Error(secret))
    throw new Error(secret)
  }))
  await rejectsRedacted(() => broken.search({ query: 'hello' }, pending.signal), 'WEB_ABORTED',
    'Brave Search request aborted')
})
