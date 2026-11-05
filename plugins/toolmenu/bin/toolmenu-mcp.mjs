#!/usr/bin/env node
// Starts toolmenu's MCP server from the toolmenu release this plugin pins in
// package-lock.json, which Claude Code installs next to this file.
process.argv.splice(2, process.argv.length - 2, 'mcp');
await import('toolmenu/dist/cli.js');
