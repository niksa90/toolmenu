import { canonical, compareMenus } from './compare.js';
import { isCalendar, parseSemver } from './semver.js';
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
  'diff/version-backwards': { severity: 'warn' },
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
  // Ignored tools leave the comparison entirely, so they can't pair into a
  // rename or show up as a reorder.
  const ignored = ignoreMatcher(options.ignore);
  const oldTools = before.tools.filter((t) => !ignored(t.name));
  const newTools = after.tools.filter((t) => !ignored(t.name));
  const oldByName = new Map(oldTools.map((t) => [t.name, t]));
  const newByName = new Map(newTools.map((t) => [t.name, t]));

  const removed = oldTools.filter((t) => !newByName.has(t.name));
  const added = newTools.filter((t) => !oldByName.has(t.name));
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

  for (const t of newTools) {
    const old = oldByName.get(t.name);
    if (old) raw.push(...compareTool(old, t));
  }
  for (const { from, to } of renames) raw.push(...compareTool(from, to).filter((f) => f.rule !== 'diff/description' && f.rule !== 'diff/other'));

  const moved = compareMenus(oldTools, newTools).filter((c) => c.kind === 'moved');
  if (moved.length) {
    raw.push({
      rule: 'diff/order',
      message: `Tool order changed (${moved.map((m) => m.tool).join(', ')}). Only a notice between releases: prompt caches are short-lived, so a deploy costs roughly one rewrite. It matters within a session.`,
    });
  }

  // Ignored tools leave the token counts and the budget too.
  const tokens = tokenChange(oldTools, newTools);
  if (options.tokenBudget !== undefined && tokens.after > options.tokenBudget) {
    raw.push({
      rule: 'diff/token-budget',
      message: `The menu is ~${fmt(tokens.after)} tokens, over the budget of ${fmt(options.tokenBudget)} (estimate).`,
    });
  }

  // Only what survives ignore and 'off' counts toward the bump. Settled once:
  // the bump and the reported findings come from the same list.
  const changes = settle(raw, options);
  const suggestedBump = bumpFor(changes.map((f) => f.class));
  const versionRaw: Raw[] = [];
  const release = options.release
    ? { ...options.release, source: 'release' as const }
    : options.serverVersionIsRelease && before.server.version && after.server.version
      ? { before: before.server.version, after: after.server.version, source: 'server' as const }
      : undefined;
  const actualBump = release ? versionBump(release.before, release.after) : undefined;
  const notChecked = release && !actualBump ? whyNotChecked(release.before, release.after) : undefined;
  if (release && notChecked === 'version went backwards') {
    versionRaw.push({
      rule: 'diff/version-backwards',
      message:
        release.source === 'server'
          ? `The server-reported version went backwards: ${release.before} → ${release.after}.`
          : `${release.before} → ${release.after}: the version went backwards. Check the --release order.`,
    });
  }
  const required = requiredBump(suggestedBump, release?.before);
  if (release && actualBump && BUMP_RANK[actualBump] < BUMP_RANK[required]) {
    const what = release.source === 'server' ? 'The server-reported version' : 'The release version';
    versionRaw.push({
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
    findings: [...changes, ...settle(versionRaw, options)].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]),
    tokens,
    suggestedBump,
    ...(actualBump ? { actualBump } : {}),
    ...(release ? { release } : {}),
    ...(notChecked ? { bumpNotChecked: notChecked } : {}),
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
    }
  }
  for (const [p, schema] of Object.entries(newProps)) {
    const before = oldProps[p];
    if (!before) {
      out.push(
        newReq.has(p)
          ? { rule: 'diff/param-required', tool: name, message: `${name}.${p} is new and required. Existing calls don't send it.${hasDefault(schema) ? ` It has a default (${show(schema.default)}), so the server may still accept calls without it, but clients that validate arguments won't.` : ''}` }
          : { rule: 'diff/param-added', tool: name, message: `${name}.${p} is a new optional parameter.` },
      );
      continue;
    }
    if (!oldReq.has(p) && newReq.has(p)) {
      out.push({ rule: 'diff/param-required', tool: name, message: `${name}.${p} was optional and is now required.${hasDefault(schema) ? ` It has a default (${show(schema.default)}), so the server may still accept calls without it, but clients that validate arguments won't.` : ''}` });
    } else if (oldReq.has(p) && !newReq.has(p)) {
      out.push({ rule: 'diff/param-relaxed', tool: name, message: `${name}.${p} was required and is now optional.` });
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
    }
    const e = enumChange(before, schema);
    if (e) {
      out.push({ rule: e.rule, tool: name, message: `${name}.${p}: ${e.message}` });
    }
    // Array parameters: the element type and allowed values count like the
    // parameter's own (no items schema = any element).
    const isArray = (s: JsonSchema) => typesOf(s)?.includes('array') ?? false;
    if (isArray(before) && isArray(schema)) {
      const oldItems = before.items ?? {};
      const newItems = schema.items ?? {};
      const oldItemType = typeOf(oldItems);
      const newItemType = typeOf(newItems);
      if (oldItemType !== newItemType) {
        out.push(
          accepts(newItems, oldItems)
            ? { rule: 'diff/type-widened', tool: name, message: `${name}.${p} (array items) now accept more types: ${oldItemType || 'any'} → ${newItemType || 'any'}.` }
            : { rule: 'diff/param-type', tool: name, message: `${name}.${p} (array items) changed type: ${oldItemType || 'any'} → ${newItemType || 'any'}. Calls that worked before can fail.` },
        );
      }
      const ie = enumChange(oldItems, newItems);
      if (ie) out.push({ rule: ie.rule, tool: name, message: `${name}.${p} (array items): ${ie.message}` });
    }
    if ((before.description ?? '') !== (schema.description ?? '')) {
      out.push({ rule: 'diff/description', tool: name, message: `${name}.${p}: parameter description changed.`, detail: textDiff(String(before.description ?? ''), String(schema.description ?? '')) });
    }
    // Whatever changed beyond type, enum and description is checked per
    // parameter, so a classified change elsewhere can't hide it.
    // A breaking type change already covers a reshaped schema: no duplicate
    // notice. A widened type can still bring new constraints, so it's checked.
    if ((oldType === newType || accepts(schema, before)) && canonical(residual(before)) !== canonical(residual(schema))) {
      out.push({ rule: 'diff/schema-other', tool: name, message: `${name}.${p}: changed in a way toolmenu doesn't classify (nested fields, constraints…). Review it.` });
    }
  }
  const shell = (s: JsonSchema | undefined) => {
    const { properties: _p, required: _r, ...rest } = (s ?? {}) as Record<string, unknown>;
    return rest;
  };
  if (canonical(shell(old.inputSchema)) !== canonical(shell(t.inputSchema))) {
    out.push({ rule: 'diff/schema-other', tool: name, message: `${name}: inputSchema changed outside its parameters (additionalProperties, $defs…). Review it.` });
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

function hasDefault(schema: JsonSchema): boolean {
  return 'default' in schema;
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
  const types = (s: JsonSchema) => {
    const t = typesOf(s);
    return t && new Set(t);
  };
  const n = types(next);
  const p = types(prev);
  if (!n) return true; // no type: anything goes
  if (!p) return false;
  return [...p].every((t) => n.has(t) || (t === 'integer' && n.has('number')));
}

/** A parameter's schema without the parts diff classifies itself. */
function residual(schema: JsonSchema): unknown {
  const { type: _t, enum: _e, description: _d, items, ...rest } = schema as Record<string, unknown>;
  // A type written as anyOf/oneOf alternatives is compared as the type.
  if (typeAlternatives(schema)) delete rest[schema.anyOf ? 'anyOf' : 'oneOf'];
  if (items && typeof items === 'object') {
    const { enum: _ie, type: _it, ...itemRest } = items as Record<string, unknown>;
    return Object.keys(itemRest).length ? { ...rest, items: itemRest } : rest;
  }
  return rest;
}

function typeOf(schema: JsonSchema): string {
  return [...new Set(typesOf(schema) ?? [])].sort().join('|');
}

/**
 * The types a schema accepts, undefined for any. `anyOf: [{type: string}, {type:
 * null}]` is the same as `type: [string, null]`: schema generators switch between
 * the two (zod did), and that isn't a change.
 */
function typesOf(schema: JsonSchema): string[] | undefined {
  if (schema.type !== undefined) return Array.isArray(schema.type) ? schema.type : [schema.type];
  return typeAlternatives(schema);
}

/** anyOf/oneOf whose branches only name a type (a description or title aside). */
function typeAlternatives(schema: JsonSchema): string[] | undefined {
  const branches = (schema.anyOf ?? schema.oneOf) as unknown;
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  const types: string[] = [];
  for (const b of branches as JsonSchema[]) {
    if (!b || typeof b !== 'object' || b.type === undefined) return undefined;
    if (Object.keys(b).some((k) => !['type', 'description', 'title'].includes(k))) return undefined;
    types.push(...(Array.isArray(b.type) ? b.type : [b.type]));
  }
  return types;
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

function tokenChange(before: MenuTool[], after: MenuTool[]): TokenChange {
  const names = new Set([...before, ...after].map((t) => t.name));
  const oldTokens = new Map(before.map((t) => [t.name, t.tokens]));
  const newTokens = new Map(after.map((t) => [t.name, t.tokens]));
  const tools = [...names]
    .map((name) => {
      const b = oldTokens.get(name) ?? 0;
      const a = newTokens.get(name) ?? 0;
      return { name, before: b, after: a, delta: a - b };
    })
    .filter((t) => t.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const total = (tools: MenuTool[]) => tools.reduce((sum, t) => sum + t.tokens, 0);
  return { before: total(before), after: total(after), delta: total(after) - total(before), tools };
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
  const v = parseSemver(version);
  // 0.0.x promises nothing; 0.x lets a minor bump break.
  if (v && v.nums[0] === 0 && v.nums[1] === 0) return 'none';
  if (v && v.nums[0] === 0 && suggested === 'major') return 'minor';
  return suggested;
}

/** Why a bump can't be judged: not semver, calendar, prerelease, or backwards. */
function whyNotChecked(before: string, after: string): string {
  const a = parseSemver(before);
  const b = parseSemver(after);
  if (!a || !b) return 'not semver';
  if (isCalendar(a) || isCalendar(b)) return 'calendar version';
  if (a.pre || b.pre) return 'prerelease';
  return 'version went backwards';
}

export function versionBump(before: string | undefined, after: string | undefined): Bump | undefined {
  const a = parseSemver(before);
  const b = parseSemver(after);
  if (!a || !b) return undefined;
  // Calendar versions and prereleases make no compatibility promise to compare.
  if (isCalendar(a) || isCalendar(b) || a.pre || b.pre) return undefined;
  for (const [i, bump] of [[0, 'major'], [1, 'minor'], [2, 'patch']] as const) {
    if (b.nums[i] !== a.nums[i]) return b.nums[i] > a.nums[i] ? bump : undefined;
  }
  return 'none';
}

function ignoreMatcher(globs: string[] | undefined): (name: string) => boolean {
  const res = (globs ?? []).map((g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
  return (name) => res.some((re) => re.test(name));
}

function settle(raw: Raw[], options: DiffOptions): DiffFinding[] {
  const ignored = ignoreMatcher(options.ignore);
  const findings: DiffFinding[] = [];
  for (const r of raw) {
    const configured = options.rules?.[r.rule];
    if (configured === 'off') continue;
    if (r.tool && ignored(r.tool)) continue;
    const rule = DIFF_RULES[r.rule];
    findings.push({ ...r, severity: configured ?? rule.severity, ...(rule.class ? { class: rule.class } : {}) });
  }
  return findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
