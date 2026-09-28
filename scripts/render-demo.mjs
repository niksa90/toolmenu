// Renders real toolmenu output as a terminal-style SVG for the README.
// Usage: npm run build && node scripts/render-demo.mjs > docs/demo.svg
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const command = ['session', '--scenario', 'examples/unlock.scenario.yml', '--', 'node', 'test/fixtures/session-server.mjs'];
const run = spawnSync(process.execPath, ['dist/cli.js', ...command], { cwd: root, encoding: 'utf8' });
const lines = [`$ npx toolmenu ${command.join(' ')}`, ...run.stdout.trimEnd().split('\n')];

// Wrap long lines at word boundaries, keeping their indent.
const width = 104;
const wrapped = lines.flatMap((line) => {
  if (line.length <= width) return [line];
  const indent = line.match(/^\s*/)[0] + (line.startsWith('$') ? '    ' : '');
  const out = [];
  let rest = line;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(' ', width);
    const at = cut > indent.length ? cut : width;
    out.push(rest.slice(0, at));
    rest = indent + rest.slice(at).trimStart();
  }
  return [...out, rest];
});

const colour = (line) => {
  if (line.startsWith('$')) return '#9fb3c8';
  if (/^\s*ERROR/.test(line)) return '#ff7b72';
  if (/^\s*WARN/.test(line)) return '#e3b341';
  if (/^\s*INFO/.test(line)) return '#79c0ff';
  if (/^step \d/.test(line)) return '#f0f6fc';
  if (/^toolmenu /.test(line)) return '#f5c451';
  return '#c9d1d9';
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lh = 18;
const pad = 20;
const top = 44;
const w = Math.ceil(width * 7.8) + pad * 2;
const h = top + wrapped.length * lh + pad;
const text = wrapped
  .map((line, i) => `<text x="${pad}" y="${top + i * lh}" fill="${colour(line)}" xml:space="preserve">${esc(line)}</text>`)
  .join('\n  ');

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="toolmenu session output: tools inserted mid-list, a description edited, each pinned to the step that caused it">
  <rect width="${w}" height="${h}" rx="10" fill="#0d1117"/>
  <circle cx="22" cy="18" r="6" fill="#ff5f57"/><circle cx="42" cy="18" r="6" fill="#febc2e"/><circle cx="62" cy="18" r="6" fill="#28c840"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13">
  ${text}
  </g>
</svg>
`);
