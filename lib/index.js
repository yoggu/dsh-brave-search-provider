/**
 * Brave-backed search provider for the DeepSeek Harness web capability seam
 * (`ctx.web`).
 *
 * The provider registers under the stable id `brave`, which the composition
 * selects with `web.searchProvider`. Locale hints and timeout live in the
 * `brave-search-provider` settings namespace, so the Brave Search detail page
 * under Plugins can change them without a restart: the provider reads the
 * current section at the start of every search rather than snapshotting it at
 * registration.
 *
 * The API key never rides the settings document. Its fixed credential
 * reference (`BRAVE_API_KEY`) is resolved per request from the credentials
 * store or process environment. The browser half writes it through the
 * credentials domain, so it is never echoed back to the page.
 *
 * @module dsh-brave-search-provider
 */
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'

/**
 * Cordis plugin name used by loader diagnostics.
 */
export const name = 'brave-search-provider'

/**
 * The web seam is the hard dependency. The credential store is read through
 * `ctx.get` instead of being injected, so a deployment without it still
 * registers the provider but reports a missing credential at search time.
 */
export const inject = ['web']

/** Stable provider id this plugin registers into `ctx.web`. */
export const BRAVE_PROVIDER_ID = 'brave'

/** Settings namespace carrying this provider's endpoint and locale hints. */
export const BRAVE_SEARCH_PROVIDER_SETTINGS_NAMESPACE = 'brave-search-provider'

/** Brave's Web Search endpoint. */
export const BRAVE_DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/** Fixed credential reference used by this provider. */
export const BRAVE_DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY'

/** Default market sent to Brave when no composition value is supplied. */
export const BRAVE_DEFAULT_COUNTRY = 'us'

/** Default language sent to Brave when no composition value is supplied. */
export const BRAVE_DEFAULT_SEARCH_LANG = 'en'

/** Default and maximum abort deadlines for one search. */
export const BRAVE_DEFAULT_TIMEOUT_MS = 30_000
export const BRAVE_MAX_TIMEOUT_MS = 60_000

/** Brave's own ceiling on `count`; asking for more is an error on their side. */
const MAX_BRAVE_RESULTS = 20

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness-brave-search-provider/0.1.4'

const DEFAULT_ENDPOINT = BRAVE_DEFAULT_ENDPOINT
const DEFAULT_COUNTRY = BRAVE_DEFAULT_COUNTRY
const DEFAULT_SEARCH_LANG = BRAVE_DEFAULT_SEARCH_LANG
const DEFAULT_TIMEOUT_MS = BRAVE_DEFAULT_TIMEOUT_MS

/**
 * Only this endpoint is allowed: arbitrary HTTPS targets can be internal
 * services or attacker-controlled hosts receiving the subscription token.
 */
function validEndpoint(value) {
  return value === DEFAULT_ENDPOINT
}

function validCountry(value) {
  return typeof value === 'string' && /^[a-z]{2}$/.test(value)
}

function validSearchLang(value) {
  return typeof value === 'string' && /^[a-z]{2}$/.test(value)
}

/**
 * Only non-secret request preferences are editable in live settings.
 * The schema values are Loader config refs, so the provider reads them with
 * `.get()` below instead of keeping a stale snapshot.
 */
export const Config = z.object({
  country: z.string().default(DEFAULT_COUNTRY).volatile(),
  searchLang: z.string().default(DEFAULT_SEARCH_LANG).volatile(),
  timeoutMs: z.number().step(1).min(1).max(BRAVE_MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS).volatile(),
})

/** A trimmed, non-empty string, or `undefined` for anything else. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function webError(message, code) {
  return new WebError(message, code)
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
  return {
    apiKeyEnv: credentialRef(BRAVE_DEFAULT_API_KEY_ENV),
    endpoint: DEFAULT_ENDPOINT,
    country: config?.country ?? DEFAULT_COUNTRY,
    searchLang: config?.searchLang ?? DEFAULT_SEARCH_LANG,
    timeoutMs: Number.isInteger(config?.timeoutMs) && config.timeoutMs > 0 && config.timeoutMs <= BRAVE_MAX_TIMEOUT_MS
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS,
  }
}

/**
 * Resolve one search's credential. A missing store is not an error here:
 * the caller reports one stable message.
 *
 * @param ctx - plugin context carrying the (optional) credential store.
 * @param options - this search's options.
 * @returns the key, or `undefined` when the deployment holds none.
 */
async function resolveKey(ctx, options) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const resolved = await credentials.resolve(options.apiKeyEnv)
  return nonEmptyString(resolved?.value)
}

function abortError() {
  return webError('Brave Search request aborted', 'WEB_ABORTED')
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
 * can change between searches; re-registering for new locale or timeout
 * settings would make the seam's selection observable as a flicker.
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
    return validEndpoint(this.resolveOptions().endpoint)
  }

  /**
   * Run one search.
   * @param request - the seam's normalized request.
   * @param signal - caller cancellation.
   * @returns the mapped sources.
   */
  async search(request, signal) {
    const options = this.resolveOptions()
    if (signal?.aborted === true) throw abortError()

    if (!validEndpoint(options.endpoint)) {
      throw webError('Brave Search endpoint must be the official Brave Web Search API URL', 'WEB_PROVIDER_ERROR')
    }
    if (!validCountry(options.country) || !validSearchLang(options.searchLang)) {
      throw webError('Brave Search country and search language must be two lowercase letters', 'WEB_PROVIDER_ERROR')
    }

    let apiKey
    try {
      apiKey = await resolveKey(this.ctx, options)
    } catch {
      if (signal?.aborted === true) throw abortError()
      // Credential providers may include secret material in their errors.
      throw webError('Brave Search credential lookup failed', 'WEB_PROVIDER_ERROR')
    }
    if (apiKey === undefined) {
      throw webError(
        `Brave Search has no API key for "${options.apiKeyEnv}"; enter it in Plugins > Installed > Brave Search, or store it in the DSH credentials store`,
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    if (signal?.aborted === true) throw abortError()

    const endpoint = new URL(DEFAULT_ENDPOINT)
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

    let responseError
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
        // Upstream errors and even status values are untrusted. Never read the
        // body or interpolate a non-numeric status into a user-visible error.
        const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
          ? response.status
          : 'unknown'
        responseError = webError(`Brave Search API error (HTTP ${status})`, 'WEB_PROVIDER_ERROR')
        throw responseError
      }

      const body = await response.json()
      const sources = (Array.isArray(body?.web?.results) ? body.web.results : [])
        .map(sourceFromResult)
        .filter((source) => source !== undefined)

      return { sources, truncated: false }
    } catch (error) {
      if (signal?.aborted === true) throw abortError()
      if (controller.signal.aborted === true) {
        throw webError('Brave Search request timed out', 'WEB_PROVIDER_ERROR')
      }
      if (error === responseError) throw error
      // Network exceptions and causes are untrusted and may echo request data.
      throw webError('Brave Search request failed', 'WEB_PROVIDER_ERROR')
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
 * @param config - the composition layer of the `brave-search-provider`
 *   host/runtime section.
 */
export function apply(ctx, config) {
  // Since dsh 0.1.7 settings are projected from the live Loader config.
  // `config` therefore contains schema refs, not a plain object.
  ctx.web.registerSearchProvider(new BraveSearchProvider(ctx, () => resolveOptions({
    country: config.country.get(),
    searchLang: config.searchLang.get(),
    timeoutMs: config.timeoutMs.get(),
  })))
}
