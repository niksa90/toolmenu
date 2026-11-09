# bench: toolmenu against real servers

Every rule change in toolmenu is checked against real MCP servers before it ships, as
well as against the fixtures in `test/`. This folder holds what that takes, so anyone can
run it again. Not part of the npm package.

**Run it in a container or a throwaway VM.** The scripts install third-party packages
from npm and PyPI and start them as servers. Some write files where they start; each runs
from its own folder for that reason.

## The corpus

| File | What | Servers |
|---|---|---|
| `corpus/registry.tsv` | Recent stdio servers from the MCP registry (npm), no required credentials, that started and listed their tools | 86 |
| `corpus/npm-popular.tsv` | MCP servers on npm by downloads | 60 |
| `corpus/pypi.tsv` | Recent stdio servers on PyPI | 37 |
| `corpus/registry-2026-11.tsv` | npm stdio servers from the MCP registry, new to the bench, needing no credentials, in a seeded random order: every command on each with `scripts/batch-full.sh`. 1,090 of the 1,600 start (results in `results/2026-11-09/`, FINDINGS F17) | 1,600 |
| `corpus/hosted.tsv` | Hosted (Streamable HTTP) servers from the MCP registry that declare no required headers, one per host, sampled with a fixed seed | 200 |

Each line: `id<TAB>package@version` (npm) or `package==version` (PyPI)`<TAB>repository`;
for `hosted.tsv`, `id<TAB>url`.
Versions are pinned, so a rerun checks the same code.

The `session --auto` corpus is the servers across all three lists that answer the
2026-07-28 handshake (`snapshot --json` reports `protocolVersion` `2026-07-28`): 39 at
the last run, 13 from the registry list, 9 from the popular npm list, 17 from PyPI.

## Running

```sh
npm run build
# npm servers: install each, then snapshot (or session)
bench/scripts/batch.sh bench/corpus/registry.tsv /tmp/scan snapshot
bench/scripts/batch.sh bench/corpus/registry.tsv /tmp/scan session
# PyPI servers (needs uv)
bench/scripts/batch-py.sh bench/corpus/pypi.tsv /tmp/scan-py
# Summary of one run
python3 -I bench/scripts/summarize.py bench/corpus/registry.tsv /tmp/scan
```

To check a change: keep a run of the released version, run the change under another
output name (`--json` output in each server's folder), and compare them:

```sh
python3 -I bench/scripts/compare.py /tmp/scan out-before.json out-after.json
python3 -I bench/scripts/compare.py /tmp/scan session-before.json session-after.json session
```

It prints each server whose findings, tokens or tool count differ (for `session`: steps
and their outcomes). Every difference is read by hand before a release: a rule that
changes a finding on a real server has to say why in the changelog.

`TOOLMENU=/path/to/cli.js` runs another build than this checkout's.

Hosted servers are only listed (`snapshot`, no tool calls), or called read-only with
`session --auto --max-calls 10`:

```sh
cut -f1,2 bench/corpus/hosted.tsv | xargs -P 10 -L 1 sh -c \
  'mkdir -p /tmp/hosted/$0 && node dist/cli.js snapshot --json --no-write --no-auth --lists prompts,resources "$1" > /tmp/hosted/$0/snap.json'
```

Behind a proxy, Node's `fetch` only goes through `HTTPS_PROXY` with
`NODE_USE_ENV_PROXY=1` (Node 22.21 and later); without it every host fails to resolve,
and toolmenu says so.

## The reference server

`@modelcontextprotocol/server-everything` is the reference implementation of the protocol.
Pinned: **2.1.0** (2026-10-28, protocol 2026-07-28).

```sh
npm install --prefix /tmp/everything @modelcontextprotocol/server-everything@2.1.0
E=/tmp/everything/node_modules/.bin/mcp-server-everything
node dist/cli.js snapshot --no-write --lists prompts,resources -- $E
node dist/cli.js session --auto -- $E
# Its elicitation and sampling demos are marked readOnlyHint: false, so --auto
# never calls them; this scenario does, with allow_writes.
node dist/cli.js session --scenario bench/everything.scenario.yml -- $E
```

What toolmenu reported on 2.1.0, each checked by hand:

| Run | Result |
|---|---|
| `snapshot --lists` | 22 tools, 4 prompts, 7 resources, 3 resource templates. `spec/deprecated` for the logging capability (deprecated by SEP-2577). `get-header-params`' `x-mcp-header` is valid: no finding. Lists stable and matching the schema. Info only: shared words, an `elicitationId` no tool returns, "Deprecated" notes past character 280 |
| `session --auto` | 12 calls, all answered except `get-roots-list`, which returns `-32021` for the roots capability the request doesn't declare: counted as a client gap (`session/untested`), not the server's |
| `session --scenario` | Form, multi-step and URL elicitation each declined once, then answered (the multi-step one with a tool error saying the user declined: the right answer, no finding). Sampling, roots and the async demo's `extensions` capability each `-32021` |

No finding on the reference server is a false one. A change that makes one appear there
is wrong until shown otherwise.
