/*
 * The HTML report (--html <path>): one self-contained page per run of snapshot, diff
 * or session, to keep as a CI artifact or send to someone.
 *
 * Static HTML and CSS: no script, no network. Fonts are asked for by name and fall
 * back to the system's, so the file opens offline and looks the same from a CI
 * artifact as from a laptop. The design follows the Board UI design system (its
 * tokens, type scale and component recipes: stat cards, tables, chips, an alerts
 * panel), with its accent re-tinted to the toolmenu logo's violet and the logo's mint
 * check on clean rows. Light and dark follow the viewer's system setting.
 */
import { agentMenu, isAppOnly } from './apps.js';
import type { ClientCost } from './clients.js';
import { autoSummary } from './auto.js';
import type { DiffResult, DiffTools } from './diff.js';
import { costLine, counts } from './report.js';
import { toolsOf } from './sarif.js';
import { stepsText, type SessionResult, type StepTool } from './session.js';
import type { Finding, Menu, MenuTool, Severity } from './types.js';
import { basename } from 'node:path';
import { VERSION } from './version.js';

export function esc(text: unknown): string {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
/** Backticked names in messages become code. */
const md = (text: string) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
const num = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const upper = (text: string) => text[0].toUpperCase() + text.slice(1);
const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0).toFixed(2);

const SEVERITY: Record<Severity, [string, string]> = { error: ['rose', 'Error'], warn: ['yellow', 'Warning'], info: ['neutral', 'Info'] };

const ICON = {
  tools: '<path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9"/><circle cx="4" cy="5.5" r=".9" fill="currentColor" stroke="none"/><circle cx="4" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="4" cy="14.5" r=".9" fill="currentColor" stroke="none"/>',
  tokens: '<path d="M10 3 17 6.5 10 10 3 6.5Z"/><path d="m3 10 7 3.5 7-3.5M3 13.5 10 17l7-3.5"/>',
  error: '<circle cx="10" cy="10" r="7"/><path d="m7.5 7.5 5 5m0-5-5 5"/>',
  warn: '<path d="M10 3.2 17.5 16H2.5Z"/><path d="M10 8.2v3.3"/><circle cx="10" cy="13.7" r=".6" fill="currentColor"/>',
  tag: '<path d="M3.5 3.5h6l7 7-6 6-7-7Z"/><circle cx="7" cy="7" r="1.1" fill="currentColor" stroke="none"/>',
  break: '<path d="M8 12 6.5 13.5a3 3 0 0 1-4.2-4.2L4 7.6M12 8l1.5-1.5a3 3 0 0 1 4.2 4.2L16 12.4M7 3v2M3 7h2M13 17v-2M17 13h-2"/>',
  steps: '<circle cx="5" cy="5" r="1.8"/><circle cx="5" cy="15" r="1.8"/><path d="M5 6.8v6.4M9 5h8M9 15h8M9 10h5"/>',
};
const icon = (name: keyof typeof ICON) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
const CHECK = '<svg class="check" viewBox="0 0 16 16" role="img" aria-label="No errors or warnings"><polyline points="3.5,8.5 6.6,11.5 12.5,5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
const LOGO = '<svg viewBox="0 0 1024 1024" aria-hidden="true"><rect width="1024" height="1024" rx="232" fill="#6E56CF"/><rect x="150" y="480" width="140" height="64" rx="32" fill="#FFFFFF"/><rect x="250" y="296" width="190" height="432" rx="64" fill="#FFFFFF"/><rect x="400" y="340" width="420" height="68" rx="34" fill="#FFFFFF"/><rect x="400" y="478" width="320" height="68" rx="34" fill="#FFFFFF"/><rect x="400" y="616" width="190" height="68" rx="34" fill="#FFFFFF"/><polyline points="652,650 710,708 836,582" fill="none" stroke="#5EEAB5" stroke-width="68" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const chip = (color: string, text: string, small = true) => `<span class="chip${small ? ' sm' : ''} ${color}">${esc(text)}</span>`;

function stat(name: keyof typeof ICON, label: string, value: string, badge?: [string, string]): string {
  return `<section class="stat"><span class="icon">${icon(name)}</span><div><p class="t-body-m sec">${esc(label)}</p><div class="val"><span class="t-title-1 tnum">${esc(value)}</span>${badge ? chip(badge[0], badge[1], false) : ''}</div></div></section>`;
}

function heading(name: string, version: string | undefined, sub: string[]): string {
  return `<header class="head"><h1 class="t-title-1">${esc(name)}${version ? ` <span class="sec">${esc(version)}</span>` : ''}</h1><p class="sub t-body sec">${sub.map((s) => `<span>${s}</span>`).join('')}</p></header>`;
}

/** Each tool's status mark: an error dot, a warning dot, or the check. One pass over the findings. */
function statuses(findings: Finding[]): (tool: string) => string {
  const worst = new Map<string, Severity>();
  for (const f of findings) for (const t of toolsOf(f)) if (f.severity !== 'info' && worst.get(t) !== 'error') worst.set(t, f.severity);
  return (tool) =>
    worst.get(tool) === 'error' ? '<span class="sdot rose" role="img" aria-label="Has an error"></span>'
      : worst.get(tool) === 'warn' ? '<span class="sdot yellow" role="img" aria-label="Has a warning"></span>'
        : CHECK;
}

/** The steps a finding is at: all of them for one found at several. */
const stepsOf = (f: Finding): number[] => (f.steps?.length ? f.steps : f.step !== undefined ? [f.step] : []);

function tile(f: Finding, id?: string): string {
  const tools = toolsOf(f);
  const steps = stepsOf(f);
  const where = [
    steps.length ? upper(stepsText(steps)) : '',
    tools.length === 1 ? tools[0] : tools.length > 1 ? `${tools.length} tools` : '',
  ].filter(Boolean);
  const [color, label] = SEVERITY[f.severity];
  const tags = [...where.map((w) => chip('soft', w)), ...(f.confidence === 'unsure' ? ['<span class="chip sm soft" title="A heuristic, from names and words">Unsure</span>'] : [])];
  return `<article class="tile"${id ? ` id="${id}"` : ''}>
<div class="tile-top"><span class="mono">${esc(f.rule)}</span>${chip(color, label)}</div>
${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
<p class="t-body2">${md(f.message)}</p>
${f.detail?.length ? `<ul class="detail t-body2">${f.detail.map((d) => `<li>${md(d)}</li>`).join('')}</ul>` : ''}
${f.fix ? `<p class="t-body2 next"><b>Next:</b> ${md(f.fix)}</p>` : ''}
</article>`;
}

function panel(title: string, findings: Finding[], ids?: Map<Finding, string>, openInfo = false): string {
  const loud = findings.filter((f) => f.severity !== 'info');
  const info = findings.filter((f) => f.severity === 'info');
  const c = counts(findings);
  const summary = [c.error && plural(c.error, 'error', 'errors'), c.warn && plural(c.warn, 'warning', 'warnings'), c.info && `${c.info} info`].filter(Boolean).join(', ') || 'None';
  return `<section class="panel" aria-label="${esc(title)}">
<div class="panel-head"><p class="t-body-m sec">${esc(title)}</p><p class="t-title-1">${summary}</p></div>
${loud.map((f) => tile(f, ids?.get(f))).join('\n')}
${info.length ? `<details class="more"${loud.length && !openInfo ? '' : ' open'}><summary><span class="row-gap"><span class="t-body-m">${loud.length ? 'Info findings' : 'All findings are info'}</span>${chip('neutral', String(info.length))}</span>${CHEVRON}</summary><div class="list">${info.map((f) => tile(f, ids?.get(f))).join('\n')}</div></details>` : ''}
${findings.length ? '' : `<div class="empty">${CHECK}<span class="t-body-m">No findings</span></div>`}
</section>`;
}

function card(label: string, value: string, note: string | undefined, table: string, legend?: string, extra = ''): string {
  return `<section class="card">
<div class="card-head"><span class="t-body-m sec">${esc(label)}</span><span class="t-title-1">${esc(value)}</span>${note ? `<span class="t-body2 sec">${esc(note)}</span>` : ''}</div>
${extra}
<div class="scroll">${table}</div>
${legend ? `<div class="card-foot legend t-cap-m sec">${legend}</div>` : ''}
</section>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="toolmenu ${esc(VERSION)}">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
<div class="topbar"><span class="brand">${LOGO}<span class="t-headline">toolmenu</span></span></div>
<main>
${body}
</main>
<footer class="foot t-cap-m sec"><span>toolmenu ${esc(VERSION)}</span><span>Token counts are estimates (o200k_base) of what the model reads.</span><span><a href="https://github.com/niksa90/toolmenu/blob/main/docs/RULES.md">Every rule</a>, or <code>toolmenu explain &lt;rule&gt;</code></span></footer>
</div>
</body>
</html>
`;
}

const isWrite = (t: MenuTool) => (t.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint === false;
const protocolLine = (server: Menu['server']) => (server.protocolVersion ? `Protocol ${esc(server.protocolVersion)}${server.era === 'legacy' ? ', 2025 handshake' : ''}` : '');
const appOnlyChip = '<span class="chip sm neutral" title="MCP Apps visibility without &quot;model&quot;: the agent isn\'t shown it">App only</span>';
const signed = (n: number) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');

export interface SnapshotHtmlOptions {
  /** stdio or http, for the subtitle. */
  transport?: string;
  /** --client: what the menu costs under that client. */
  cost?: ClientCost;
  /** --lists asked for that the server doesn't offer. */
  notOffered?: string[];
  /** Where the menu file was written. */
  outPath?: string;
}

/** The snapshot page. It counts as the text report does: every tool the server lists, app-only ones marked. */
export function snapshotHtml(menu: Menu, findings: Finding[], options: SnapshotHtmlOptions = {}): string {
  const c = counts(findings);
  const { appOnly } = agentMenu(menu);
  const max = Math.max(1, ...menu.tools.map((t) => t.tokens));
  const writes = menu.tools.filter(isWrite).length;
  const status = statuses(findings);
  const rows = menu.tools
    .map((t, i) => `<tr><td class="pos">${i}</td><td class="name">${esc(t.name)}${isAppOnly(t) ? appOnlyChip : isWrite(t) ? chip('purple', 'Writes') : ''}</td><td class="bar"><div class="meter"><span style="width:${pct(t.tokens, max)}%"></span></div></td><td class="num">~${num(t.tokens)}</td><td class="status">${status(t.name)}</td></tr>`)
    .join('\n');
  const table = `<table><thead><tr><th>#</th><th>Tool</th><th>Share of tokens</th><th class="num">Tokens</th><th class="status"><span class="sr">Status</span></th></tr></thead><tbody>${rows}</tbody></table>`;
  const lists = [menu.prompts && plural(menu.prompts.length, 'prompt', 'prompts'), menu.resources && plural(menu.resources.length, 'resource', 'resources'), menu.resourceTemplates && plural(menu.resourceTemplates.length, 'resource template', 'resource templates')].filter(Boolean);
  const notes = [
    appOnly ? `${plural(appOnly.tools, 'tool isn\'t', 'tools aren\'t')} shown to the agent (MCP Apps visibility without "model", ~${num(appOnly.tokens)} tokens).` : '',
    options.cost ? `${upper(costLine(options.cost))}.` : '',
    lists.length ? `Also listed: ${lists.join(', ')}.` : '',
    options.notOffered?.length ? `Not offered by the server: ${options.notOffered.join(', ')}.` : '',
    options.outPath ? `Menu written to ${options.outPath}.` : '',
  ].filter(Boolean);
  const name = menu.server.name ?? 'MCP server';
  const body = `${heading(name, menu.server.version, ['Snapshot', protocolLine(menu.server), esc(options.transport ?? '')].filter(Boolean))}
<div class="stats">
${stat('tools', 'Tools', String(menu.tools.length), writes ? ['purple', plural(writes, 'write tool', 'write tools')] : undefined)}
${options.cost?.upfront !== undefined ? stat('tokens', `Up front, as ${options.cost.label}`, `~${num(options.cost.upfront)}`, ['neutral', `of ~${num(menu.totalTokens)}`]) : stat('tokens', 'Tokens up front', `~${num(menu.totalTokens)}`, ['neutral', 'estimate'])}
${stat('error', 'Errors', String(c.error), c.error ? undefined : ['lime', 'None'])}
${stat('warn', 'Warnings', String(c.warn), c.warn ? undefined : ['lime', 'None'])}
</div>
<div class="main">
${card('Tool menu, in server order', plural(menu.tools.length, 'tool', 'tools'), notes.join(' ') || undefined, table)}
${panel('Findings', findings)}
</div>`;
  return page(`toolmenu snapshot: ${name}`, body);
}

export interface DiffHtmlOptions {
  /** The two menu files, as given on the command line. */
  paths?: [string, string];
}

/**
 * The diff page, from what diffMenus compared and decided (`tools`, from its onTools):
 * the tools after the ignore globs, and which were added, removed and renamed. Token
 * totals are the result's, which leave app-only tools out, as the text report's do.
 */
export function diffHtml(result: DiffResult, tools: DiffTools, options: DiffHtmlOptions = {}): string {
  const old = new Map(tools.before.map((t) => [t.name, t]));
  const added = new Set(tools.added);
  const renamedTo = new Map(tools.renamed.map((r) => [r.to, r.from]));
  const gone = new Set(tools.removed);
  const removed = tools.before.filter((t) => gone.has(t.name));
  const described = new Set(result.findings.filter((f) => f.rule === 'diff/description').flatMap(toolsOf));
  const max = Math.max(1, ...tools.after.map((t) => t.tokens), ...removed.map((t) => t.tokens));
  const rows = tools.after.map((t, i) => {
    const from = renamedTo.get(t.name);
    const was = added.has(t.name) ? undefined : old.get(from ?? t.name)?.tokens;
    const kept = was === undefined ? 0 : Math.min(was, t.tokens);
    const delta = was === undefined ? undefined : t.tokens - was;
    const change = was === undefined ? chip('lime', 'New') : delta! > 0 ? chip('yellow', `+${num(delta!)}`) : delta! < 0 ? chip('soft', `−${num(-delta!)}`) : '<span class="ter">0</span>';
    const tag = from ? `<span class="chip sm rose" title="Was ${esc(from)}">Renamed</span>` : isAppOnly(t) ? appOnlyChip : described.has(t.name) ? chip('purple', 'Description') : '';
    return `<tr><td class="pos">${tools.positions[i] ?? i}</td><td class="name">${esc(t.name)}${tag}${from ? `<div class="t-body2 sec">was ${esc(from)}</div>` : ''}</td><td class="bar"><div class="meter"><span class="grow" style="width:${pct(t.tokens, max)}%"></span><span style="width:${pct(kept, max)}%"></span></div></td><td class="num sec">${was === undefined ? '–' : `~${num(was)}`}</td><td class="num">~${num(t.tokens)}</td><td class="num">${change}</td></tr>`;
  });
  for (const t of removed) {
    rows.push(`<tr class="gone"><td class="pos">–</td><td class="name">${esc(t.name)}</td><td class="bar"><div class="meter"><span class="ghost" style="width:${pct(t.tokens, max)}%"></span></div></td><td class="num sec">~${num(t.tokens)}</td><td class="num sec">–</td><td class="num">${chip('rose', 'Removed')}</td></tr>`);
  }
  const table = `<table><thead><tr><th>#</th><th>Tool</th><th>Now</th><th class="num">Before</th><th class="num">After</th><th class="num">Change</th></tr></thead><tbody>${rows.join('\n')}</tbody></table>`;
  const t = result.tokens;
  const share = t.before > 0 ? (Math.abs(t.delta) / t.before) * 100 : 0;
  const growth = t.before === 0 ? signed(t.delta) : `${t.delta > 0 ? '+' : '−'}${share < 1 ? '<1' : Math.round(share)}%`;
  const grew = tools.after.filter((x) => !added.has(x.name) && x.tokens > (old.get(renamedTo.get(x.name) ?? x.name)?.tokens ?? Infinity)).length;
  const k = result.classes;
  const bump = result.suggestedBump;
  const [v0, v1] = [result.before.version, result.after.version];
  const versions = v0 && v1 ? (v0 === v1 ? `Both report ${esc(v1)}` : `${esc(v0)} → ${esc(v1)}`) : '';
  const file = (path: string) => `<code title="${esc(path)}">${esc(basename(path))}</code>`;
  const files = options.paths ? `${file(options.paths[0])} → ${file(options.paths[1])}` : '';
  // Removing or renaming a tool breaks callers: rose whenever either happened, whatever was added.
  const moves = [added.size && `${added.size} new`, removed.length && `${removed.length} gone`, tools.renamed.length && `${tools.renamed.length} renamed`].filter(Boolean);
  const toolsChip: [string, string] | undefined = moves.length ? [removed.length || tools.renamed.length ? 'rose' : 'lime', moves.join(', ')] : tools.ignored ? ['soft', `${tools.ignored} ignored`] : undefined;
  const name = result.after.name ?? result.before.name ?? 'MCP server';
  const body = `${heading(name, undefined, ['Diff', files, versions].filter(Boolean))}
<div class="stats">
${stat('break', 'Breaking changes', String(k.breaking.changes), k.breaking.changes ? ['rose', plural(k.breaking.tools, 'tool', 'tools')] : ['lime', 'None'])}
${stat('tag', 'Suggested bump', bump === 'none' ? 'None' : upper(bump), k.minor.changes ? ['soft', plural(k.minor.changes, 'minor change', 'minor changes')] : undefined)}
${stat('tools', 'Tools', String(tools.after.length), toolsChip)}
${stat('tokens', 'Tokens up front', `~${num(t.after)}`, t.delta ? [t.delta > 0 ? 'yellow' : 'lime', growth] : ['soft', 'unchanged'])}
</div>
<div class="main">
${card('Token change, per tool', `${signed(t.delta)} tokens`, `${plural(grew, 'tool', 'tools')} grew, ${added.size} new, ${removed.length} removed${tools.renamed.length ? `, ${tools.renamed.length} renamed` : ''} · ~${num(t.before)} → ~${num(t.after)}`, table, '<span><i class="k-bar"></i>Before</span><span><i class="k-mint"></i>Added since</span>')}
${panel('Changes', result.findings)}
</div>`;
  return page(`toolmenu diff: ${name}`, body);
}

/** The session page. `menus`: the menu after each step, from session's onStepMenu. */
export function sessionHtml(result: SessionResult, menus: Map<number, StepTool[]> = new Map()): string {
  const c = counts(result.findings);
  const ids = new Map(result.findings.map((f, i) => [f, `finding-${i + 1}`]));
  const stepsOf = (f: Finding) => (f.steps?.length ? f.steps : f.step !== undefined ? [f.step] : []);
  const byStep = new Map<number, Finding[]>();
  for (const f of result.findings) for (const n of stepsOf(f)) byStep.set(n, [...(byStep.get(n) ?? []), f]);
  const before = byStep.get(0) ?? [];
  const shown = new Set([...result.steps.map((s) => s.index), ...(before.length ? [0] : [])]);
  // One scale for every strip: the tools after a step and those it removed, against the largest.
  const total = (menu: StepTool[]) => menu.reduce((n, t) => n + t.tokens, 0);
  const max = Math.max(1, ...[...menus.values()].map(total));
  const changed = result.steps.filter((s) => s.changed).map((s) => s.index);
  const span = changed.length ? upper(stepsText(changed)) : 'No';
  const strip = (menu: StepTool[] | undefined) =>
    menu ? `<div class="strip" aria-hidden="true">${menu.map((t) => `<span class="${t.change ?? ''}" style="flex-grow:${Math.max(t.tokens, 1)}" title="${esc(t.name)}, ~${num(t.tokens)}${t.change === 'removed' ? ', removed' : ''}"></span>`).join('')}</div>` : '<span class="ter">–</span>';
  const fill = (menu: StepTool[] | undefined) => (menu ? `<div class="fill" style="width:${pct(total(menu), max)}%">${strip(menu)}</div>` : strip(menu));
  // The step's status first: a call answered before the menu couldn't be listed still failed.
  const outcome = (s: SessionResult['steps'][number]) =>
    s.status === 'timed-out' ? chip('yellow', 'Timed out')
      : s.status === 'failed' && s.outcome === 'answered' ? '<span class="chip sm rose" title="The call was answered; listing the menu after it failed">Failed after</span>'
        : s.outcome === 'answered' ? chip('soft', 'Answered')
      : s.outcome === 'tool-error' ? chip('yellow', 'Tool error')
        : s.outcome === 'failed' ? chip('rose', 'Failed')
          : s.outcome === 'not-sent' ? chip('rose', 'Not sent')
            : s.outcome === 'needs-input' ? chip('purple', 'Asked for input')
              : '<span class="ter">–</span>';
  const links = (index: number) => (byStep.get(index) ?? []).map((f) => `<a class="chip sm ${SEVERITY[f.severity][0]}" href="#${ids.get(f)}">${esc(f.rule)}</a>`).join('');
  const rows = result.steps.map((s) => {
    const tags = links(s.index);
    return `<tr class="${s.changed ? 'changed' : ''}"><td class="pos">${s.index}</td><td class="step"><code>${esc(s.label)}</code>${s.note ? `<div class="t-body2 sec">${esc(s.note)}</div>` : ''}${tags ? `<div class="tags">${tags}</div>` : ''}</td><td>${outcome(s)}</td><td>${fill(menus.get(s.index))}</td><td class="num">${s.tools}</td><td class="num">~${num(s.tokens)}</td></tr>`;
  });
  if (before.length) rows.unshift(`<tr><td class="pos">0</td><td class="step"><span class="sec">Before the first step</span><div class="tags">${links(0)}</div></td><td><span class="ter">–</span></td><td><span class="ter">–</span></td><td class="num">${result.baseline.tools}</td><td class="num">~${num(result.baseline.tokens)}</td></tr>`);
  const table = `<table><thead><tr><th>#</th><th>Step</th><th>Call</th><th>Menu after it</th><th class="num">Tools</th><th class="num">Tokens</th></tr></thead><tbody>${rows.join('\n')}</tbody></table>`;
  const grew = result.final.tokens - result.baseline.tokens;
  const fresh = result.connectionCheck === 'same' ? 'A fresh process starts with the same menu.' : result.connectionCheck === 'different' ? 'A fresh process starts with a different menu.' : undefined;
  // Info findings start folded, unless a step row links into them.
  const linkedInfo = result.findings.some((f) => f.severity === 'info' && stepsOf(f).some((n) => shown.has(n)));
  // --auto: what it called and what it left out, as the text report says it.
  const auto = result.auto ? autoSummary(result.auto) : [];
  const autoBlock = auto.length ? `<details class="auto"><summary class="t-body-m">${esc(upper(auto[0].replace(/^auto: /, '')))}</summary>${auto.length > 1 ? `<ul class="t-body2 sec">${auto.slice(1).map((l) => `<li>${esc(l.trim())}</li>`).join('')}</ul>` : ''}</details>` : '';
  const name = result.server.name ?? 'MCP server';
  const body = `${heading(name, result.server.version, ['Session', `<code>${esc(result.scenario)}</code>`, protocolLine(result.server), esc(result.transport)].filter(Boolean))}
<div class="stats">
${stat('error', 'Errors', String(c.error), c.error ? undefined : ['lime', 'None'])}
${stat('warn', 'Warnings', String(c.warn), c.warn ? undefined : ['lime', 'None'])}
${stat('steps', 'Menu changed', span, ['soft', plural(result.steps.length, 'step', 'steps')])}
${stat('tokens', 'Tokens up front', `~${num(result.final.tokens)}`, grew ? [grew > 0 ? 'yellow' : 'lime', `${signed(grew)} in the session`] : ['soft', 'unchanged'])}
</div>
<div class="main">
${card('The scenario, step by step', `${result.baseline.tools} → ${plural(result.final.tools, 'tool', 'tools')}`, fresh, table, '<span><i class="k-bar"></i>A tool, sized by tokens</span><span><i class="k-ins"></i>Inserted mid-list</span><span><i class="k-app"></i>Appended</span><span><i class="k-edit"></i>Edited or moved</span><span><i class="k-rem"></i>Removed</span>', autoBlock)}
${panel('Findings', result.findings, ids, linkedInfo)}
</div>`;
  return page(`toolmenu session: ${name}`, body);
}

const CSS = `
:root{--accent-500:#6E56CF;--mint:#5EEAB5;--text-primary:#0A0A0A;--text-secondary:#737373;--text-tertiary:#A3A3A3;--bg-full:#FFFFFF;--bg-primary:#FFFFFF;--bg-secondary:#F7F7F7;--bg-tertiary:#EBEBEB;--bg-inner:#FFFFFF;--border:#EBEBEB;--separator:#EBEBEB;--track:#EBEBEB;--bar:#6E56CF;--bar-soft:#EBE7FB;--lime-bg:#D9F99D;--lime-text:#3F6212;--rose-bg:#FECDD3;--rose-text:#9F1239;--yellow-bg:#FEF08A;--yellow-text:#854D0E;--purple-bg:#F3E8FF;--purple-text:#9333EA;--dot-rose:#F43F5E;--dot-rose-halo:#FFE4E6;--dot-yellow:#EAB308;--dot-yellow-halo:#FEF9C3;--shadow-card:0 1px 1px 0 rgb(0 0 0 / .05);--font-sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--text-primary:#FAFAFA;--text-secondary:#A3A3A3;--text-tertiary:#8F8F8F;--bg-full:#121212;--bg-primary:#262626;--bg-secondary:#171717;--bg-tertiary:#3A3A3A;--bg-inner:#262626;--border:#404040;--separator:#3A3A3A;--track:#333333;--bar:#9580E2;--bar-soft:#4B3F82;--lime-bg:rgb(26 46 5 / .6);--lime-text:#84CC16;--rose-bg:rgb(76 5 25 / .6);--rose-text:#F43F5E;--yellow-bg:rgb(66 32 6 / .6);--yellow-text:#EAB308;--purple-bg:rgb(88 28 135 / .5);--purple-text:#D8B4FE;--dot-rose-halo:rgb(76 5 25 / .8);--dot-yellow-halo:rgb(66 32 6 / .8);--shadow-card:0 0 0 1px rgb(255 255 255 / .04);color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg-full);color:var(--text-primary);font-family:var(--font-sans);font-size:14px;line-height:20px;-webkit-font-smoothing:antialiased}
p{margin:0}
.t-title-1{font-size:24px;line-height:34px;font-weight:500;margin:0}
.t-headline{font-size:16px;line-height:22px;font-weight:500}
.t-body-m{font-size:14px;line-height:20px;font-weight:500}
.t-body{font-size:14px;line-height:20px;font-weight:400}
.t-body2{font-size:13px;line-height:18px;font-weight:400}
.t-cap-m{font-size:12px;line-height:16px;font-weight:500;letter-spacing:.15px}
.sec{color:var(--text-secondary)}.ter{color:var(--text-tertiary)}.tnum{font-variant-numeric:tabular-nums}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
code,.mono{font-family:var(--font-mono);font-size:12.5px}
a{color:inherit}
:focus-visible{outline:2px solid var(--accent-500);outline-offset:2px;border-radius:6px}
svg{flex:none}
.page{max-width:1200px;margin:0 auto;padding:20px 16px 40px;display:grid;gap:24px}
main{display:grid;gap:24px}
.brand{display:flex;align-items:center;gap:8px}.brand svg{width:28px;height:28px}
.head .sub{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:2px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.stat{display:flex;flex-direction:column;justify-content:space-between;gap:18px;min-height:132px;padding:16px;border-radius:16px;background:var(--bg-secondary);min-width:0}
.stat .icon{display:flex;padding:6px;border-radius:6px;background:var(--bg-primary);align-self:flex-start}
.stat .icon svg{width:20px;height:20px}
.stat .val{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.chip{display:inline-flex;align-items:center;padding:2px 6px;border-radius:6px;white-space:nowrap;font-size:14px;line-height:20px;font-weight:500;text-decoration:none}
.chip.sm{font-size:12px;line-height:16px;letter-spacing:.15px}
.chip.lime{background:var(--lime-bg);color:var(--lime-text)}.chip.rose{background:var(--rose-bg);color:var(--rose-text)}.chip.yellow{background:var(--yellow-bg);color:var(--yellow-text)}.chip.purple{background:var(--purple-bg);color:var(--purple-text)}.chip.neutral{background:var(--bg-tertiary);color:var(--text-secondary)}.chip.soft{background:var(--bg-secondary);color:var(--text-secondary)}
.sdot{display:inline-flex;width:12px;height:12px;border-radius:50%;align-items:center;justify-content:center}
.sdot::after{content:"";width:6px;height:6px;border-radius:50%}
.sdot.rose{background:var(--dot-rose-halo)}.sdot.rose::after{background:var(--dot-rose)}
.sdot.yellow{background:var(--dot-yellow-halo)}.sdot.yellow::after{background:var(--dot-yellow)}
.check{width:16px;height:16px;color:var(--mint)}
.main{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px;align-items:start}
.main>*{min-width:0}
.card{border:1px solid var(--border);border-radius:24px;background:var(--bg-primary);overflow:hidden}
.card-head{display:flex;flex-direction:column;gap:2px;padding:18px 20px 14px}
.card-foot{display:flex;flex-wrap:wrap;gap:6px 16px;padding:12px 20px 16px;border-top:1px solid var(--separator)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.k-bar{background:var(--bar)}.k-mint{background:var(--mint)}.k-ins{background:var(--dot-rose)}.k-app{background:var(--dot-yellow)}.k-edit{box-shadow:inset 0 0 0 1.5px var(--dot-rose)}.k-rem{background:repeating-linear-gradient(135deg,var(--dot-rose) 0 2px,transparent 2px 4px)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;text-align:left}
th{padding:10px 12px;font-size:14px;line-height:20px;font-weight:500;color:var(--text-tertiary);white-space:nowrap;background:var(--bg-secondary);border-top:1px solid var(--separator);border-bottom:1px solid var(--separator)}
td{padding:10px 12px;font-weight:500;vertical-align:middle}
tbody tr:not(:last-child){border-bottom:1px solid var(--separator)}
th:first-child,td:first-child{padding-left:20px}th:last-child,td:last-child{padding-right:20px}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.pos{color:var(--text-tertiary);font-variant-numeric:tabular-nums;width:1%}
td.name{white-space:nowrap}td.name .chip{margin-left:6px}
.status{width:1%;text-align:center}
tr.gone td.name{color:var(--text-secondary);text-decoration:line-through}
.meter{position:relative;height:6px;border-radius:999px;background:var(--track);min-width:90px;overflow:hidden}
.meter span{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:var(--bar)}
.meter span.grow{background:var(--mint)}.meter span.ghost{background:var(--text-tertiary)}
td.bar{width:34%}
.fill{min-width:4px}
.strip{display:flex;overflow:hidden;border-radius:3px;min-width:0}
.strip span{flex-basis:0;min-width:0;height:8px;background:var(--bar-soft);box-shadow:inset -1px 0 0 var(--bg-primary)}
td:has(.fill){min-width:150px}
tr.changed .strip span{background:var(--bar)}
.strip .inserted,tr.changed .strip .inserted{background:var(--dot-rose)}
.strip .appended,tr.changed .strip .appended{background:var(--dot-yellow)}
.strip .edited,.strip .moved,tr.changed .strip .edited,tr.changed .strip .moved{background:transparent;box-shadow:inset 0 0 0 1.5px var(--dot-rose)}
.strip .removed,tr.changed .strip .removed{background:repeating-linear-gradient(135deg,var(--dot-rose) 0 2px,transparent 2px 4px);opacity:.7}
td.step{max-width:280px}td.step code{overflow-wrap:anywhere}
.tags{display:flex;gap:6px;flex-wrap:wrap}td .tags{margin-top:6px}
.panel{background:var(--bg-secondary);border-radius:24px;padding:8px;display:grid;gap:8px}
.panel-head{padding:10px 10px 4px}
.tile{display:grid;gap:6px;padding:12px;border-radius:10px;background:var(--bg-inner);box-shadow:var(--shadow-card);scroll-margin-top:16px}
.tile:target{box-shadow:0 0 0 2px var(--accent-500)}
.tile-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.tile-top .mono{font-weight:500;font-size:13px;overflow-wrap:anywhere}
.tile p{max-width:64ch}
.detail{margin:0;padding:0;list-style:none;display:grid;gap:2px;color:var(--text-secondary);overflow-wrap:anywhere}
.next b{font-weight:500;color:var(--text-secondary)}
details.more>summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;border-radius:10px;background:var(--bg-inner);box-shadow:var(--shadow-card)}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary svg{color:var(--text-secondary);transition:transform .2s ease}
details.more[open]>summary svg{transform:rotate(180deg)}
details.more[open]>summary{margin-bottom:8px}
details.more .list{display:grid;gap:8px}
.row-gap{display:flex;gap:8px;align-items:center}
details.auto{margin:0 20px 14px;padding:10px 12px;border-radius:10px;background:var(--bg-secondary)}
details.auto summary{cursor:pointer}
details.auto ul{margin:8px 0 0;padding-left:18px;display:grid;gap:2px}
.empty{display:flex;gap:8px;align-items:center;padding:12px;border-radius:10px;background:var(--bg-inner);box-shadow:var(--shadow-card)}
.foot{display:flex;flex-wrap:wrap;gap:4px 20px}.foot a{color:var(--accent-500)}
@media (max-width:1000px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.main{grid-template-columns:minmax(0,1fr)}}
@media (max-width:480px){.stat{min-height:116px;padding:14px}.stat .t-title-1{font-size:20px;line-height:28px}td.bar{min-width:110px}}
@media (prefers-reduced-motion:reduce){details.more>summary svg{transition:none}}
@media print{.card,.panel,.stat{break-inside:avoid}details.more::details-content{content-visibility:visible;display:block}}
`;
