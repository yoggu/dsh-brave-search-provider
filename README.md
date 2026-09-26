# dsh-brave-search-provider

A local DSH `ctx.web` search provider backed by the Brave Search API, with a
Plugins detail page for its endpoint, locale hints and API key. This package
supplies the Brave search backend only — it is not the model-facing `web_search`
tool or an HTTP fetch provider.

The provider id is `brave`, and the Web app selects it with
`web.searchProvider: brave`. The model-facing `web_search` tool remains
`@deepseek-ai/dsh-tool-web`; this package only supplies its search backend.
Public HTTP fetch remains provided by `@deepseek-ai/dsh-web-fetch-http`.

## Layout

| Path | Half | Role |
| --- | --- | --- |
| `lib/index.js` | Host | Registers the `brave` search provider and installs the `brave-search-provider` settings namespace. |
| `client.js` | Browser | The Brave Search configuration page under Plugins > Installed. |
| `cordis.patch.yml` | Composition | Bundle layer: selects `brave` and inserts this plugin's row. |

`package.json` declares `dsh.bundle.patch` (the composition layer) and
`dsh.client` with `exports["./client"]`, which is how the host discovers and
serves the browser half.

## Where the key lives

The credential-managed API key is **never** part of a composition or of the
settings document; the optional break-glass `apiKey` field is an explicit exception:

- The provider resolves the fixed credential reference `BRAVE_API_KEY` per
  request; the reference itself is not editable in the settings page.
- The literal lives in the DSH credentials store
  (`$DSH_HOME/.credentials.yaml`, mode `600`), or in the environment of the
  launching process.
- The provider resolves it per request through `ctx.credentials.resolve()`.
- The Plugins page writes it through `remote.credentials.set()` and learns
  back only whether a key is configured. The page never receives the literal
  again, so the input stays empty and its placeholder says where the value is.

There is deliberately **no reveal path**. The credentials domain exposes
`describe` / `set` / `unset` and no read, so a stored key cannot be displayed —
and this package adds no route that would: the literal would then sit in the
page, readable by any script running there and by the developer tools, for a
value the user can replace but rarely needs to inspect. The card says so
instead of offering a control that cannot work. The show/hide toggle on the key
field exists only for a value the user has just typed, and disappears as soon
as the field is empty.

A literal `apiKey` in the config remains possible as a break-glass option; it
takes precedence over the store and is marked `secret` in the schema. That one
is readable, because it already lives in the settings document.

## Settings namespace

Namespace `brave-search-provider` is exposed to the live Plugins form while the
Host serves it. The provider reads current settings at the start of every search,
so changes apply **live** without re-registering the provider. The package-facing
identity is `dsh-brave-search-provider`.

| Field | Default | Meaning |
| --- | --- | --- |
| `endpoint` | `https://api.search.brave.com/res/v1/web/search` | Must be HTTPS. |
| `country` | `us` | Two-letter market code sent as `country`; the field must not be empty. |
| `searchLang` | `en` | Language code sent as `search_lang`; the field must not be empty. |
| `timeoutMs` | `30000` | Per-request abort deadline. |
| `apiKey` | – | Optional literal key (role `secret`). |

The configuration page appears under Plugins > Installed only while the Host
serves the namespace.

## Install

1. Link the package into a profile and add it to that profile's bundles:

   ```json
   "dependencies": { "dsh-brave-search-provider": "link:/path/to/dsh-brave-search-provider" },
   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-brave-search-provider"] } }
   ```

2. Give the package's `node_modules/@deepseek-ai` the peers its host half
   imports (`dsh-web`, `dsh-credentials`, `dsh-settings`, `schemastery`,
   `cordis`). Out-of-tree plugins live outside `$DSH_HOME/profiles`, so Node's
   parent walk cannot reach the installation closure; the profile's
   `$DSH_HOME/profiles/node_modules` is the right link target.

3. Select the provider (the bundle patch already does this, and the profile
   patch overrides it for this deployment):

   ```yaml
   - id: web
     config:
       searchProvider: brave
       fetchProvider: http
   ```

4. Store the key once — either in the GUI (Plugins > Installed > Brave Search)
   or directly:

   ```yaml
   # $DSH_HOME/.credentials.yaml
   refs:
     BRAVE_API_KEY: <subscription token>
   ```

5. Restart the Web app once, so the host half installs the settings namespace.
   After that, only client-side changes reload on their own.

## Notes

- `available()` is synchronous and local: it validates the endpoint and never
  makes a network call. A missing key surfaces from `search()` as
  `WEB_PROVIDER_CREDENTIAL_MISSING`.
- Brave caps `count` at 20 per request; the seam still owns final truncation.
- Redirects fail as `WEB_PROVIDER_ERROR` rather than being followed.
