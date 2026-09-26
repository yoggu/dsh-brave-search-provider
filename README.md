# dsh-brave-search-provider

Brave Search API backend for DSH's `ctx.web` search. It supplies the search provider, **not** the model-facing `web_search` tool or HTTP fetch provider. The bundle selects `brave` for Web searches and adds a **Plugins → Brave Search** settings page.

## Install from GitHub

```sh
dsh plugin --profile web add https://github.com/yoggu/dsh-brave-search-provider.git
```

Restart DSH Web if necessary and reload the page. Provide a Brave Search API subscription key in **Plugins → Brave Search**. The key is saved under `BRAVE_API_KEY` in DSH's credential store; alternatively set `BRAVE_API_KEY` in the DSH process environment. The settings page reports whether a key exists but does not reveal it. Never commit a key to the repository or profile patch.

To uninstall: `dsh plugin --profile web remove dsh-brave-search-provider`.

## Configuration

The settings page configures country (default `us`), search language (default `en`) and request timeout (default 30 seconds). The backend calls only Brave's HTTPS web-search endpoint, does not follow redirects and resolves the key for each request. DSH's `@deepseek-ai/dsh-tool-web` still provides the model-facing search tool.

## Tests and license

Run `npm test` after installing the DSH peer dependencies. MIT; see [LICENSE](LICENSE).
