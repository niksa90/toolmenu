---
name: release-check
description: Before releasing, tagging or publishing an MCP server, check with toolmenu what changed in its tool list since the last release, whether it breaks clients, and whether the version bump is big enough. Use when asked if a change is breaking, what version to release, or to prepare an MCP server release.
---

# Checking an MCP server release

toolmenu compares the server's tool list now with the last release's, and reports
what breaks clients (removed tools, new required parameters, narrowed types), what
changes for agents, the token change per conversation, and the version bump it needs.

## 1. Find the baseline

The menu of the last release, in this order:

1. A committed `menu.json` (or the path `toolmenu.config.json` or the CI workflow's
   `baseline:` input names). Check it matches the last release: `git log -1 -- menu.json`
   against the last tag. If it was updated after the tag, use the tag's copy:
   `git show <last tag>:./menu.json > /tmp/baseline.json` (`./`: the path from the
   current folder, not the repository root).
2. No baseline: build the last release in a separate worktree
   (`git worktree add /tmp/last-release <last tag>`), build it there, snapshot it with
   `snapshot_menu` (`cwd` that worktree, `save_as` an absolute path outside the repo),
   then `git worktree remove /tmp/last-release`.
3. A package with releases on npm and no tags: `npx -y toolmenu history <package>`
   researches the published versions.

Say which baseline you used.

## 2. Compare

1. Build the server as it is now.
2. `snapshot_menu` with `save_as: "new-menu.json"` (see check-mcp-menu for `command`,
   `url`, `cwd` and credentials).
3. `diff_menus` with `before` the baseline, `after: "new-menu.json"`, and `release`
   set to `<last version>..<planned version>` when both are known (from the last tag
   and `package.json`, `pyproject.toml`, `Cargo.toml`…). Without `release`, toolmenu
   suggests the bump but can't check it.
4. Delete `new-menu.json`.

Without the toolmenu MCP tools: `npx -y toolmenu snapshot --out new-menu.json -- <command>`
and `npx -y toolmenu diff <baseline> new-menu.json --release <old>..<new>`.

## 3. Report

Lead with the verdict, then the evidence:

- **Blockers**: breaking changes when the planned bump is too small (a breaking change
  needs a major; in 0.x a minor), and any `error` finding. Say which bump it needs.
- **Breaking changes** worth a release note even when the bump is right: list them.
- **Token change** per conversation ("adds ~1,240 tokens to every conversation").
- What's only a notice (description edits, new optional parameters).

Don't change the version, tag or publish yourself unless asked. After the release,
offer to update the baseline: `snapshot_menu` with `save_as: "menu.json"`, committed
with the release, so the next comparison starts from it.
