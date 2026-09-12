/**
 * Browser half of `dsh-web-search-brave`: the plugin's card on the Plugins
 * settings page.
 *
 * Hand-written in the `window.__ModuleLoader__.load` format — no JSX, no
 * bundler — and declared through `exports["./client"]` plus `dsh.client` in
 * package.json, which is how the host discovers and serves a browser bundle.
 *
 * The card is registered into the keyed slot `settings.plugin.item` under the
 * settings namespace the host half installs (`web-search-brave`). The Plugins
 * page dispatches that slot by the namespaces the Host actually serves, so the
 * card appears exactly when the host half is composed — and disappears with
 * it, leaving no trace.
 *
 * Two planes meet here and stay separate:
 *   - the settings section carries endpoint, locale hints, timeout and the
 *     *reference* of the API key;
 *   - the credential domain carries the key literal itself. The card learns
 *     only whether a key is configured, and writes it through
 *     `remote.credentials`; the page never receives the literal back.
 *
 * @module dsh-web-search-brave/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-web-search-brave',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** This bundle's id, used as the marker on its injected style tag. */
    const CSS_TAG = 'dsh-web-search-brave'
    /** Settings namespace installed by this package's host half. */
    const NS = 'web-search-brave'
    /** Credential reference the provider resolves when the section names none. */
    const DEFAULT_API_KEY_REF = 'BRAVE_API_KEY'
    /** Field names inside the section. */
    const KEY_FIELD = 'apiKey'
    const REF_FIELD = 'apiKeyEnv'

    /**
     * The section fields this card edits. `apiKey` is not one of them: it is
     * write-only and lives in the credential domain, not in the document.
     */
    const FIELDS = [
      {
        field: REF_FIELD,
        label: 'Referenz des API-Schlüssels',
        hint: 'Name im Credential-Speicher. Der Schlüssel selbst steht nie in den Einstellungen.',
        kind: 'text',
      },
      {
        field: 'endpoint',
        label: 'Endpunkt',
        hint: 'Brave Web Search API. Nur HTTPS.',
        kind: 'text',
      },
      {
        field: 'country',
        label: 'Land',
        hint: 'Zweibuchstabiger Ländercode für die Ergebnisgewichtung (z. B. de, us). Leer lassen für Brave-Standard.',
        kind: 'text',
      },
      {
        field: 'searchLang',
        label: 'Suchsprache',
        hint: 'Sprachcode der Ergebnisse (z. B. de, en). Leer lassen für Brave-Standard.',
        kind: 'text',
      },
      {
        field: 'timeoutMs',
        label: 'Zeitlimit (ms)',
        hint: 'Abbruch nach dieser Zeit. Ganze Zahl größer 0.',
        kind: 'number',
      },
    ]

    // Farben und Flächen kommen ausschließlich aus den Theme-Tokens des
    // Harness (`--dsw-alias-*`); eigene Hex-Werte wären im jeweils anderen
    // Theme unlesbar.
    const CSS = `
      .braveSearchCard{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
      .braveSearchHead{display:flex;align-items:center;justify-content:space-between;gap:18px;width:100%;box-sizing:border-box;padding:18px 20px 16px;border:none;background:0 0;font:inherit;text-align:left;cursor:pointer;color:inherit}
      .braveSearchHead[aria-expanded="true"]{border-bottom:1px solid var(--dsw-alias-border-l1)}
      .braveSearchHead:hover .braveSearchName{color:var(--dsw-alias-brand-primary)}
      .braveSearchHeadText{min-width:0}
      .braveSearchName{margin:0;font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary)}
      .braveSearchMeta{margin:5px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
      .braveSearchHeadRight{display:inline-flex;align-items:center;gap:12px}
      .braveSearchChevron{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1}
      .braveSearchBadge{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;border-radius:999px;padding:5px 11px;font-size:12px;font-weight:600;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
      .braveSearchBadge.on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
      .braveSearchBadge.off{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
      .braveSearchDot{width:7px;height:7px;border-radius:50%;background:currentColor}
      .braveSearchBody{padding:4px 20px 18px}
      .braveSearchField{display:flex;flex-direction:column;gap:6px;padding:12px 0}
      .braveSearchField + .braveSearchField{border-top:.5px solid var(--dsw-alias-border-l2)}
      .braveSearchLabel{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
      .braveSearchOverride{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.04em;text-transform:uppercase}
      .braveSearchInput{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;min-width:0;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
      .braveSearchInput:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
      .braveSearchInput:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
      .braveSearchInput.invalid{border-color:var(--dsw-alias-label-error)}
      .braveSearchHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
      .braveSearchLine{display:flex;align-items:center;gap:8px}
      .braveSearchLine .braveSearchInput{flex:1}
      .braveSearchToggle{font:inherit;color:var(--dsw-alias-label-secondary);background:0 0;border:none;padding:0;font-size:12px;cursor:pointer}
      .braveSearchToggle:hover{color:var(--dsw-alias-label-primary)}
      .braveSearchActions{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-top:18px}
      .braveSearchButton{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:8px 14px;font:600 13px/1.2 inherit;cursor:pointer}
      .braveSearchButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .braveSearchButton:disabled{opacity:.45;cursor:not-allowed}
      .braveSearchButton.primary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
      .braveSearchButton.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
      .braveSearchNote{margin:14px 0 0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.7}
      .braveSearchError{margin:14px 0 0;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:10px 13px;color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:1.7;overflow-wrap:anywhere}
    `

    if (
      typeof document !== 'undefined'
      && document.querySelector(`style[data-plugin="${CSS_TAG}"]`) === null
    ) {
      const style = document.createElement('style')
      style.dataset.plugin = CSS_TAG
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** The credential reference the section currently names. */
    function refOf(snapshot) {
      const declared = snapshot?.value?.[REF_FIELD]
      return typeof declared === 'string' && declared.trim().length > 0
        ? declared.trim()
        : DEFAULT_API_KEY_REF
    }

    /** Format one section field for display in a text input. */
    function formatField(value) {
      if (typeof value === 'string') return value
      if (typeof value === 'number') return String(value)
      return ''
    }

    /** Parse a draft: `undefined` blocks the save, `null` clears, else the value. */
    function parseDraft(kind, text) {
      const trimmed = text.trim()
      if (kind === 'number') {
        if (trimmed === '') return null
        const parsed = Number(trimmed)
        return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
      }
      return trimmed === '' ? null : trimmed
    }

    /** One labelled field row. */
    function Field(props) {
      return h('div', { className: 'braveSearchField' },
        h('div', { className: 'braveSearchLabel' },
          h('label', { htmlFor: props.id }, props.label),
          props.overridden === true
            ? h('span', { className: 'braveSearchOverride' }, 'überschrieben')
            : null,
        ),
        props.children,
        props.hint === undefined
          ? null
          : h('p', { className: 'braveSearchHint' }, props.hint),
        props.invalid === true
          ? h('p', { className: 'braveSearchHint', role: 'alert' }, 'Wert wird nicht akzeptiert.')
          : null,
      )
    }

    /** The Brave web-search card. */
    function BraveSearchCard(props) {
      const api = props.api
      const [snapshot, setSnapshot] = useState(() => api.scope.getSnapshot())
      const [credential, setCredential] = useState({ ref: '', configured: false, writable: true })
      const [drafts, setDrafts] = useState({})
      const [reveal, setReveal] = useState(false)
      const [open, setOpen] = useState(false)
      const [saving, setSaving] = useState(false)
      const [failed, setFailed] = useState(false)

      useEffect(() => api.scope.subscribe(() => { setSnapshot(api.scope.getSnapshot()) }), [api])

      const ref = refOf(snapshot)

      const readCredential = useCallback(async (target) => {
        let next = { ref: target, configured: false, writable: true }
        try {
          const response = await api.describeKey(target)
          if (response.ok) {
            const view = response.value?.[target]
            next = {
              ref: target,
              configured: view?.configured === true,
              writable: view?.writable !== false,
            }
          }
        } catch {
          // An unreachable Host leaves the badge at "not configured" rather than
          // claiming a key the page cannot verify.
        }
        setCredential((current) => (
          current.ref === next.ref
          && current.configured === next.configured
          && current.writable === next.writable
            ? current
            : next
        ))
      }, [api])

      // Re-read whenever the section names a different reference.
      useEffect(() => { void readCredential(ref) }, [ref, readCredential])

      // The key can be written elsewhere — the Models page addresses the same
      // reference — and the section does not change when it is.
      useEffect(
        () => api.onCredentialUpdate((updated) => {
          if (updated === ref) void readCredential(ref)
        }),
        [api, ref, readCredential],
      )

      const available = snapshot.status === 'ready'
      const writable = available && snapshot.writable === true
      const keyDraft = drafts[KEY_FIELD]
      const keyConfigured = credential.configured

      /** Every staged section field, with its parse result. */
      const plan = FIELDS
        .filter((spec) => drafts[spec.field] !== undefined)
        .map((spec) => ({ field: spec.field, spec, parsed: parseDraft(spec.kind, drafts[spec.field]) }))
      const invalid = plan.some((item) => item.parsed === undefined)
      const keyStaged = typeof keyDraft === 'string' && keyDraft.trim().length > 0
      // Anything the user typed is a draft worth discarding — including a value
      // the field rejects, which must not become a draft with no way back.
      const dirty = Object.keys(drafts).some((field) => (
        field === KEY_FIELD
          ? typeof drafts[field] === 'string' && drafts[field].trim().length > 0
          : drafts[field] !== formatField(snapshot.value?.[field])
      ))

      function edit(field, text) {
        setFailed(false)
        setDrafts((current) => ({ ...current, [field]: text }))
      }

      function discard() {
        setFailed(false)
        setDrafts({})
      }

      async function save() {
        if (saving || invalid || !dirty) return
        setSaving(true)
        setFailed(false)
        let landed = true
        try {
          for (const item of plan) {
            const current = formatField(snapshot.value?.[item.field])
            if (item.parsed === null) {
              if (Object.hasOwn(snapshot.user ?? {}, item.field)) await api.scope.unset(item.field)
              continue
            }
            if (item.parsed === undefined || String(item.parsed) === current) continue
            await api.scope.set(item.field, item.parsed)
          }
          if (keyStaged) {
            await api.setKey(ref, keyDraft.trim())
            await readCredential(ref)
          }
        } catch {
          landed = false
        }
        setSaving(false)
        setFailed(!landed)
        if (landed) setDrafts({})
      }

      return h('section', { className: 'braveSearchCard' },
        h('button', {
          type: 'button',
          className: 'braveSearchHead',
          'aria-expanded': open,
          onClick: () => { setOpen((current) => !current) },
        },
          h('span', { className: 'braveSearchHeadText' },
            // A span, not an h3: a button's content model is phrasing content,
            // and the ARIA role keeps the card's heading for assistive tech.
            h('span', {
              className: 'braveSearchName',
              role: 'heading',
              'aria-level': 3,
            }, 'Websuche (Brave)'),
            h('p', { className: 'braveSearchMeta' },
              'Das Werkzeug web_search holt seine Ergebnisse über die Brave Search API.',
            ),
          ),
          h('span', { className: 'braveSearchHeadRight' },
            h('span', {
              className: keyConfigured ? 'braveSearchBadge on' : 'braveSearchBadge off',
            },
              h('span', { className: 'braveSearchDot' }),
              keyConfigured ? 'Schlüssel hinterlegt' : 'Kein Schlüssel',
            ),
            h('span', { className: 'braveSearchChevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
          ),
        ),
        open ? h('div', { className: 'braveSearchBody' },
          h(Field, {
            id: 'brave-search-key',
            label: 'Brave API-Schlüssel',
            hint: keyConfigured
              ? 'Ein Schlüssel ist im Credential-Speicher hinterlegt. Leer lassen, um ihn zu behalten.'
              : 'Aus der ketch-Konfiguration oder von api-dashboard.search.brave.com. Der Wert wird nur an den Host übertragen und nie zurückgelesen.',
          },
            h('div', { className: 'braveSearchLine' },
              h('input', {
                id: 'brave-search-key',
                className: 'braveSearchInput',
                type: reveal ? 'text' : 'password',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: keyConfigured ? '••••••••  (hinterlegt)' : 'Brave-Subscription-Token',
                disabled: !writable || !credential.writable,
                value: keyDraft ?? '',
                onChange: (event) => { edit(KEY_FIELD, event.target.value) },
              }),
              h('button', {
                type: 'button',
                className: 'braveSearchToggle',
                onClick: () => { setReveal((current) => !current) },
              }, reveal ? 'verbergen' : 'anzeigen'),
            ),
          ),
          FIELDS.map((spec) => {
            const staged = drafts[spec.field]
            const overridden = Object.hasOwn(snapshot.user ?? {}, spec.field)
            const parsed = staged === undefined ? undefined : parseDraft(spec.kind, staged)
            const invalidField = staged !== undefined && parsed === undefined
            return h(Field, {
              key: spec.field,
              id: `brave-search-${spec.field}`,
              label: spec.label,
              hint: spec.hint,
              overridden,
              invalid: invalidField,
            },
              h('input', {
                id: `brave-search-${spec.field}`,
                className: invalidField ? 'braveSearchInput invalid' : 'braveSearchInput',
                type: spec.kind === 'number' ? 'number' : 'text',
                inputMode: spec.kind === 'number' ? 'numeric' : undefined,
                autoComplete: 'off',
                spellCheck: false,
                disabled: !writable,
                value: staged ?? formatField(snapshot.value?.[spec.field]),
                onChange: (event) => { edit(spec.field, event.target.value) },
              }),
            )
          }),
          failed
            ? h('p', { className: 'braveSearchError', role: 'alert' },
                'Speichern fehlgeschlagen. Der Host hat die Änderung nicht übernommen.')
            : null,
          !available
            ? h('p', { className: 'braveSearchNote' },
                'Der Host liefert diesen Namespace noch nicht. Er erscheint, sobald das Plugin geladen ist.')
            : null,
          h('div', { className: 'braveSearchActions' },
            h('button', {
              type: 'button',
              className: 'braveSearchButton primary',
              disabled: saving || invalid || !dirty || !writable || (keyStaged && !credential.writable),
              onClick: () => { void save() },
            }, saving ? 'Speichert …' : 'Speichern'),
            h('button', {
              type: 'button',
              className: 'braveSearchButton',
              disabled: saving || !dirty,
              onClick: discard,
            }, 'Verwerfen'),
          ),
          h('p', { className: 'braveSearchNote' },
            `Namespace ${NS}. Der Schlüssel liegt im Credential-Speicher, nicht in den Einstellungen.`,
          ),
        ) : null,
      )
    }

    /**
     * Build the stable face the card's slot registration injects.
     *
     * Binding the settings scope here — not inside the component — keeps the
     * scope on this plugin's lifecycle, so unloading the plugin disposes it.
     *
     * @param ctx - the browser plugin context.
     * @returns the card's API surface.
     */
    function makeApi(ctx) {
      const credentials = ctx.remote.credentials
      return {
        scope: ctx.settingsScope.bind({ namespace: NS }),
        describeKey: (ref) => credentials.describe([ref]),
        setKey: (ref, value) => credentials.set(ref, value),
        unsetKey: (ref) => credentials.unset(ref),
        onCredentialUpdate: (listener) => ctx.remote.$on('credentials/reference-updated', listener),
      }
    }

    /**
     * Register the card into the Plugins page's configurable tab.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const api = makeApi(ctx)
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        inject: () => ({ api }),
      }, BraveSearchCard))
    }

    exports.inject = ['slots', 'remote', 'remote.credentials', 'settingsScope']
    exports.apply = apply
    return module.exports
  },
})
