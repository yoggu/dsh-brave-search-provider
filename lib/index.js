/**
 * Brave-backed search provider for the DeepSeek Harness web capability seam
 * (`ctx.web`).
 *
 * The provider registers under the stable id `brave`, which the composition
 * selects with `web.searchProvider`. Its endpoint, locale hints, timeout and
 * credential reference live in the `web-search-brave` settings namespace, so
 * the settings page (Settings > Plugins > Plugin configuration) can change
 * them without a restart: the provider reads the section through a thunk at
 * the start of every search rather than snapshotting it at registration.
 *
 * The API key itself never rides the settings document. Only its *reference*
 * (`apiKeyEnv`, role `credential-ref`) is stored there; the literal lives in
 * the credentials store and is resolved per request. The browser half writes
 * it through the credentials domain, so it is never echoed back to the page.
 *
 * @module dsh-web-search-brave
 */
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-brave'

/**
 * The web seam is the hard dependency. The credential store is read through
 * `ctx.get` instead of being injected, so a deployment without it still
 * registers the provider and can serve a literal `apiKey` from the config.
 */
export const inject = ['web']

/** Stable provider id this plugin registers into `ctx.web`. */
export const BRAVE_PROVIDER_ID = 'brave'

/** Settings namespace carrying this provider's endpoint and key reference. */
export const WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE = 'web-search-brave'

/** Brave's Web Search endpoint. */
export const BRAVE_DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/** Credential reference resolved when the section names none. */
export const BRAVE_DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY'

/** Upper bound on how long one search may take. */
export const BRAVE_DEFAULT_TIMEOUT_MS = 30_000

/** Brave's own ceiling on `count`; asking for more is an error on their side. */
const MAX_BRAVE_RESULTS = 20

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness-web-search-brave/0.1.0'

const DEFAULT_KEY_ENV = BRAVE_DEFAULT_API_KEY_ENV
const DEFAULT_ENDPOINT = BRAVE_DEFAULT_ENDPOINT
const DEFAULT_TIMEOUT_MS = BRAVE_DEFAULT_TIMEOUT_MS

/**
 * The editable surface of the provider. `apiKey` is a break-glass literal for
 * a deployment that has no credential store; the reference is what the
 * settings card writes.
 */
export const Config = z.object({
  // dsh-settings exposes only volatile fields to the live web settings form.
  // The schema values are Loader config refs, so the provider reads them with
  // `.get()` below instead of keeping a stale snapshot.
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_KEY_ENV).volatile(),
  endpoint: z.string().default(DEFAULT_ENDPOINT).volatile(),
  country: z.string().volatile(),
  searchLang: z.string().volatile(),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS).volatile(),
})

/** A trimmed, non-empty string, or `undefined` for anything else. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function webError(message, code, cause) {
  return new WebError(message, code, cause === undefined ? undefined : { cause })
}

/**
 * Project one resolved section into the options the next search runs with.
 * Environment fallbacks are deliberately absent: everything the provider reads
 * is already fully defaulted here, so a section can never half-apply.
 *
 * @param config - the currently authoritative section.
 * @returns the provider's options for one search.
 */
function resolveOptions(config) {
  const literalApiKey = nonEmptyString(config?.apiKey)
  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    apiKeyEnv: credentialRef(nonEmptyString(config?.apiKeyEnv) ?? DEFAULT_KEY_ENV),
    endpoint: nonEmptyString(config?.endpoint) ?? DEFAULT_ENDPOINT,
    country: nonEmptyString(config?.country),
    searchLang: nonEmptyString(config?.searchLang),
    timeoutMs: Number.isInteger(config?.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS,
  }
}

/**
 * Resolve one search's credential. The literal wins over the store, and a
 * missing store is not an error here: the caller reports one stable message.
 *
 * @param ctx - plugin context carrying the (optional) credential store.
 * @param options - this search's options.
 * @returns the key, or `undefined` when the deployment holds none.
 */
async function resolveKey(ctx, options) {
  if (options.apiKey !== undefined) return options.apiKey
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const resolved = await credentials.resolve(options.apiKeyEnv)
  return nonEmptyString(resolved?.value)
}

function abortError(signal, cause) {
  return webError('Brave Search request aborted', 'WEB_ABORTED', signal?.reason ?? cause)
}

/** Brave rejects `count > 20`; the seam's own truncation stays authoritative. */
function resultCount(request) {
  if (!Number.isInteger(request.maxResults) || request.maxResults < 1) return MAX_BRAVE_RESULTS
  return Math.min(request.maxResults, MAX_BRAVE_RESULTS)
}

/** Map one Brave web result onto the seam's source shape. */
function sourceFromResult(item) {
  const url = nonEmptyString(item?.url)
  if (url === undefined) return undefined

  const title = nonEmptyString(item?.title)
  const snippet = nonEmptyString(item?.description)
  const publishedAt = nonEmptyString(item?.page_age ?? item?.published ?? item?.age)

  return {
    url,
    ...(title === undefined ? {} : { title }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  }
}

/**
 * The Brave-backed search provider.
 *
 * `resolveOptions` is a thunk rather than a value because the settings section
 * can change between searches; re-registering the provider to carry a new
 * endpoint would make the seam's selection observable as a flicker.
 */
export class BraveSearchProvider {
  id = BRAVE_PROVIDER_ID

  /**
   * @param ctx - plugin context supplying the credential store.
   * @param resolveOptions - the options for the NEXT operation.
   */
  constructor(ctx, resolveOptions) {
    this.ctx = ctx
    this.resolveOptions = resolveOptions
  }

  /**
   * Availability is deliberately local and synchronous: it never makes a
   * network request, and credential availability is answered by `search`.
   * @returns whether the configured endpoint can be used at all.
   */
  available() {
    const options = this.resolveOptions()
    let endpoint
    try {
      endpoint = new URL(options.endpoint)
    } catch {
      return false
    }
    return endpoint.protocol === 'https:'
  }

  /**
   * Run one search.
   * @param request - the seam's normalized request.
   * @param signal - caller cancellation.
   * @returns the mapped sources.
   */
  async search(request, signal) {
    const options = this.resolveOptions()
    if (signal?.aborted === true) throw abortError(signal)

    const apiKey = await resolveKey(this.ctx, options)
    if (apiKey === undefined) {
      throw webError(
        `Brave Search has no API key for "${options.apiKeyEnv}"; enter it in Settings > Plugins > Plugin configuration > Web search (Brave), or store it in the DSH credentials store`,
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    if (signal?.aborted === true) throw abortError(signal)

    let endpoint
    try {
      endpoint = new URL(options.endpoint)
    } catch (error) {
      throw webError(`Invalid Brave Search endpoint: ${String(error)}`, 'WEB_PROVIDER_ERROR', error)
    }
    if (endpoint.protocol !== 'https:') {
      throw webError('Brave Search endpoint must use HTTPS', 'WEB_PROVIDER_ERROR')
    }
    endpoint.searchParams.set('q', request.query)
    endpoint.searchParams.set('count', String(resultCount(request)))
    if (options.country !== undefined) endpoint.searchParams.set('country', options.country)
    if (options.searchLang !== undefined) endpoint.searchParams.set('search_lang', options.searchLang)

    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(
      () => controller.abort(new Error('Brave Search request timed out')),
      options.timeoutMs,
    )

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'x-subscription-token': apiKey,
          'user-agent': USER_AGENT,
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        let detail = ''
        try {
          const body = await response.json()
          detail = nonEmptyString(body?.message ?? body?.error?.detail ?? body?.error) ?? ''
        } catch {
          // Keep the stable HTTP error when the provider body is not JSON.
        }
        throw webError(
          `Brave Search API error (HTTP ${response.status})${detail.length === 0 ? '' : `: ${detail}`}`,
          'WEB_PROVIDER_ERROR',
        )
      }

      const body = await response.json()
      const sources = (Array.isArray(body?.web?.results) ? body.web.results : [])
        .map(sourceFromResult)
        .filter((source) => source !== undefined)

      return { sources, truncated: false }
    } catch (error) {
      if (signal?.aborted === true) throw abortError(signal, error)
      if (controller.signal.aborted === true) {
        throw webError('Brave Search request timed out', 'WEB_PROVIDER_ERROR', error)
      }
      if (error?.code !== undefined) throw error
      if (error?.name === 'AbortError') {
        throw webError('Brave Search request aborted', 'WEB_ABORTED', error)
      }
      throw webError(`Brave Search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', error)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Register the Brave provider into `ctx.web` and publish its settings section.
 *
 * The section is installed only once the settings service exists, and the
 * provider is registered unconditionally: a deployment without settings still
 * searches with its composition config.
 *
 * @param ctx - the plugin context.
 * @param config - the composition layer of the `web-search-brave` section.
 */
export function apply(ctx, config) {
  // Since dsh 0.1.7 settings are projected from the live Loader config.
  // `config` therefore contains schema refs, not a plain object.
  ctx.web.registerSearchProvider(new BraveSearchProvider(ctx, () => resolveOptions({
    apiKey: config.apiKey.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    endpoint: config.endpoint.get(),
    country: config.country.get(),
    searchLang: config.searchLang.get(),
    timeoutMs: config.timeoutMs.get(),
  })))
}
