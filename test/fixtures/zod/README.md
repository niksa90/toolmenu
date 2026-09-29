# zod 3 → 4, as an MCP SDK server lists it

The same 27 tool inputs (one tool per construct: `int`, `nullableObject`,
`discriminated`, `record`, `strictObject`, `email`, `tuple`, `any`…) written with
zod 3 (`zod/v3`) and zod 4 (`zod/v4`) from zod 3.25.76, which ships both, and
converted by `@modelcontextprotocol/sdk` 1.29's `toJsonSchemaCompat` with the
options `McpServer` uses for `tools/list` (`strictUnions: true`, `pipeStrategy:
'input'`). Built from the PR #15 review's zod generator; `test/diff.test.mjs`
pins what `diff` says about the upgrade.
