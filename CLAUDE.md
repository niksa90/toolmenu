# Working on toolmenu

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
- **Notes**: anything a reviewer should look at twice. Optional.

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
- Apologies, hedging piles ("should hopefully mostly"), and recaps of the commit log.

**Before and after:**

> ~~Three review rounds. The last two had no cap on the number of findings, and the 38
> findings across all three rounds are fixed. Not verified here: the workflows on real
> runners (this PR's CI is the first run).~~
>
> Tests: `npm test`, 598 passing; pages checked in light, dark and at phone width.
> The workflow changes run for the first time in this PR's CI.

Commit messages follow the same rules: what and why, no process.
