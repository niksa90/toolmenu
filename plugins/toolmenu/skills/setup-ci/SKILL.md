---
name: setup-ci
description: Add toolmenu to an MCP server's CI so every pull request gets a comment with breaking tool-list changes, token growth and findings. Use when asked to set up checks, CI or a GitHub Action for an MCP server, or to keep its tool list from breaking clients.
---

# Adding toolmenu to an MCP server's CI

`toolmenu init` sets it up in one command: it snapshots the server into `menu.json`
(the baseline) and writes `.github/workflows/toolmenu.yml`, which runs the toolmenu
GitHub Action on every pull request. The Action posts one comment that updates on
each push: breaking changes, the token change, the version bump and findings.

## 1. Find how the server starts

- The command CI should run, after its build: from `package.json` (`bin`, `main`,
  `scripts.start`), `pyproject.toml` (`[project.scripts]`), `Cargo.toml`, the README,
  or an MCP client config in the repo (`.mcp.json`). Prefer the built output
  (`node dist/server.js`) over a dev runner (`tsx src/server.ts`).
- An HTTP-only server: the URL CI can reach. A `localhost` URL only works if the
  workflow starts the server first; prefer the stdio command when there is one.
- In a monorepo, run init in the server's package folder: the workflow goes to the git
  root, the baseline and the server's start folder stay in the package.

## 2. Run init

Build the server, then from its folder (Node 22+):

```
npx -y toolmenu init -- node dist/server.js
```

or `npx -y toolmenu init https://example.com/mcp` for HTTP. Pass what the server needs
with `--env KEY=value` (stdio) or `--header "Name: value"` (HTTP): init writes each
value into the workflow as a `${{ secrets.… }}` reference, never as text, and says
which secrets to add. `--with-session` also runs `session --auto` in CI, for a server
whose tool list changes while it runs.

init never overwrites a file. If `menu.json` or the workflow exists, say so and stop;
don't delete them to make init succeed.

## 3. Hand over

From init's output, tell the user:

- The two files to commit: `menu.json` and `.github/workflows/toolmenu.yml`.
- Each secret to add (GitHub: Settings → Secrets and variables → Actions), by name.
- Anything init listed as not working on the runner (a file outside the repo, a
  `localhost` URL, a local virtualenv), with its fix.
- That the first pull request gets the comment; the baseline is updated by committing
  a new `menu.json` (`toolmenu snapshot`) when a change is intended.

Don't commit, push or add secrets yourself unless asked.
