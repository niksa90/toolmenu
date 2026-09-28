// Reads a project's release version from its manifest, for the Action's
// `release: auto`. Usage: node version.mjs <file name> < contents
// Prints the version, or nothing when the file has no static version
// (a workspace, or a version that comes from git tags).
import { basename } from 'node:path';

export function versionOf(name, text) {
  switch (basename(name)) {
    case 'package.json': {
      try {
        const v = JSON.parse(text).version;
        return typeof v === 'string' ? v : undefined;
      } catch {
        return undefined;
      }
    }
    case 'pyproject.toml':
      return tomlVersion(text, ['project', 'tool.poetry']);
    case 'Cargo.toml':
      return tomlVersion(text, ['package', 'workspace.package']);
    default:
      return undefined;
  }
}

// `version = "1.2.3"` directly under one of the tables. Enough for the common
// case; `version.workspace = true` or `dynamic = ["version"]` give nothing.
function tomlVersion(text, tables) {
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1].trim();
      continue;
    }
    const m = /^version\s*=\s*["']([^"']+)["']/.exec(line);
    if (m && tables.includes(table)) return m[1];
  }
  return undefined;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let input = '';
  process.stdin.on('data', (d) => (input += d)).on('end', () => {
    const v = versionOf(process.argv[2] ?? '', input);
    if (v) process.stdout.write(v);
  });
}
