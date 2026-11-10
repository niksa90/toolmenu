# Working on toolmenu

Notes for anyone changing this repository, people and coding agents alike. `CLAUDE.md`
imports this file; other agents read it directly.

## The project in one paragraph

toolmenu tests MCP servers the way agents and clients meet them: it connects, lists
the menu, calls tools, checks results against the spec and the tool's own schemas,
walks OAuth discovery, and compares menus across calls, processes, clients and
releases. It's deterministic: no LLM anywhere, so the same server gives the same
findings on every run.

## Where things are

- `src/cli.ts`, `src/help.ts`, `src/options.ts`: commands and flags.
- `src/snapshot.ts`, `src/session.ts`, `src/diff.ts`, `src/review.ts`, `src/auth-check.ts`:
  the commands' engines.
- `src/rules/`: one file per family of menu rules, registered in `src/rules/index.ts`.
  Session and diff findings are made in `session.ts` and `diff.ts`.
- `src/clients.ts`: `--client` profiles. Every value carries its source URL and read date.
- `src/report.ts`, `src/sarif.ts`, `src/junit.ts`, `src/html.ts`: output formats. The
  Action's PR comment is the markdown format.
- `schemas/`: the official MCP JSON schemas, pinned per protocol version.
- `test/`: `node:test`, one file per area; `test/fixtures/` has the fixture servers.
- `bench/`: corpora, scripts and committed results of runs against real servers.
- `docs/RULES.md` (every rule), `docs/PROTOCOLS.md` (generated), `docs/SPEC.md` (frozen
  v1.0 spec, with dated notes).
- `docs/snapshot.md`, `session.md`, `diff.md`, `clients.md`, `usage.md`, `ci.md`,
  `github-action.md`: the reference, one page per command or area.
- `plugins/toolmenu/`: the Claude Code plugin (skills, evals, the pinned release).

## README and docs

- The README is the pitch: what toolmenu catches, one finding, CI, the commands in a
  table, the bench in a paragraph. A new flag, rule or option goes in its `docs/` page,
  and gets a README line only if it changes what toolmenu is for.
- A number in the README comes from `docs/FINDINGS.md` or a committed dataset, and says
  what it doesn't show.
- Pictures are made from real output: `node scripts/render-demo.mjs > docs/demo.svg` for
  the terminal demo; `scripts/social-preview.html` at 1280x640 for
  `docs/social-preview.png`. README images use `raw.githubusercontent.com/.../main/`
  URLs so they show on npm.
- The Action's version pin (`niksa90/toolmenu@v…`) is in `README.md`,
  `docs/github-action.md` and `docs/ci.md`.

## Commands

- `npm run build`: compiles and regenerates the rule docs.
- `npm test`: builds, then runs everything (about 700 tests, several minutes).
- `node --test test/<file>.test.mjs`: one area, after a build.
- `UPDATE_DOCS=1 node --test test/protocols.test.mjs`: rewrites `docs/PROTOCOLS.md`. Needed
  whenever the set of rules changes; the test fails until it's done.

## Adding or changing a rule

1. The rule, in the right file under `src/rules/` (or `session.ts` / `diff.ts`), registered
   in `src/rules/index.ts`.
2. A row in `docs/RULES.md`; a test checks every rule has one and every row is a rule.
3. Tests against a fixture server: each way it fires and each way it must stay quiet,
   through the CLI (finding, severity, message, next step).
4. `docs/PROTOCOLS.md` regenerated.
5. A CHANGELOG line under Unreleased.
6. For a rule that could fire on real servers: run it on the bench and read every finding
   it adds before it ships.

## What counts as a finding

- Every finding rests on one of three things: the protocol (the official schema, or a
  MUST/SHOULD in the spec text), a named client's own documentation or source, or
  behaviour toolmenu saw happen (the step, the call, the process that differed).
- **error**: a client fails, or a MUST is broken. **warn**: likely to bite, or a SHOULD.
  **info**: worth knowing, or the run itself (nothing called, no credentials).
- Heuristics (names, wording) are never errors, and are marked unsure when they guess.
- A client profile value needs a source URL and a read date. A number that only forum
  posts or third-party sites state stays out until the client documents it.
- Messages say what toolmenu saw and what it costs, then a `→ Next:` step. They don't
  speculate about intent.

## The bench

- Third-party servers run only in containers. The pass that calls every tool runs with
  `--network none` and dummy credentials (values like `toolmenu` that open nothing).
- Hosted servers get read-only calls only, a few per server.
- Before reporting a finding from the bench, rule out the run itself: a dummy key, no
  network, a server started with the wrong command or arguments, the host's own network
  limits. Read the raw output (`snapshot.json`, `*-err.txt`) and check the version.
- Scripts are read while they run: don't edit one that a batch is using.
- Reports and issue drafts about other projects stay out of the repository; the datasets
  are the record.

## Pull request descriptions


Write them the way one maintainer writes to another: what changed, why, how you know it
works, and what to watch. Plain, short, a little dry. Someone reading it in a year, with
no other context, should understand it.

**Shape** (the template in `.github/pull_request_template.md`):

- **What**: the change, in a few bullets. Name the commands, flags, rules or files a
  reader will look for.
- **Why**: the problem it solves, in a sentence or two. A real case beats a general claim
  ("`@paypal/mcp` builds its date defaults when it lists tools, so the menu never
  matches twice").
- **Breaking**: only if something is. What breaks and what to do instead.
- **Tests**: what covers it and the result (`npm test`: 698 passing). If something isn't
  covered yet, say what, as a plain fact: "Windows paths aren't covered; CI will tell."
- **Notes**: a place in the diff a reviewer should read twice. Optional, and usually absent.

**Voice:**

- First person plural or no person at all. "Adds", "Fixes", "We now…", not "I was asked
  to…".
- Dry is fine, sparingly: one understated line beats three exclamation marks. "The old
  pattern was optimistic about dots." Never at a user's or another project's expense.
- No marketing words (powerful, seamless, robust, comprehensive), no emoji headers.
- Numbers over adjectives: "136 tools, over VS Code's 128", not "a large menu".

**Leave out:**

- How the work was produced: conversations, prompts, "as discussed", "the user asked",
  review rounds and how many findings they had, which assistant or MCP server helped.
  The diff and the tests are the record.
- The environment it was written in: sandboxes, blocked hosts, missing tools, "I couldn't
  run X here". If a check is still owed, list it under Tests as something to run, not as
  an obstacle you met.
- Anything not public: unfiled issues against other projects, private reports and their
  links, bench data that isn't committed, people's names who didn't ask to be named.
- What happens next: scheduled runs, release steps ("after merge, tag v…"), to-do lists,
  things that haven't run yet. The description covers what this change is, as merged.
- Asides for the maintainer: repository size, whether to keep a file, "worth a look
  if…". Raise those in conversation, not in the description.
- A "generated by" footer or a session link.
- Apologies, hedging piles ("should hopefully mostly"), and recaps of the commit log.

**Before and after:**

> ~~Three review rounds. The last two had no cap on the number of findings, and the 38
> findings across all three rounds are fixed. Not verified here: the workflows on real
> runners (this PR's CI is the first run).~~
>
> Tests: `npm test`, 598 passing; pages checked in light, dark and at phone width.
> The workflow changes run for the first time in this PR's CI.

Commit messages follow the same rules: what and why, no process.
