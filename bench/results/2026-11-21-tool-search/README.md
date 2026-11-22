# Bench run, 2026-11-19 to 21: how clients search tools (FINDINGS F23)

Three parts. Only the first two use toolmenu; the third measures two vendors' hosted
tool search directly.

## `one-server.tsv`: each server's tools, Claude's search and Codex's

16 servers from the committed 2026-11-09 menus (`../weekly/2026-11-09/`, the `menu_file`
column). Each tool is searched for by the words of its own name (`ownNamePlaces`, as
`search/findable` does), once ranked the way Claude's tool search ranks (name, description,
argument names and descriptions; top 5) and once the way Codex's does (name, title,
description, top-level argument names; top 8; Codex source at `3869f39`).
`missed_*` count the tools outside each top; `differing_tools` lists those one finds and the
other misses, with both places. Built with toolmenu at the commit that adds this folder.

## `across-servers.jsonl`: several servers loaded together

Two sets of the same menus, pooled as an agent with all of them loaded searches them
(`search/outranked`, `src/rules/cross.ts`): Atlassian, GitHub, Sentry and Azure DevOps
(`dev`); Notion, Supabase, Stripe, Slack and HubSpot (`docs-and-db`). One line per finding,
with `--client claude-api-search,codex`.

## `openai/` and `gemini/`: the vendors' hosted tool search, measured

Raw Responses API (`openai/`) and Interactions API (`gemini/`) responses, with the scripts
that sent the requests (`*.py`; the API keys were injected by a proxy or read from the
environment and appear nowhere here). Tools are made up (a `crm` namespace of 30 deferred
functions and a `billing` one of 10; look-alike `jira`/`github` namespaces), so nothing
here depends on a real server. Models: gpt-5.4 and gpt-6.2-astra; gemini-3.6-flash and
gemini-4-hydrogen. Two runs per case unless a file name says `retry`; some
gemini-3.6-flash runs failed with Google's "high demand" error and were retried once
(those error responses are kept).
