# Weekly baseline, 2026-11-09

The first weekly run's starting point; `CHANGES.md` in later weeks compares against it.

- **`http/`:** the hosted panel (`bench/corpus/http-panel.tsv`): 109 vendor endpoints, and a seeded 2,000 from the registry's long tail.
  - Run with toolmenu `df0654c` (`bench/scripts/batch-http.sh`).
  - The auth checks of the 774 servers that answered 401, and the sessions of the 5 with `session/output-schema` findings, were then rerun with `1861ef1`, so their findings follow the current rules.
  - `menus/` keeps the vendors' menu files, for next week's `toolmenu review`.
- **`stdio/`:** the 1,090 stdio servers of `bench/results/2026-11-09`, with the sealed pass that calls every tool (added when that run finishes).
