# Changelog

## 0.7.0 (first release)

- `snapshot`: lists the menu twice, checks it against the official schema for its
  protocol version (2024-11-05 to 2026-07-28), and runs the menu rules: determinism,
  buried instructions, vague and invented IDs, unannotated writes, routing
  (`routes.yml`).
- `session`: runs a scripted session and reports every mid-session menu change with
  the step that caused it, where in the list it happened and the cached prefix it
  affects; flags per-connection changes ruled out by 2026-07-28. `--init` writes a
  starter scenario that finds unlock tools and unlocks for real.
- `diff`: breaking, minor and notice changes between two menus, the token change,
  and a suggested semver bump, checked against release versions (`--release`).
- `history`: installs, snapshots and diffs an npm package's published versions.
- GitHub Action: one PR comment, updated on every push, with the version-bump check
  in any language (`release: auto`).
- Formats: text, json, github annotations, markdown.
