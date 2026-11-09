# Weekly baseline, 2026-11-09

The first weekly run's starting point; `CHANGES.md` in later weeks compares against it.

- **`http/`:** the hosted panel (`bench/corpus/http-panel.tsv`): 109 vendor endpoints, and a seeded 2,000 from the registry's long tail.
  - Run with toolmenu `df0654c` (`bench/scripts/batch-http.sh`).
  - The auth checks of the 774 servers that answered 401, and the sessions of the 5 with `session/output-schema` findings, were then rerun with `1861ef1`, so their findings follow the current rules.
  - `menus/` keeps the vendors' menu files, for next week's `toolmenu review`.
- **`stdio/`:** the 1,090 stdio servers of `bench/results/2026-11-09`, run again with toolmenu `3b338ac`, now with the sealed pass that calls every tool (`SEALED=1`). 1,089 started; the sealed pass ran on 1,057 (32 wouldn't start without the network).
  - 15,566 of the 16,518 tools were called (94.2%).
  - Findings that later rules change are re-graded and marked `regraded`. In the sealed pass, a failed call, an untested run or a "rate limit" offline is info, and a server that stops answering is a warning.
  - `sealed_*` columns in `servers.tsv` count how each server's calls came back.
