// Renders real toolmenu output, in the colours the CLI prints in a terminal, as an
// animated SVG for the README. Usage: npm run build && node scripts/render-demo.mjs > docs/demo.svg
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const command = ['session', '--scenario', 'examples/unlock.scenario.yml', '--', 'node', 'test/fixtures/session-server.mjs'];
// The fixture stamps the edited description with the time; a fixed one keeps the SVG
// unchanged until toolmenu's output changes. Left out of the command shown.
const pinned = ['--env', 'TOUCHED_AT=2026-09-30T09:41:00Z'];
const run = spawnSync(process.execPath, ['dist/cli.js', ...command.slice(0, 3), ...pinned, ...command.slice(3)], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' },
});
if (!run.stdout) throw new Error(`toolmenu printed nothing: ${run.stderr}`);

// The report as segments of text with the ANSI style they were printed in.
const parse = (line) => {
  const segments = [];
  let style = new Set();
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const code = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!code) {
      if (part) segments.push({ text: part, style: new Set(style) });
      continue;
    }
    for (const c of code[1].split(';')) {
      if (c === '0' || c === '') style = new Set();
      else style.add(c);
    }
  }
  return segments;
};
const plainOf = (segments) => segments.map((s) => s.text).join('');

// An excerpt: the header and the summary, one step in full, and the verdict.
const all = run.stdout.trimEnd().split('\n').map(parse);
const at = (re, from = 0) => all.findIndex((l, i) => i >= from && re.test(plainOf(l)));
const firstStep = at(/^step 1:/);
const shown = at(/^step 3:/);
const after = at(/^step 4:/, shown);
const final = at(/^final:/);
const gap = [{ text: '  ⋮', style: new Set(['2']) }];
const prompt = [{ text: `$ npx toolmenu ${command.join(' ')}`, style: new Set(['prompt']) }];
const lines = [prompt, ...all.slice(0, firstStep), gap, ...all.slice(shown, after), gap, ...all.slice(final)];

// Wrap at word boundaries, keeping each character's style; a continuation sits under
// the text it continues ("→ Next:" lines under their words).
const width = 104;
const wrap = (segments) => {
  const chars = segments.flatMap((s) => [...s.text].map((ch) => ({ ch, style: s.style })));
  const plain = chars.map((c) => c.ch).join('');
  if (plain.length <= width) return [chars];
  const next = /^(\s*→ Next: )/.exec(plain);
  const indent = next ? next[1].length : plain.match(/^\s*/)[0].length + (/^(\$|step \d)/.test(plain) ? 4 : 0);
  const rows = [];
  let start = 0;
  let room = width;
  while (plain.length - start > room) {
    const cut = plain.lastIndexOf(' ', start + room);
    const end = cut > start + 1 ? cut : start + room;
    rows.push(chars.slice(start, end));
    start = plain[end] === ' ' ? end + 1 : end;
    room = width - indent;
  }
  rows.push(chars.slice(start));
  return rows.map((row, i) => (i ? [...[...' '.repeat(indent)].map((ch) => ({ ch, style: new Set() })), ...row] : row));
};
const rows = lines.flatMap(wrap);

const palette = { 31: '#ff7b72', 32: '#7ee787', 33: '#e3b341', 35: '#d2a8ff', 36: '#79c0ff', prompt: '#9fb3c8', dim: '#8b949e', text: '#c9d1d9' };
const fill = (style) => (style.has('prompt') ? palette.prompt : (['31', '32', '33', '35', '36'].map((c) => style.has(c) && palette[c]).find(Boolean) ?? (style.has('2') ? palette.dim : palette.text)));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Runs of characters with the same look, as tspans.
const spans = (row) => {
  const out = [];
  for (const { ch, style } of row) {
    const look = `${fill(style)}|${style.has('1') ? 'b' : ''}${style.has('3') ? 'i' : ''}`;
    if (out.length && out.at(-1).look === look) out.at(-1).text += ch;
    else out.push({ look, text: ch });
  }
  return out
    .map(({ look, text }) => {
      const [colour, flags] = look.split('|');
      return `<tspan fill="${colour}"${flags.includes('b') ? ' font-weight="700"' : ''}${flags.includes('i') ? ' font-style="italic"' : ''}>${esc(text)}</tspan>`;
    })
    .join('');
};

const lh = 18;
const pad = 20;
const top = 44;
const w = Math.ceil(width * 7.8) + pad * 2;
const h = top + rows.length * lh + pad;
// Each row appears in turn, as the run would print it, then the whole report holds
// until the loop starts again. A row is visible by default: where animations don't run
// (or the reader asked for less motion), the picture is the finished report.
const loop = 26; // seconds
const first = 1.2;
const each = 0.16;
const pct = (seconds) => ((seconds / loop) * 100).toFixed(2);
const keyframes = rows
  .map((_, i) => (i === 0 ? '' : `@keyframes r${i}{0%,${pct(first + i * each)}%{opacity:0}${pct(first + i * each + 0.12)}%,97%{opacity:1}100%{opacity:0}}`))
  .join('');
const text = rows
  .map((row, i) => `<text x="${pad}" y="${top + i * lh}" xml:space="preserve"${i ? ` style="animation:r${i} ${loop}s linear infinite"` : ''}>${spans(row)}</text>`)
  .join('\n  ');

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="toolmenu session output (excerpt): a summary of the findings, tools inserted mid-list pinned to the step that caused it, and the next step to fix each">
  <style>${keyframes}@media (prefers-reduced-motion:reduce){text{animation:none!important}}</style>
  <rect width="${w}" height="${h}" rx="10" fill="#0d1117"/>
  <circle cx="22" cy="18" r="6" fill="#ff5f57"/><circle cx="42" cy="18" r="6" fill="#febc2e"/><circle cx="62" cy="18" r="6" fill="#28c840"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13">
  ${text}
  </g>
</svg>
`);
