# Bench run, 2026-11-09: 1,600 registry candidates, 1,090 servers

The output of `bench/scripts/batch-full.sh` on `bench/corpus/registry-2026-11.tsv`: the
first 1,600 npm stdio servers from the MCP registry, in a seeded random order, that need no
credentials and weren't in an earlier corpus (FINDINGS F17).

- **Run with:** toolmenu at commit `acaa34c`, the same build for every server.
- **Re-graded with:** the rules as of `c021a3f` and the commit after it. Each finding a later rule changes carries a `regraded` field:
  - a mid-session edit only in a field the model doesn't read: `session/edit` error → warn (55);
  - a setup failure read as a failed step ("needs credentials", "no browser found", "not a git repository", "the extension is not connected"): `session/step-failed` → `session/untested` (4).
- **`tried.json`:** what happened to each of the 1,600:
  - `ok`: started and listed tools (1,090);
  - `no-menu`: exited before `initialize`, or listed nothing (463);
  - `install-failed` (39);
  - `no-bin`: no command in the package (8).
- **`servers.tsv`:** the 1,090 that started.
  - `calls` is the tool calls `session --auto` made; `answered` is how many returned a result.
  - `review` is the verdict on the snapshot against the session's union menu.
- **`findings.jsonl`:** one finding per line.
  - `kind`: `spec` (contradicts the protocol or MCP Apps schema, or a MUST), `client` (a client refuses or cuts it), `behaviour` (toolmenu saw it happen), `heuristic` (names and words), `run` (about the run itself, e.g. nothing could be called).
  - `detail` is cut to its first five lines.

The earlier 270-server data (a build from before six fixes) is at commit `acaa34c`.
