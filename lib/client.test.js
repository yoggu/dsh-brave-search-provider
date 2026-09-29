import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function fixture(active = 'en', { configured = true, accept = true, status = 'ready' } = {}) {
  let exported, Card, index = 0
  let snapshot = { status, writable: true, value: { country: 'us', searchLang: 'en', timeoutMs: 30000 } }
  const states = [], effects = [], pending = [], calls = []
  const locale = { active }
  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...props, children })
      return { type, props: { ...props, children } }
    },
    useState(initial) {
      const slot = index++
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
      return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value }]
    },
    useCallback: fn => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect(effect, deps) {
      const slot = index++
      if (!effects[slot] || deps.some((item, at) => item !== effects[slot][at])) pending.push(effect)
      effects[slot] = deps
    },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(definition) {
      assert.equal(definition.id, 'dsh-brave-search-provider')
      exported = definition.factory(name => {
        if (name === 'react') return React
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconChevronDownOutlineRegular: () => null }
        throw new Error(`Unexpected dependency ${name}`)
      })
    } } },
  })
  const api = {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      async set(field, value) { calls.push(['setting', field, value]); return accept },
    },
    locale: { getSnapshot: () => ({ active: locale.active }), subscribe: () => () => {} },
    async describeKey(ref) { calls.push(['describe', ref]); return { ok: true, value: { [ref]: { configured, writable: true } } } },
    async setKey(ref, value) { calls.push(['key', ref, value]) },
    onCredentialUpdate: () => () => {},
  }
  exported.apply({
    effect(fn) { fn() },
    locale: api.locale,
    configForms: { get: () => api.scope, whileServed(_names, fn) { return fn() } },
    remote: { credentials: { describe: refs => api.describeKey(refs[0]), set: api.setKey, unset() { throw new Error('No key removal expected') } }, $on: api.onCredentialUpdate },
    slots: {
      inject(name, fn) { assert.equal(name, 'plugins.bundle.config'); return fn() },
      register(spec, component) { assert.equal(spec.key, 'dsh-brave-search-provider'); Card = component },
    },
  })
  function render(view = 'config') {
    index = 0
    const tree = Card({ api, view })
    while (pending.length) pending.shift()()
    return tree
  }
  return { render, locale, calls, exported, setSnapshot(value) { snapshot = value }, async flush() { await new Promise(resolve => setImmediate(resolve)) } }
}
function walk(node, predicate) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => walk(child, predicate))
  return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)]
}
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ')
  return text(node.props?.children)
}
const input = (tree, id) => walk(tree, node => node.type === 'input' && node.props.id === id)[0]
const button = (tree, label) => walk(tree, node => node.type === 'button' && text(node) === label)[0]

test('English covers Brave settings, help, credential status and summary without reading a stored key', async () => {
  const f = fixture()
  f.render(); await f.flush()
  const tree = f.render(), content = text(tree)
  for (const label of ['Brave Web Search', 'Brave API key', 'Key configured', 'Country', 'Search language', 'Timeout (ms)', 'Save', 'Discard', 'stored key cannot be displayed']) assert.ok(content.includes(label), label)
  assert.equal(input(tree, 'brave-search-key').props.value, '')
  assert.equal(input(tree, 'brave-search-key').props.placeholder, 'Stored in the credential store')
  assert.equal(input(tree, 'brave-search-searchLang').props.value, 'en')
  assert.match(f.render('summary'), /gets its results from the Brave Search API/)
  assert.equal(f.calls.every(call => call[0] === 'describe'), true)
  assert.equal(f.exported.inject.includes('locale'), true)
})

test('German and regional German stay available; switching to English preserves the draft and search preferences', async () => {
  const f = fixture('de-DE')
  f.render(); await f.flush()
  let tree = f.render()
  assert.ok(text(tree).includes('Brave Websuche'))
  assert.ok(text(tree).includes('Suchsprache'))
  input(tree, 'brave-search-country').props.onChange({ target: { value: 'gb' } })
  f.locale.active = 'en'
  tree = f.render()
  assert.ok(text(tree).includes('Search language'))
  assert.equal(input(tree, 'brave-search-country').props.value, 'gb')
  assert.equal(input(tree, 'brave-search-searchLang').props.value, 'en')
  assert.equal(f.calls.some(call => call[0] === 'setting' || call[0] === 'key'), false)
})

test('unsupported, regional English and unavailable locales fall back to English', () => {
  for (const active of ['zh-CN', 'fr', 'en-GB', undefined]) {
    const f = fixture(active)
    f.locale.active = active
    assert.ok(text(f.render()).includes('Brave Web Search'))
    assert.ok(f.render('summary').startsWith('The web_search tool'))
  }
})

test('English validation and discard messages are translated without changing field validation', () => {
  const f = fixture(), tree = f.render()
  input(tree, 'brave-search-country').props.onChange({ target: { value: 'invalid' } })
  let next = f.render()
  assert.ok(text(next).includes('This value is not accepted.'))
  assert.equal(button(next, 'Save').props.disabled, true)
  button(next, 'Discard').props.onClick()
  next = f.render()
  assert.equal(input(next, 'brave-search-country').props.value, 'us')
  assert.equal(text(next).includes('This value is not accepted.'), false)
})

test('English save failures and unavailable-settings messages retain drafts and do not mutate credentials', async () => {
  const f = fixture('en', { accept: false })
  input(f.render(), 'brave-search-country').props.onChange({ target: { value: 'gb' } })
  button(f.render(), 'Save').props.onClick(); await f.flush()
  const tree = f.render()
  assert.ok(text(tree).includes('Save failed. The Host did not accept the change.'))
  assert.equal(input(tree, 'brave-search-country').props.value, 'gb')
  assert.equal(f.calls.some(call => call[0] === 'key'), false)
  assert.ok(text(fixture('en', { status: 'unavailable' }).render()).includes('not serving this settings namespace yet'))
})

test('English show/hide labels apply only to a newly typed synthetic token', async () => {
  const f = fixture('en', { configured: false })
  f.render(); await f.flush()
  let tree = f.render()
  assert.ok(text(tree).includes('No key'))
  assert.equal(button(tree, 'Show'), undefined)
  input(tree, 'brave-search-key').props.onChange({ target: { value: 'synthetic-test-token' } })
  tree = f.render()
  assert.equal(input(tree, 'brave-search-key').props.type, 'password')
  button(tree, 'Show').props.onClick()
  tree = f.render()
  assert.equal(input(tree, 'brave-search-key').props.type, 'text')
  assert.ok(button(tree, 'Hide'))
  assert.equal(f.calls.some(call => call[0] === 'key'), false)
})
