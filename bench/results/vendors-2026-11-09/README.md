# Vendor servers, 2026-11-09

The servers big vendors publish themselves, run the way an agent's client meets them:
the menu, a read-only session, and every tool called once.

- **The lists:**
  - `bench/corpus/vendors-npm.tsv`: 62 npm packages.
  - `bench/corpus/vendors-pypi.tsv`: 22 PyPI packages.
  - `bench/corpus/vendors-images.tsv`: 14 container images.

  Each line pins the version run and gives the dummy credentials and arguments it started with: `toolmenu`-valued keys and tokens that open nothing.
- **The scripts:**
  - `bench/scripts/batch-full.sh` (`SEALED=1`, with `PY=1` for PyPI) and `bench/scripts/batch-image.sh`.
  - Both run toolmenu at `518f929` and its parents.
  - The result is built by `bench/scripts/build-vendors.py`.
- **Three passes per server:**
  1. `snapshot` (with `--offline-check`).
  2. `session --auto`, which calls the tools marked read-only, with the network.
  3. A sealed pass, `session --auto --call-everything`, in a container with `--network none`. Every tool is called once, writes included, with made-up input. Nothing a call does can reach a real account: the credentials are dummies and there is no network.
- **What a dummy credential means:**
  - A call that reaches the vendor's API gets a 401 or similar. That tests how the server reports it (`isError`, `session/error-not-flagged`), not the vendor's API.
  - A tool error to made-up input is what the spec asks for.
  - Findings that hold whatever the input (the menu, schemas, results that break their own `outputSchema`, a menu that changes) keep their level.
- **`servers.tsv`:** one row per server.
  - A server that didn't list tools still has a row, with `why` in the server's own words.
  - `sealed_*` columns count how each call in the sealed pass came back.
- **`findings.jsonl`:** every finding, every level, with the pass that made it. In the sealed pass, a failed call or an untested run is info, and a server that stops answering is a warning (`graded`).
- **`status-*.txt`:** the runs' own status lines.
- **`menus/`:** each menu file, for next run's `toolmenu review`.

The hosted vendor endpoints (`bench/results/weekly/2026-11-09/http/`) are a different set: their menus are behind a login for 79 of 109. This set is the vendors' own code, run locally.
