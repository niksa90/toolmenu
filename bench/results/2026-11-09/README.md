# Bench run, 2026-11-09: 270 registry servers

The output of `bench/scripts/batch-full.sh` on the 400 candidates behind
`bench/corpus/registry-2026-11.tsv` (FINDINGS F17).

- **Run with:** toolmenu at commit `20735f3` (0.26.0 plus the unreleased `review` command).
- **Re-graded with:** the rules as of `a1b871e`. Two kinds of finding were re-graded in these files, each marked with a `regraded` field:
  - variance only in fields the model doesn't read: error → warn (`f4479e4`);
  - a missing API key read as a failed step: `session/step-failed` → `session/untested` (`0a7a559`).
- **`tried.json`:** what happened to all 400 candidates.
  - `ok`: started and listed tools (270);
  - `no-menu`: exited before `initialize`, or listed nothing (115);
  - `install-failed` (11);
  - `no-bin`: no command in the package (4).
- **`servers.tsv`:** the 270 that started.
  - `included` is false for the last 20 in the run's random order, past the 250 the report covers. They weren't excluded for any problem.
  - `calls` is the tool calls `session --auto` made; `answered` is how many returned a result.
  - `review` is the verdict on the snapshot against the session's union menu.
- **`findings.jsonl`:** one finding per line, for all 270 servers.
  - `kind`: `spec` (contradicts the protocol schema or a MUST), `client` (a client refuses or cuts it), `behaviour` (toolmenu saw it happen), `heuristic` (names and words), `run` (about the run itself, e.g. nothing could be called).
  - `detail` is cut to its first five lines.
