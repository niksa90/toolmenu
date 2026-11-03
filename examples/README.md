# Examples

- `menu.json`: the committed baseline for `test/fixtures/sdk-server.mjs`. toolmenu's
  own CI runs the Action against it on every PR, so the PR comment shows what the
  report looks like.
- `unlock.scenario.yml`: the unlock pattern from lesson 05, for
  `test/fixtures/session-server.mjs`.
- `parallel.scenario.yml`: a read-only session against a hosted HTTP search server,
  described below.

## Hosted HTTP: Parallel Search MCP

An example of a hosted server that needs no account:
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) answers
anonymously (web search in Fast mode, and page fetching). The scenario checks the menu
across a search, a fetch of a fixed documentation URL, and the same search again. It
needs Node 22 or later and network access; no local MCP server is needed.

From the root of this repository, snapshot the live menu:

```sh
npx --yes toolmenu snapshot https://search.parallel.ai/mcp --no-auth --out parallel-menu.json
```

`--no-auth` keeps this example anonymous even if you have a saved login for the
endpoint. The snapshot lists the tools and their findings, and saves
`parallel-menu.json` for later comparisons with `toolmenu diff`.

Preview the scenario without connecting, then run it:

```sh
npx --yes toolmenu session https://search.parallel.ai/mcp \
  --scenario examples/parallel.scenario.yml --plan --no-auth

npx --yes toolmenu session https://search.parallel.ai/mcp \
  --scenario examples/parallel.scenario.yml --no-auth
```

The scenario keeps `allow_writes: false` and calls only tools marked
`readOnlyHint: true`. Each step lists the menu afterwards, so the report shows
whether search or fetch changed it. The fetch uses a fixed URL because scenarios
do not pass one call's results into the next. No LLM selects the calls.

These are real requests to a live service with anonymous usage limits, so this
example isn't run in CI. If a call fails, inspect its outcome and findings before
interpreting the menu as stable. Toolmenu exits `0` for a clean report, `1` for
findings at or above `--fail-on`, and `2` for connection or usage errors. A saved
snapshot or an unchanged menu alone does not mean every tool call succeeded.

Behind a proxy, Node's `fetch` uses `HTTPS_PROXY` only with `NODE_USE_ENV_PROXY=1`
(Node 22.21 and later); toolmenu says so when every host fails to resolve.
