import { canonical, compareMenus } from './compare.js';
import type { Finding, JsonSchema, Menu, MenuTool, Severity } from './types.js';
import { SEVERITY_RANK } from './types.js';

export type ChangeClass = 'breaking' | 'minor' | 'notice';
export type Bump = 'major' | 'minor' | 'patch' | 'none';

export interface DiffFinding extends Finding {
  class?: ChangeClass;
}

interface DiffRule {
  severity: Severity;
  class?: ChangeClass;
}

/** Every diff rule, its default severity and what it means for semver. */
export const DIFF_RULES: Record<string, DiffRule> = {
  'diff/tool-removed': { severity: 'error', class: 'breaking' },
  'diff/tool-renamed': { severity: 'error', class: 'breaking' },
  'diff/param-removed': { severity: 'error', class: 'breaking' },
  'diff/param-required': { severity: 'error', class: 'breaking' },
  'diff/param-type': { severity: 'error', class: 'breaking' },
  'diff/enum-narrowed': { severity: 'error', class: 'breaking' },
  'diff/safety-hint': { severity: 'error', class: 'breaking' },
  'diff/tool-added': { severity: 'info', class: 'minor' },
  'diff/param-added': { severity: 'info', class: 'minor' },
  'diff/param-relaxed': { severity: 'info', class: 'minor' },
  'diff/enum-widened': { severity: 'info', class: 'minor' },
  'diff/type-widened': { severity: 'info', class: 'minor' },
  'diff/description': { severity: 'info', class: 'notice' },
  'diff/param-dropped': { severity: 'info', class: 'notice' },
  'diff/schema-other': { severity: 'info', class: 'notice' },
  'diff/annotations': { severity: 'info', class: 'notice' },
  'diff/other': { severity: 'info', class: 'notice' },
  'diff/order': { severity: 'info', class: 'notice' },
  'diff/version-bump': { severity: 'warn' },
  'diff/token-budget': { severity: 'error' },
};

export interface TokenChange {
  before: number;
  after: number;
  delta: number;
  /** Largest per-tool changes first. */
  tools: { name: string; before: number; after: number; delta: number }[];
}

export interface DiffResult {
  before: Menu['server'];
  after: Menu['server'];
  findings: DiffFinding[];
  tokens: TokenChange;
  suggestedBump: Bump;
  actualBump?: Bump;
  /** The versions the bump was checked against, and where they came from. */
  release?: { before: string; after: string; source: 'release' | 'server' };
  /** Why the bump wasn't checked although versions were given (calendar versions…). */
  bumpNotChecked?: string;
}

export interface DiffOptions {
  rules?: Record<string, Severity | 'off'>;
  ignore?: string[];
  tokenBudget?: number;
  /**
   * The release (artifact) versions: npm, a git tag. The server-reported
   * version (serverInfo.version) often isn't one (FINDINGS F5), so the bump is
   * only checked against it when serverVersionIsRelease is set.
   */
  release?: { before: string; after: string };
  serverVersionIsRelease?: boolean;
}

type Raw = { rule: string; tool?: string; message: string; detail?: string[] };

export function diffMenus(before: Menu, after: Menu, options: DiffOptions = {}): DiffResult {
  const raw: Raw[] = [];
  const oldByName = new Map(before.tools.map((t) => [t.name, t]));
  const newByName = new Map(after.tools.map((t) => [t.name, t]));

  const removed = before.tools.filter((t) => !newByName.has(t.name));
  const added = after.tools.filter((t) => !oldByName.has(t.name));
  const renames = findRenames(removed, added);
  const renamedFrom = new Set(renames.map((r) => r.from.name));
  const renamedTo = new Set(renames.map((r) => r.to.name));

  for (const { from, to } of renames) {
    raw.push({ rule: 'diff/tool-renamed', tool: to.name, message: `${from.name} was renamed to ${to.name} (same parameters). Agents, saved prompts and evals that call ${from.name} break.` });
  }
  for (const t of removed.filter((t) => !renamedFrom.has(t.name))) {
    raw.push({ rule: 'diff/tool-removed', tool: t.name, message: `${t.name} was removed. Anything that calls it breaks.` });
  }
  for (const t of added.filter((t) => !renamedTo.has(t.name))) {
    raw.push({ rule: 'diff/tool-added', tool: t.name, message: `${t.name} was added (~${t.tokens} tokens).` });
  }

  for (const t of after.tools) {
    const old = oldByName.get(t.name);
    if (old) raw.push(...compareTool(old, t));
  }
  for (const { from, to } of renames) raw.push(...compareTool(from, to).filter((f) => f.rule !== 'diff/description' && f.rule !== 'diff/other'));

  const moved = compareMenus(before.tools, after.tools).filter((c) => c.kind === 'moved');
  if (moved.length) {
    raw.push({
      rule: 'diff/order',
      message: `Tool order changed (${moved.map((m) => m.tool).join(', ')}). Only a notice between releases: prompt caches are short-lived, so a deploy costs roughly one rewrite. It matters within a session.`,
    });
  }

  const tokens = tokenChange(before, after);
  if (options.tokenBudget !== undefined && after.totalTokens > options.tokenBudget) {
    raw.push({
      rule: 'diff/token-budget',
      message: `The menu is ~${fmt(after.totalTokens)} tokens, over the budget of ${fmt(options.tokenBudget)} (estimate).`,
    });
  }

  const suggestedBump = bumpFor(raw.map((r) => DIFF_RULES[r.rule]?.class));
  const release = options.release
    ? { ...options.release, source: 'release' as const }
    : options.serverVersionIsRelease && before.server.version && after.server.version
      ? { before: before.server.version, after: after.server.version, source: 'server' as const }
      : undefined;
  const actualBump = release ? versionBump(release.before, release.after) : undefined;
  const required = requiredBump(suggestedBump, release?.before);
  if (release && actualBump && BUMP_RANK[actualBump] < BUMP_RANK[required]) {
    const what = release.source === 'server' ? 'The server-reported version' : 'The release version';
    raw.push({
      rule: 'diff/version-bump',
      message:
        actualBump === 'none'
          ? `${what} stayed ${release.after} but the menu has ${suggestedBump === 'major' ? 'breaking' : suggestedBump === 'minor' ? 'new' : 'changed'} parts. Suggested: a ${required} bump.`
          : `${release.before} → ${release.after} is a ${actualBump} bump, but the menu has ${suggestedBump === 'major' ? 'breaking changes' : 'new features'}. Suggested: a ${required} bump.`,
    });
  }

  return {
    before: before.server,
    after: after.server,
    findings: settle(raw, options),
    tokens,
    suggestedBump,
    ...(actualBump ? { actualBump } : {}),
    ...(release ? { release } : {}),
    ...(release && !actualBump ? { bumpNotChecked: /^v?\d{4}\.\d+/.test(release.after) ? 'calendar version' : 'not semver' } : {}),
  };
}

function compareTool(old: MenuTool, t: MenuTool): Raw[] {
  const out: Raw[] = [];
  const name = t.name;

  if ((old.description ?? '') !== (t.description ?? '')) {
    out.push({ rule: 'diff/description', tool: name, message: `${name}: description changed. It doesn't break the protocol, but it changes what the agent does.`, detail: textDiff(old.description ?? '', t.description ?? '') });
  }

  const oldEmpty = isEmptySchema(old.inputSchema);
  const newEmpty = isEmptySchema(t.inputSchema);
  if (oldEmpty || newEmpty) {
    if (canonical(old.inputSchema) !== canonical(t.inputSchema)) {
      out.push({
        rule: 'diff/schema-other',
        tool: name,
        message: `${name}: the ${oldEmpty ? 'old' : 'new'} inputSchema is empty or invalid (no type, no properties), so parameter changes can't be classified.`,
      });
    }
    return out.concat(compareRest(old, t));
  }

  const oldProps = old.inputSchema?.properties ?? {};
  const newProps = t.inputSchema?.properties ?? {};
  const oldReq = new Set(old.inputSchema?.required ?? []);
  const newReq = new Set(t.inputSchema?.required ?? []);
  let classified = false;

  // Removing an optional parameter only breaks callers if the new schema rejects
  // unknown properties; otherwise calls that still send it stay valid.
  const closed = t.inputSchema?.additionalProperties === false;
  for (const p of Object.keys(oldProps)) {
    if (!(p in newProps)) {
      out.push(
        oldReq.has(p) || closed
          ? { rule: 'diff/param-removed', tool: name, message: `${name}.${p} was removed. Calls that pass it can fail.` }
          : { rule: 'diff/param-dropped', tool: name, message: `${name}.${p} (optional) was removed. Calls that still send it stay valid, but the server may ignore it.` },
      );
      classified = true;
    }
  }
  for (const [p, schema] of Object.entries(newProps)) {
    const before = oldProps[p];
    if (!before) {
      out.push(
        newReq.has(p)
          ? { rule: 'diff/param-required', tool: name, message: `${name}.${p} is new and required. Existing calls don't send it.` }
          : { rule: 'diff/param-added', tool: name, message: `${name}.${p} is a new optional parameter.` },
      );
      classified = true;
      continue;
    }
    if (!oldReq.has(p) && newReq.has(p)) {
      out.push({ rule: 'diff/param-required', tool: name, message: `${name}.${p} was optional and is now required.` });
      classified = true;
    } else if (oldReq.has(p) && !newReq.has(p)) {
      out.push({ rule: 'diff/param-relaxed', tool: name, message: `${name}.${p} was required and is now optional.` });
      classified = true;
    }
    const oldType = typeOf(before);
    const newType = typeOf(schema);
    if (oldType !== newType) {
      // Widening (boolean → boolean|string, object → any) accepts every call that
      // worked before; only a narrower or different type breaks callers.
      out.push(
        accepts(schema, before)
          ? { rule: 'diff/type-widened', tool: name, message: `${name}.${p} now accepts more types: ${oldType || 'any'} → ${newType || 'any'}.` }
          : { rule: 'diff/param-type', tool: name, message: `${name}.${p} changed type: ${oldType || 'any'} → ${newType || 'any'}. Calls that worked before can fail.` },
      );
      classified = true;
    }
    const e = enumChange(before, schema);
    if (e) {
      out.push({ rule: e.rule, tool: name, message: `${name}.${p}: ${e.message}` });
      classified = true;
    }
    if ((before.description ?? '') !== (schema.description ?? '')) {
      out.push({ rule: 'diff/description', tool: name, message: `${name}.${p}: parameter description changed.`, detail: textDiff(String(before.description ?? ''), String(schema.description ?? '')) });
      classified = true;
    }
  }
  if (!classified && canonical(old.inputSchema) !== canonical(t.inputSchema)) {
    out.push({ rule: 'diff/schema-other', tool: name, message: `${name}: inputSchema changed in a way toolmenu doesn't classify (nested fields, constraints…). Review it.` });
  }
  return out.concat(compareRest(old, t));
}

const TOOL_FIELDS = new Set(['name', 'description', 'inputSchema', 'outputSchema', 'annotations', 'tokens']);

/** Output schema, annotations and any other fields (title, icons, _meta…). */
function compareRest(old: MenuTool, t: MenuTool): Raw[] {
  const out: Raw[] = [];
  const name = t.name;
  if (canonical(old.outputSchema) !== canonical(t.outputSchema)) {
    const what = old.outputSchema === undefined ? 'now declares an outputSchema' : t.outputSchema === undefined ? 'no longer declares an outputSchema' : 'outputSchema changed';
    out.push({ rule: 'diff/schema-other', tool: name, message: `${name}: ${what}. Clients that validate structured output may notice.` });
  }

  const a = old.annotations ?? {};
  const b = t.annotations ?? {};
  // Compare effective hints, with the spec's defaults: readOnlyHint false,
  // destructiveHint true (meaningful only when not read-only).
  let safety = false;
  if (readOnly(a) && !readOnly(b)) {
    out.push({ rule: 'diff/safety-hint', tool: name, message: `${name} is no longer read-only. Clients and agents that auto-approve read-only tools will now call something that writes.` });
    safety = true;
  } else if (!readOnly(b) && !destructive(a) && destructive(b)) {
    out.push({ rule: 'diff/safety-hint', tool: name, message: `${name} was additive-only and is now destructive.` });
    safety = true;
  }
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => canonical(a[k]) !== canonical(b[k]))
    .map((k) => `${k}: ${show(a[k])} → ${show(b[k])}`);
  if (changed.length && !safety) {
    out.push({ rule: 'diff/annotations', tool: name, message: `${name}: annotations changed (${changed.join(', ')}).` });
  }

  const others = [...new Set([...Object.keys(old), ...Object.keys(t)])].filter((k) => !TOOL_FIELDS.has(k) && canonical(old[k]) !== canonical(t[k]));
  if (others.length) {
    out.push({ rule: 'diff/other', tool: name, message: `${name}: ${others.join(', ')} changed.` });
  }
  return out;
}

function readOnly(a: Record<string, unknown>): boolean {
  return a.readOnlyHint === true;
}

function destructive(a: Record<string, unknown>): boolean {
  return !readOnly(a) && a.destructiveHint !== false;
}

function show(value: unknown): string {
  return value === undefined ? '(unset)' : JSON.stringify(value);
}

function isEmptySchema(schema: JsonSchema | undefined): boolean {
  return !schema || (schema.type === undefined && schema.properties === undefined);
}

/** Removed + added tools with the same non-empty parameter names and required set. */
function findRenames(removed: MenuTool[], added: MenuTool[]): { from: MenuTool; to: MenuTool }[] {
  const pairs: { from: MenuTool; to: MenuTool }[] = [];
  const used = new Set<string>();
  for (const from of removed) {
    const key = paramKey(from);
    if (!key) continue;
    const matches = added.filter((to) => !used.has(to.name) && paramKey(to) === key);
    if (matches.length === 1) {
      pairs.push({ from, to: matches[0] });
      used.add(matches[0].name);
    }
  }
  return pairs;
}

function paramKey(t: MenuTool): string | undefined {
  const props = Object.keys(t.inputSchema?.properties ?? {}).sort();
  if (props.length === 0) return undefined;
  return canonical({ props: Object.fromEntries(props.map((p) => [p, typeOf(t.inputSchema!.properties![p])])), required: [...(t.inputSchema?.required ?? [])].sort() });
}

/** Does `next` accept every value type that `prev` accepted? */
function accepts(next: JsonSchema, prev: JsonSchema): boolean {
  const types = (s: JsonSchema) => (s.type === undefined ? undefined : new Set(Array.isArray(s.type) ? s.type : [s.type]));
  const n = types(next);
  const p = types(prev);
  if (!n) return true; // no type: anything goes
  if (!p) return false;
  return [...p].every((t) => n.has(t) || (t === 'integer' && n.has('number')));
}

function typeOf(schema: JsonSchema): string {
  const t = schema.type;
  return Array.isArray(t) ? [...t].sort().join('|') : t ?? '';
}

function enumChange(before: JsonSchema, after: JsonSchema): { rule: string; message: string } | undefined {
  const a = before.enum;
  const b = after.enum;
  if (!a && !b) return undefined;
  if (!a && b) return { rule: 'diff/enum-narrowed', message: `now limited to ${b.map(String).join(', ')}.` };
  if (a && !b) return { rule: 'diff/enum-widened', message: `no longer limited to a fixed set of values.` };
  const gone = a!.filter((v) => !b!.some((w) => canonical(w) === canonical(v)));
  const fresh = b!.filter((v) => !a!.some((w) => canonical(w) === canonical(v)));
  if (gone.length) return { rule: 'diff/enum-narrowed', message: `no longer accepts ${gone.map(String).join(', ')}.` };
  if (fresh.length) return { rule: 'diff/enum-widened', message: `now also accepts ${fresh.map(String).join(', ')}.` };
  return undefined;
}

function textDiff(before: string, after: string): string[] {
  const cut = (s: string) => (s.length > 240 ? s.slice(0, 237) + '…' : s);
  return [`- ${cut(before) || '(none)'}`, `+ ${cut(after) || '(none)'}`];
}

function tokenChange(before: Menu, after: Menu): TokenChange {
  const names = new Set([...before.tools, ...after.tools].map((t) => t.name));
  const oldTokens = new Map(before.tools.map((t) => [t.name, t.tokens]));
  const newTokens = new Map(after.tools.map((t) => [t.name, t.tokens]));
  const tools = [...names]
    .map((name) => {
      const b = oldTokens.get(name) ?? 0;
      const a = newTokens.get(name) ?? 0;
      return { name, before: b, after: a, delta: a - b };
    })
    .filter((t) => t.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return { before: before.totalTokens, after: after.totalTokens, delta: after.totalTokens - before.totalTokens, tools };
}

const BUMP_RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

function bumpFor(classes: (ChangeClass | undefined)[]): Bump {
  if (classes.includes('breaking')) return 'major';
  if (classes.includes('minor')) return 'minor';
  if (classes.includes('notice')) return 'patch';
  return 'none';
}

/** Under 1.0.0, semver lets a minor bump carry breaking changes. */
function requiredBump(suggested: Bump, version: string | undefined): Bump {
  const v = parseVersion(version);
  // 0.0.x promises nothing; 0.x lets a minor bump break.
  if (v && v[0] === 0 && v[1] === 0) return 'none';
  if (v && v[0] === 0 && suggested === 'major') return 'minor';
  return suggested;
}

function parseVersion(version: string | undefined): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function versionBump(before: string | undefined, after: string | undefined): Bump | undefined {
  const a = parseVersion(before);
  const b = parseVersion(after);
  if (!a || !b) return undefined;
  // Calendar versions (2026.8.31) don't promise anything about compatibility.
  if (a[0] >= 1000 || b[0] >= 1000) return undefined;
  if (b[0] !== a[0]) return b[0] > a[0] ? 'major' : undefined;
  if (b[1] !== a[1]) return b[1] > a[1] ? 'minor' : undefined;
  if (b[2] !== a[2]) return b[2] > a[2] ? 'patch' : undefined;
  return 'none';
}

function settle(raw: Raw[], options: DiffOptions): DiffFinding[] {
  const ignore = (options.ignore ?? []).map((g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
  const findings: DiffFinding[] = [];
  for (const r of raw) {
    const configured = options.rules?.[r.rule];
    if (configured === 'off') continue;
    if (r.tool && ignore.some((re) => re.test(r.tool!))) continue;
    const rule = DIFF_RULES[r.rule];
    findings.push({ ...r, severity: configured ?? rule.severity, ...(rule.class ? { class: rule.class } : {}) });
  }
  return findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
