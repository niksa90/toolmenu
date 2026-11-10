# Bench run, 2026-11-10: `snapshot --read-resources` on 53 servers that list resources

Every server in the committed 2026-11-09 menus (`../weekly/2026-11-09/`) that lists at
least one resource, plus `@dpantani/tdmcp@0.13.2`, the server the check was written for
(FINDINGS F21).

- **Run with:** toolmenu at commit `2c41bab`, the same build for every server:
  `snapshot --lists resources --read-resources --processes 1 --timeout 30000`.
- **The servers:** 36 container images (33 from Docker's MCP catalog, 3 vendors'), 13 npm
  packages (12 vendors' and tdmcp), 4 hosted.
- **Two passes for the local ones.** `sealed`: the container has no network
  (`--network none`). `open`: it has one, behind this host's TLS-inspecting proxy, which
  most servers' own HTTP clients don't trust; their reads fail as the network and are
  counted as unread. Dummy credentials in both (`toolmenu`), as in the 2026-11-09 runs.
- **The hosted ones** got `--max-reads 5`: five reads each, spread over the list.
- **`servers.tsv`:** one line per server and pass. `read` is the reads sent, `by_apps`
  the listed `ui://` resources the MCP Apps check read instead, `unreadable` and `schema`
  the findings of those rules, `unread` the resources `lists/resource-unread` counts.
  `no-menu`: the server didn't start or list tools in that pass (three, all without a
  network).
- **`findings.jsonl`:** every `lists/resource-*` finding, one per line.

A first run of the same servers, on the build before `6eb3cb2`, is what that commit
answers: it warned about servers whose reads failed for the run's reasons.
