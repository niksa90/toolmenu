// Renders real toolmenu output as a terminal-style SVG for the README.
// Usage: npm run build && node scripts/render-demo.mjs > docs/demo.svg
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const command = ['session', '--scenario', 'examples/unlock.scenario.yml', '--', 'node', 'test/fixtures/session-server.mjs'];
// The fixture stamps the edited description with the time; a fixed one keeps the SVG
// unchanged until toolmenu's output changes. Left out of the command shown.
const pinned = ['--env', 'TOUCHED_AT=2026-09-30T09:41:00Z'];
const run = spawnSync(process.execPath, ['dist/cli.js', ...command.slice(0, 3), ...pinned, ...command.slice(3)], { cwd: root, encoding: 'utf8' });
if (!run.stdout) throw new Error(`toolmenu printed nothing: ${run.stderr}`);
const lines = [`$ npx toolmenu ${command.join(' ')}`, ...run.stdout.trimEnd().split('\n')];

const palette = {
  prompt: '#9fb3c8',
  error: '#ff7b72',
  warn: '#e3b341',
  info: '#79c0ff',
  step: '#f0f6fc',
  title: '#f5c451',
  next: '#7ee787',
  dim: '#8b949e',
  text: '#c9d1d9',
};

// Each output line gets one colour; the pieces it wraps into keep it.
const colourOf = (line) => {
  if (line.startsWith('$')) return palette.prompt;
  if (/^\s*ERROR/.test(line)) return palette.error;
  if (/^\s*WARN/.test(line)) return palette.warn;
  if (/^\s*INFO/.test(line)) return palette.info;
  if (/^\s*→ Next:/.test(line)) return palette.next;
  if (/^(step \d|final:)/.test(line)) return palette.step;
  if (/^toolmenu /.test(line)) return palette.title;
  if (/^✗/.test(line)) return palette.error;
  if (/^✓/.test(line)) return palette.next;
  if (/^\s{10,}\S/.test(line)) return palette.dim;
  return palette.text;
};

// Wrap long lines at word boundaries (step lines at their " · " separators first),
// keeping the indent; a "→ Next:" line continues under its text.
const width = 108;
const wrap = (line) => {
  if (line.length <= width) return [line];
  const next = /^(\s*→ Next: )/.exec(line);
  const indent = next ? ' '.repeat(next[1].length) : line.match(/^\s*/)[0] + (line.startsWith('$') || /^step \d/.test(line) ? '    ' : '');
  const out = [];
  let rest = line;
  while (rest.length > width) {
    const dot = /^step \d/.test(line) || out.length ? rest.lastIndexOf(' · ', width) : -1;
    const cut = dot > indent.length ? dot : rest.lastIndexOf(' ', width);
    const at = cut > indent.length ? cut : width;
    out.push(rest.slice(0, at));
    rest = indent + rest.slice(at).replace(/^ (· )?/, (m, sep) => (sep ? '· ' : ''));
  }
  return [...out, rest];
};
const rows = lines.flatMap((line) => wrap(line).map((piece) => ({ piece, colour: colourOf(line) })));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// "· unsure" is dimmed, so a guess reads as one.
const body = (s) => esc(s).replace(/ · unsure/g, ` <tspan fill="${palette.dim}">· unsure</tspan>`);
const lh = 18;
const pad = 20;
const top = 44;
const w = Math.ceil(width * 7.8) + pad * 2;
const h = top + rows.length * lh + pad;
const text = rows
  .map(({ piece, colour }, i) => `<text x="${pad}" y="${top + i * lh}" fill="${colour}" xml:space="preserve">${body(piece)}</text>`)
  .join('\n  ');

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="toolmenu session output: tools inserted mid-list, a description edited, each pinned to the step that caused it, with the next step to fix it">
  <rect width="${w}" height="${h}" rx="10" fill="#0d1117"/>
  <circle cx="22" cy="18" r="6" fill="#ff5f57"/><circle cx="42" cy="18" r="6" fill="#febc2e"/><circle cx="62" cy="18" r="6" fill="#28c840"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13">
  ${text}
  </g>
</svg>
`);
