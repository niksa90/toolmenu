# Bench run, 2026-11-19: server instructions, and the 0.28.1 handshake fallback

Two passes over the hosted (Streamable HTTP) servers of the 2026-11-09 run
(`../weekly/2026-11-09/http/servers.tsv`), each listing only: no tool was called, no
credentials were sent (`--no-auth`), one connection per server (`--processes 1`).

## `instructions/unknown-name` (FINDINGS F22)

- **The servers:** the 1,120 marked `open` on 2026-11-09. 1,078 listed tools this time.
- **Run with:** `snapshot --json --lists resources --processes 1 --no-auth --timeout 30000`,
  at commit `5c5f393` for every server, then the 19 it fired on again at `08547c2` (that
  commit only removes findings: an API key or account in the sentence, a full stop inside
  a URL, a dotted field path).
- **`servers.tsv`:** one line per server. `menu` is `listed` or `no-menu`; `unknown_names`
  the names the rule reports for it, at `08547c2`.
- **`findings.jsonl`:** every `instructions/unknown-name` finding at `08547c2`: 16 servers.

The first pass of the rule, before it left out fields, values, subcommands, prompts and
names in a sentence that explains them, fired on 52 of these servers.

## The handshake fallback (0.28.1)

- **The servers:** the 733 marked `oauth` with no tools on 2026-11-09.
- **Run with:** `snapshot --json --processes 1 --no-auth --timeout 30000`, built from
  `62d1a48` (0.28.1, whose fallback gives a `server/discover` refused with 401 or 403 a 2025
  `initialize`). Partway through, the build was replaced by one that only added rules; how
  a server is connected to and listed didn't change.
- **`login-rerun.tsv`:** `menu_2026-11-19` is `listed` or `no-menu`. For the five that list,
  `server_discover` is the HTTP status a `server/discover` request got, sent by hand the
  same day: 401 for the three the fallback reaches, 400 for two that answer it as 2025
  servers do, which 0.28.0 already handled.
