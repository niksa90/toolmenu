import { createHash } from 'node:crypto';
import { canonical, compareMenus } from './compare.js';
import { countTokens } from './menu.js';
import { isCalendar, parseSemver } from './semver.js';
import type { Finding, JsonSchema, Menu, MenuTool, Severity } from './types.js';
import { SEVERITY_RANK } from './types.js';

export type ChangeClass = 'breaking' | 'minor' | 'notice';
export type Bump = 'major' | 'minor' | 'patch' | 'none';

export interface DiffFinding extends Finding {
  class?: ChangeClass;
  /** Every place one change was found, when it's reached from several (a shared definition). */
  places?: string[];
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
  // Restructured ($ref, $defs) but accepts the same input: bytes and tokens changed.
  'diff/schema-equivalent': { severity: 'info', class: 'notice' },
  // Only the declared $schema dialect changed: one finding for the menu.
  'diff/schema-dialect': { severity: 'info', class: 'notice' },
  'diff/annotations': { severity: 'info', class: 'notice' },
  'diff/other': { severity: 'info', class: 'notice' },
  'diff/order': { severity: 'info', class: 'notice' },
  'diff/version-bump': { severity: 'warn' },
  'diff/version-backwards': { severity: 'warn' },
  'diff/token-budget': { severity: 'error' },
  // Operations behind a search tool (snapshot --catalog). A search returns its top
  // matches, so one not found this time may be ranked out, not removed: a notice,
  // no bump. Changes to operations found in both runs use the rules above.
  'diff/catalog-missing': { severity: 'info' },
  'diff/catalog-added': { severity: 'info' },
  'diff/catalog-queries': { severity: 'info' },
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

/** A finding before settle. `place` and `text`: where in the schema, and what changed there (say, collapsePlaces). */
type Raw = { rule: string; tool?: string; message: string; detail?: string[]; place?: string; text?: string; group?: string; places?: string[] };

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

  collapseDialects(raw);

  const moved = compareMenus(oldTools, newTools).filter((c) => c.kind === 'moved');
  if (moved.length) {
    raw.push({
      rule: 'diff/order',
      message: `Tool order changed (${moved.map((m) => m.tool).join(', ')}). Only a notice between releases: prompt caches are short-lived, so a deploy costs roughly one rewrite. It matters within a session.`,
    });
  }

  raw.push(...compareCatalogs(before.catalog, after.catalog, ignored));

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

/** The same $schema switch in several tools is one finding that names them. */
function collapseDialects(raw: Raw[]): void {
  const groups = new Map<string, Raw[]>();
  for (const r of raw) if (r.rule === 'diff/schema-dialect') groups.set(r.detail![0], [...(groups.get(r.detail![0]) ?? []), r]);
  for (const [pair, list] of groups) {
    if (list.length < 2) {
      delete list[0].detail;
      continue;
    }
    const at = raw.indexOf(list[0]);
    for (const r of list) raw.splice(raw.indexOf(r), 1);
    const names = list.map((r) => r.tool!);
    raw.splice(at, 0, {
      rule: 'diff/schema-dialect',
      message: `${list.length} tools declare a different JSON Schema dialect ($schema ${pair}), and nothing else outside their parameters changed: most likely a schema generator upgrade.`,
      detail: [names.slice(0, 12).join(', ') + (names.length > 12 ? `, and ${names.length - 12} more` : '')],
    });
  }
}

/**
 * How deep a schema is compared field by field, counting every object, array
 * items and union option on the way. 8 cut off a document schema's lists, tables
 * and quotes (block → items → option → fields → items → option → …) while its
 * paragraphs were compared, so one change read as an error at two places and
 * "review it" at four. Recursion is bounded by resolveRefs, not by this.
 */
const MAX_DEPTH = 64;

function compareTool(old: MenuTool, t: MenuTool): Raw[] {
  const out: Raw[] = [];
  const name = t.name;

  if ((old.description ?? '') !== (t.description ?? '')) {
    out.push({ rule: 'diff/description', tool: name, message: `${name}: description changed. It doesn't break the protocol, but it changes what the agent does.`, detail: textDiff(old.description ?? '', t.description ?? '') });
  }

  // Compared by what they accept, not how they're spelled: a block moved into
  // $defs and referenced is the same schema.
  const ea = expandRefs(old.inputSchema);
  const eb = expandRefs(t.inputSchema);
  // Too large to expand on either side: compare both as written, so an expanded
  // side isn't read against a $ref on the other ("object → any"), and say so.
  const expanded = ea.expanded && eb.expanded;
  const a = expanded ? ea.schema : old.inputSchema;
  const b = expanded ? eb.schema : t.inputSchema;
  if (!expanded && canonical(old.inputSchema) !== canonical(t.inputSchema)) {
    const which = ea.expanded ? 'the new inputSchema expands' : eb.expanded ? 'the old inputSchema expands' : 'the old and new inputSchemas expand';
    out.push({
      rule: 'diff/schema-other',
      tool: name,
      message: `${name}: ${which} past ${fmt(MAX_EXPANDED_NODES)} nodes through ${ea.expanded || eb.expanded ? 'its' : 'their'} $refs, so both are compared as written, $defs entries by name: a $ref moved to another name reads as a change. Review it.`,
    });
  }
  const oldEmpty = isEmptySchema(a);
  const newEmpty = isEmptySchema(b);
  if (oldEmpty || newEmpty) {
    if (canonical(a) !== canonical(b)) {
      out.push({
        rule: 'diff/schema-other',
        tool: name,
        message: `${name}: the ${oldEmpty ? 'old' : 'new'} inputSchema is empty or invalid (no type, no properties), so parameter changes can't be classified.`,
      });
    }
    return out.concat(compareRest(old, t));
  }

  const found = out.length;
  compareObject({ tool: name, out }, name, a!, b!, 0);
  // Compared as written (too large to expand): the parameters hold $refs, so
  // what they point to is compared here, definition by definition, by name. A
  // narrowed enum inside one is still breaking.
  if (!expanded) compareDefinitions({ tool: name, out }, name, old.inputSchema ?? {}, t.inputSchema ?? {});
  collapsePlaces(out, found);
  const shell = (s: JsonSchema | undefined) => {
    const { properties: _p, required: _r, $defs: _d, definitions: _df, ...rest } = (s ?? {}) as Record<string, unknown>;
    return rest;
  };
  const [sa, sb] = [shell(a), shell(b)];
  if (canonical(sa) !== canonical(sb)) {
    const { $schema: da, ...ra } = sa;
    const { $schema: db, ...rb } = sb;
    // Only the declared dialect: a schema generator upgrade (zod 3 → 4 moved
    // mongodb-mcp-server 3.0.0 from draft-07 to 2020-12 in every tool). Said once
    // for the menu, below.
    if (canonical(ra) === canonical(rb)) {
      const pair = `${show(da)} → ${show(db)}`;
      out.push({ rule: 'diff/schema-dialect', tool: name, message: `${name}: inputSchema declares a different JSON Schema dialect ($schema ${pair}), and nothing else outside its parameters changed.`, detail: [pair] });
    }
    else out.push({ rule: 'diff/schema-other', tool: name, message: `${name}: inputSchema changed outside its parameters (additionalProperties, $schema…). Review it.` });
  }
  // Never silent: the schemas differ, and nothing above says how. Spellings the
  // rules treat as one (a type as anyOf alternatives or a list) don't count.
  if (expanded && out.length === found && canonical(sameTypes(a)) !== canonical(sameTypes(b))) {
    out.push({ rule: 'diff/schema-other', tool: name, message: `${name}: inputSchema changed in a way toolmenu doesn't classify. Review it.` });
  }
  // Spelled differently, accepts the same: say so, so the refactor needs no review.
  if (canonical(a) === canonical(b) && canonical(old.inputSchema) !== canonical(t.inputSchema)) {
    const delta = countTokens(JSON.stringify(t.inputSchema ?? {})) - countTokens(JSON.stringify(old.inputSchema ?? {}));
    out.push({
      rule: 'diff/schema-equivalent',
      tool: name,
      message: `${name}: inputSchema restructured ($ref, $defs, key order) but accepts the same input: ${delta === 0 ? 'no change in size' : `~${fmt(Math.abs(delta))} tokens ${delta < 0 ? 'fewer' : 'more'}`} (estimate).`,
    });
  }
  return out.concat(compareRest(old, t));
}

/** A schema with every type written one way: `type: [sorted]`, for anyOf/oneOf type alternatives too. */
function sameTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sameTypes);
  if (!node || typeof node !== 'object') return node;
  const s = node as JsonSchema;
  // Name → schema maps: their keys are names, not keywords (a property called
  // `type` is a schema, not a type).
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(s).map(([k, v]) => [k, SCHEMA_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v) ? mapValues(v as Record<string, unknown>, sameTypes) : sameTypes(v)]),
  );
  const alternatives = typeAlternatives(s);
  if (alternatives) {
    delete out.anyOf;
    delete out.oneOf;
    out.type = [...new Set(alternatives)].sort();
  } else if (typeof s.type === 'string' || (Array.isArray(s.type) && s.type.every((t) => typeof t === 'string'))) {
    out.type = [...new Set(Array.isArray(s.type) ? s.type : [s.type])].sort();
  }
  // A union accepts the same whatever order its options come in.
  for (const k of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(out[k])) out[k] = [...(out[k] as unknown[])].sort((x, y) => (canonical(x) < canonical(y) ? -1 : canonical(x) > canonical(y) ? 1 : 0));
  }
  return out;
}

/** `$defs` and `definitions` entries of two unexpanded schemas, compared by name. */
function compareDefinitions(w: Walk, name: string, oldS: JsonSchema, newS: JsonSchema): void {
  const list = (names: string[]) => [...names].sort((x, y) => x.localeCompare(y, 'en', { numeric: true })).slice(0, 8).join(', ') + (names.length > 8 ? `, and ${names.length - 8} more` : '');
  for (const pool of ['$defs', 'definitions'] as const) {
    const [a, b] = [(oldS[pool] ?? {}) as Record<string, JsonSchema>, (newS[pool] ?? {}) as Record<string, JsonSchema>];
    const removed = Object.keys(a).filter((k) => !(k in b));
    const added = Object.keys(b).filter((k) => !(k in a));
    // One line each for definitions only one side has: what refers to them is compared above.
    if (removed.length) w.out.push({ rule: 'diff/schema-other', tool: w.tool, message: `${name}: ${pool} ${removed.length === 1 ? 'entry' : 'entries'} removed (${list(removed)}). Review what referred to ${removed.length === 1 ? 'it' : 'them'}.` });
    if (added.length) w.out.push({ rule: 'diff/schema-other', tool: w.tool, message: `${name}: ${pool} ${added.length === 1 ? 'entry' : 'entries'} added (${list(added)}).` });
    for (const [k, def] of Object.entries(b)) {
      if (k in a) compareSchema(w, `${name}.${pool}.${k}`, `${name}.${pool}.${k}`, a[k], def, 1);
    }
  }
}

/** Where a tool's schema comparison reports to. */
interface Walk {
  tool: string;
  out: Raw[];
  /** Fingerprint of the enclosing object schema, before and after (compareObject sets it). */
  scope?: string;
}

const DESCRIPTIVE = new Set(['description', 'title', 'examples', '$comment']);

/** A schema without the keywords that describe it but don't change what it accepts. */
function shape(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shape);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>)
      .filter(([k]) => !DESCRIPTIVE.has(k))
      .map(([k, v]) => [k, SCHEMA_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v) ? mapValues(v as Record<string, unknown>, shape) : shape(v)]),
  );
}

/** Keywords whose value maps names to schemas. */
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);

function mapValues(map: Record<string, unknown>, f: (v: unknown) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, f(v)]));
}

/** A short, stable fingerprint of a (canonical) value. */
function digest(value: unknown): string {
  return createHash('sha1').update(canonical(value ?? null)).digest('base64').slice(0, 16);
}

/**
 * A finding at a place in the schema, about `node` (the schema there, before and
 * after). The place and what changed are kept apart, so one change reached
 * through a shared definition at several places can be said once
 * (collapsePlaces). That takes the same rule and words, the same field name, the
 * same schema before and after, and the same enclosing object: two independent
 * `limit` parameters removed from different objects are two findings, while one
 * definition used at five places has the same enclosing object at all five.
 */
function say(w: Walk, rule: string, place: string, text: string, node: unknown, detail?: string[]): void {
  const field = place.replace(/( \([^()]*(?:\([^()]*\)[^()]*)*\))+$/, '').split('.').pop();
  const group = [rule, text, field, digest(node), w.scope ?? '', digest(detail)].join('\u0000');
  w.out.push({ rule, tool: w.tool, message: place + text, place, text, group, ...(detail ? { detail } : {}) });
}

/**
 * One object schema against its next version: which properties were removed,
 * added, or became required or optional; each one that's in both is compared by
 * compareSchema, under a path (`gen.body.text`).
 */
function compareObject(outer: Walk, path: string, oldS: JsonSchema, newS: JsonSchema, depth: number): void {
  // Findings inside this object group only with findings inside one that accepts
  // the same (descriptions aside: a $ref with its own description is the same
  // definition).
  const w: Walk = { ...outer, scope: digest([shape(oldS), shape(newS)]) };
  const oldProps = oldS.properties ?? {};
  const newProps = newS.properties ?? {};
  const oldReq = new Set(oldS.required ?? []);
  const newReq = new Set(newS.required ?? []);
  const defaulted = (schema: JsonSchema) =>
    hasDefault(schema) ? ` It has a default (${show(schema.default)}), so the server may still accept calls without it, but clients that validate arguments won't.` : '';

  // Removing an optional parameter only breaks callers if the new schema rejects
  // unknown properties; otherwise calls that still send it stay valid.
  const closed = newS.additionalProperties === false;
  for (const p of Object.keys(oldProps)) {
    if (p in newProps) continue;
    if (oldReq.has(p) || closed) say(w, 'diff/param-removed', `${path}.${p}`, ' was removed. Calls that pass it can fail.', oldProps[p]);
    else say(w, 'diff/param-dropped', `${path}.${p}`, ' (optional) was removed. Calls that still send it stay valid, but the server may ignore it.', oldProps[p]);
  }
  for (const [p, schema] of Object.entries(newProps)) {
    const before = oldProps[p];
    const at = `${path}.${p}`;
    if (!before) {
      if (newReq.has(p)) say(w, 'diff/param-required', at, ` is new and required. Existing calls don't send it.${defaulted(schema)}`, schema);
      else say(w, 'diff/param-added', at, ' is a new optional parameter.', schema);
      continue;
    }
    if (!oldReq.has(p) && newReq.has(p)) say(w, 'diff/param-required', at, ` was optional and is now required.${defaulted(schema)}`, [before, schema]);
    else if (oldReq.has(p) && !newReq.has(p)) say(w, 'diff/param-relaxed', at, ' was required and is now optional.', [before, schema]);
    compareSchema(w, at, at, before, schema, depth);
  }
}

/**
 * One schema against its next version, anywhere in a tool: its type, allowed
 * values and description; array items, object fields and union options, each
 * compared the same way; and whatever's left, as one "review it". `at` is the path
 * nested fields hang off (`gen.rows[]`); `label` names this schema in messages
 * (`gen.rows (array items)`).
 */
function compareSchema(w: Walk, at: string, label: string, before: JsonSchema, after: JsonSchema, depth: number): void {
  // Past the limit, a change is said as such, not passed off as an unclassified one.
  if (depth >= MAX_DEPTH) {
    if (canonical(sameTypes(before)) !== canonical(sameTypes(after))) {
      say(w, 'diff/schema-other', label, `: changed more than ${MAX_DEPTH} levels deep, below where toolmenu compares field by field. Review it.`, [before, after]);
    }
    return;
  }
  const oldOptions = unionOf(before);
  const newOptions = unionOf(after);
  // anyOf/oneOf whose options are more than a type: zod's unions, discriminated
  // unions, and .nullable() on anything but a primitive. A side that isn't a union
  // is one option.
  const union = oldOptions !== undefined || newOptions !== undefined;
  const oldType = typeOf(before);
  const newType = typeOf(after);
  if (union) {
    // The plain side's description is the node's, compared below, not an option's.
    compareUnion(w, at, label, optionsOf(before), optionsOf(after), depth);
  } else {
    if (oldType !== newType) {
      // Widening (boolean → boolean|string, object → any) accepts every call that
      // worked before; only a narrower or different type breaks callers.
      if (accepts(after, before)) say(w, 'diff/type-widened', label, ` now accepts more types: ${oldType || 'any'} → ${newType || 'any'}.`, [before, after]);
      else say(w, 'diff/param-type', label, ` changed type: ${oldType || 'any'} → ${newType || 'any'}. Calls that worked before can fail.`, [before, after]);
    }
    const e = enumChange(before, after);
    if (e) say(w, e.rule, label, `: ${e.message}`, [before, after]);
  }
  // Array items: compared like a parameter of their own (no items schema = any element).
  const isArray = (s: JsonSchema) => typesOf(s)?.includes('array') ?? false;
  const arrays = !union && isArray(before) && isArray(after);
  if (arrays) compareSchema(w, `${at}[]`, `${label} (array items)`, before.items ?? {}, after.items ?? {}, depth + 1);
  if ((before.description ?? '') !== (after.description ?? '')) {
    say(w, 'diff/description', label, `: ${label.endsWith(')') ? 'description' : 'parameter description'} changed.`, [before, after], textDiff(String(before.description ?? ''), String(after.description ?? '')));
  }
  const object = !union && hasProperties(before) && hasProperties(after);
  if (object) compareObject(w, at, before, after, depth + 1);
  // What no rule above covers. A breaking type change already covers a reshaped
  // schema: no duplicate notice. A widened type can still bring new constraints.
  // A union against a plain schema is covered by its options entirely.
  if (union && !(oldOptions && newOptions)) return;
  const rest = (s: JsonSchema) => residual(s, { object, items: arrays, union });
  if ((union || oldType === newType || accepts(after, before)) && canonical(rest(before)) !== canonical(rest(after))) {
    say(w, 'diff/schema-other', label, `: changed in a way toolmenu doesn't classify (constraints, formats, combinators…). Review it.`, [before, after]);
  }
}

/**
 * A schema as a list of union options, when the other side is a union: its own
 * anyOf/oneOf options if it has any (one option, or type-only ones, included),
 * else itself, without its description (that's the node's, compared as the
 * node's), as the one option.
 */
function optionsOf(s: JsonSchema): JsonSchema[] {
  const options = unionOptions(s);
  return options && options.length > 0 ? options : [undescribed(s)];
}

/** The options of an anyOf/oneOf that isn't just a list of types. */
function unionOf(s: JsonSchema): JsonSchema[] | undefined {
  const options = unionOptions(s);
  if (!options || options.length === 0 || typeAlternatives(s)) return undefined;
  return options;
}

/**
 * anyOf/oneOf options, with an option that is itself only a union (a $ref to
 * one, expanded: Notion's `parent` is anyOf [parentRequest, string], and
 * parentRequest is anyOf of objects) flattened into its options: the same values
 * are accepted either way.
 */
function unionOptions(s: JsonSchema): JsonSchema[] | undefined {
  const options = (s.anyOf ?? s.oneOf) as unknown;
  if (!Array.isArray(options)) return undefined;
  return (options as JsonSchema[]).flatMap((o) => {
    const inner = o && typeof o === 'object' ? ((o.anyOf ?? o.oneOf) as unknown) : undefined;
    const pure = Array.isArray(inner) && Object.keys(o).every((k) => k === 'anyOf' || k === 'oneOf' || DESCRIPTIVE.has(k));
    return pure ? (unionOptions(o) ?? [o]) : [o];
  });
}

/** A schema without its description, for comparing it as one option among others. */
function undescribed(s: JsonSchema): JsonSchema {
  const { description: _d, ...rest } = s as Record<string, unknown>;
  return rest as JsonSchema;
}

/**
 * A union's options, paired old with new (pairOptions), each pair compared like
 * any schema. An option gone is breaking; a new one widens.
 */
function compareUnion(outer: Walk, at: string, label: string, oldOptions: JsonSchema[], newOptions: JsonSchema[], depth: number): void {
  // Findings about the union, and inside its options, group by the union itself:
  // one union definition shared by fields of different objects (a heading's
  // content and a table cell's) is one change, whatever the objects around it.
  const w: Walk = { ...outer, scope: digest([shape(oldOptions), shape(newOptions)]) };
  const d = discriminator(oldOptions);
  const key = d && d === discriminator(newOptions) ? d : undefined;
  const { pairs, gone, fresh } = pairOptions(oldOptions, newOptions, key);
  const oldLabels = optionLabels(oldOptions, key);
  const newLabels = optionLabels(newOptions, key);
  for (const o of gone) say(w, 'diff/param-type', label, `: no longer accepts the ${oldLabels.get(o)} option. Calls that sent it can fail.`, o);
  for (const o of fresh) say(w, 'diff/type-widened', label, ` now also accepts ${article(newLabels.get(o)!)} ${newLabels.get(o)} option.`, o);
  for (const [prev, next] of pairs) {
    const k = newLabels.get(next)!;
    compareSchema(w, `${at}(${k})`, `${label} (${k} option)`, prev, next, depth + 1);
  }
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/**
 * Which old option became which new one. With a discriminator every option fixes
 * (`kind: "text"`), by its value. Without one (a plain z.union of objects, an
 * option that's an unexpanded $ref): identical options first, so a reorder or an
 * option added in front changes nothing else; then options of the same type,
 * objects by how many property names they share, best match first. An object
 * option that shares no property name with any other is gone or new, not a
 * reshaped one. Pairs come back in the new schema's order.
 */
function pairOptions(oldOptions: JsonSchema[], newOptions: JsonSchema[], key: string | undefined): { pairs: [JsonSchema, JsonSchema][]; gone: JsonSchema[]; fresh: JsonSchema[] } {
  const oldLeft = new Set(oldOptions.keys());
  const newLeft = new Set(newOptions.keys());
  const pairs: [number, number][] = [];
  const take = (i: number, j: number) => {
    pairs.push([i, j]);
    oldLeft.delete(i);
    newLeft.delete(j);
  };
  // Old options by fingerprint, each computed once: matching is a lookup, not a
  // scan (a 1,500-option union took 36 s).
  const match = (fingerprint: (o: JsonSchema) => string) => {
    const byPrint = new Map<string, number[]>();
    oldOptions.forEach((o, i) => {
      if (!oldLeft.has(i)) return;
      const f = fingerprint(o);
      byPrint.set(f, [...(byPrint.get(f) ?? []), i]);
    });
    for (const j of newOptions.keys()) {
      if (!newLeft.has(j)) continue;
      const i = byPrint.get(fingerprint(newOptions[j]))?.shift();
      if (i !== undefined) take(i, j);
    }
  };
  if (key) {
    // An option that's a $ref (unexpanded: a recursive one) has no discriminator
    // value of its own: it pairs by its ref.
    match((o) => (typeof o.$ref === 'string' ? `$ref ${o.$ref}` : canonical(fixedValue(o.properties?.[key]))));
  } else {
    match((o) => canonical(sameTypes(o)));
    const names = new Map([...oldOptions, ...newOptions].map((o) => [o, new Set(Object.keys(o.properties ?? {}))]));
    const types = new Map([...oldOptions, ...newOptions].map((o) => [o, typeOf(o)]));
    const candidates: [number, number, number][] = [];
    for (const i of oldLeft) {
      for (const j of newLeft) {
        const [a, b] = [oldOptions[i], newOptions[j]];
        if (types.get(a) !== types.get(b)) continue;
        let score = 0.5;
        if (hasProperties(a) || hasProperties(b)) {
          const [x, y] = [names.get(a)!, names.get(b)!];
          const all = new Set([...x, ...y]).size;
          // Two objects with no properties at all have the same shape.
          score = all === 0 ? 1 : [...x].filter((n) => y.has(n)).length / all;
        }
        if (score > 0) candidates.push([score, i, j]);
      }
    }
    candidates.sort((p, q) => q[0] - p[0] || p[1] - q[1] || p[2] - q[2]);
    for (const [, i, j] of candidates) if (oldLeft.has(i) && newLeft.has(j)) take(i, j);
    // As many options left on each side: the ones that were edited (a type
    // changed, an option emptied or given its first field). Paired in order,
    // compared inside, rather than said as one removed and one added. Not two
    // objects that each have fields and share none: that's one option replaced by
    // another (pair-replace in the review of #15).
    if (oldLeft.size > 0 && oldLeft.size === newLeft.size) {
      const [olds, news] = [[...oldLeft].sort((a, b) => a - b), [...newLeft].sort((a, b) => a - b)];
      const filled = (o: JsonSchema) => names.get(o)!.size > 0;
      olds.forEach((i, n) => {
        if (!(filled(oldOptions[i]) && filled(newOptions[news[n]]))) take(i, news[n]);
      });
    }
  }
  pairs.sort((p, q) => p[1] - q[1]);
  return {
    pairs: pairs.map(([i, j]) => [oldOptions[i], newOptions[j]]),
    gone: [...oldLeft].map((i) => oldOptions[i]),
    fresh: [...newLeft].sort((a, b) => a - b).map((j) => newOptions[j]),
  };
}

/**
 * Each option's name in messages and paths: its discriminator value, or its shape
 * (`object{path,url}`, the first three property names). Two options that would
 * share a name get all their property names, then a number.
 */
function optionLabels(options: JsonSchema[], key: string | undefined): Map<JsonSchema, string> {
  const label = (o: JsonSchema, all: boolean): string => {
    if (key && hasProperties(o)) return `${key}=${JSON.stringify(fixedValue(o.properties![key]))}`;
    if (typeof o.$ref === 'string') return `$ref ${o.$ref}`;
    const type = typeOf(o) || 'untyped';
    if (!hasProperties(o)) return type;
    const names = Object.keys(o.properties!).sort();
    return all || names.length <= 3 ? `${type}{${names.join(',')}}` : `${type}{${names.slice(0, 3).join(',')},…}`;
  };
  const short = options.map((o) => label(o, false));
  const named = options.map((o, i) => (short.filter((s) => s === short[i]).length > 1 ? label(o, true) : short[i]));
  const seen = new Map<string, number>();
  return new Map(
    options.map((o, i) => {
      const n = (seen.get(named[i]) ?? 0) + 1;
      seen.set(named[i], n);
      return [o, named.filter((s) => s === named[i]).length > 1 ? `${named[i]} #${n}` : named[i]];
    }),
  );
}

/**
 * The same change, said at several places of one tool (a shared definition five
 * block types use), as one finding that lists them: one change, one line, the
 * same classification everywhere.
 */
function collapsePlaces(out: Raw[], from: number): void {
  const groups = new Map<string, Raw[]>();
  for (const r of out.slice(from)) {
    if (r.group === undefined) continue;
    groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const [first, ...rest] = list;
    // Same field, same schema, in identical enclosing objects: one definition,
    // reached from several places.
    first.message = `${first.place}${first.text} The same change at ${rest.length} more place${rest.length === 1 ? '' : 's'}, in the same definition.`;
    first.detail = [...(first.detail ?? []), ...rest.slice(0, 10).map((r) => `also at ${r.place}`), ...(rest.length > 10 ? [`…and ${rest.length - 10} more`] : [])];
    first.places = list.map((r) => r.place!);
    for (const r of rest) out.splice(out.indexOf(r), 1);
  }
  for (const r of out.slice(from)) {
    delete r.place;
    delete r.text;
    delete r.group;
  }
}

/** A property every option is an object with, and fixes to one value. */
function discriminator(options: JsonSchema[]): string | undefined {
  // A $ref option (a recursive definition left unexpanded) says nothing either way.
  const own = options.filter((o) => typeof o.$ref !== 'string');
  if (own.length === 0 || !own.every(hasProperties)) return undefined;
  const names = Object.keys(own[0].properties!).sort();
  return names.find((n) => own.every((o) => fixedValue(o.properties![n]) !== undefined));
}

function fixedValue(s: JsonSchema | undefined): unknown {
  if (!s) return undefined;
  if ('const' in s) return s.const;
  return Array.isArray(s.enum) && s.enum.length === 1 ? s.enum[0] : undefined;
}


function hasProperties(s: JsonSchema | undefined): boolean {
  return !!s && typeof s.properties === 'object' && s.properties !== null && !Array.isArray(s.properties);
}

/** Nodes a $ref expansion may produce before it gives up and compares the schema as spelled. */
const MAX_EXPANDED_NODES = 50_000;

/** How many times one $ref is followed inside itself: a recursive schema unrolled this deep. */
const MAX_UNROLL = 1;

/**
 * The schema with local $refs (`#/$defs/…`, `#/definitions/…`) replaced by what
 * they point to, and the root $defs dropped: two spellings of one schema compare
 * equal. A recursive definition is unrolled MAX_UNROLL level, then left as a
 * $ref: a change to it shows in the levels above, and its $defs entry needn't be
 * kept (keeping it made a recursive schema compare unequal to its own refactor,
 * with nothing reported). A $ref toolmenu can't follow (another document) stays as
 * it is. Keywords next to a $ref (a description) win over the target's.
 */
export function resolveRefs(schema: JsonSchema | undefined): JsonSchema | undefined {
  return expandRefs(schema).schema;
}

/**
 * resolveRefs, saying whether it finished: past MAX_EXPANDED_NODES the schema
 * comes back as written, and `expanded` is false.
 */
function expandRefs(schema: JsonSchema | undefined): { schema: JsonSchema | undefined; expanded: boolean } {
  if (!schema || typeof schema !== 'object') return { schema, expanded: true };
  let nodes = 0;
  const pointer = (ref: string): unknown => {
    let node: unknown = schema;
    for (const raw of ref.slice(2).split('/')) {
      if (!node || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return node;
  };
  const walk = (node: unknown, stack: string[]): unknown => {
    if (++nodes > MAX_EXPANDED_NODES) throw new Error('too large');
    if (Array.isArray(node)) return node.map((x) => walk(x, stack));
    if (!node || typeof node !== 'object') return node;
    const o = node as Record<string, unknown>;
    if (typeof o.$ref === 'string') {
      const target = o.$ref.startsWith('#/') ? pointer(o.$ref) : undefined;
      if (target && typeof target === 'object' && !Array.isArray(target) && stack.filter((r) => r === o.$ref).length < MAX_UNROLL) {
        const { $ref: _ref, ...siblings } = o;
        return { ...(walk(target, [...stack, o.$ref]) as object), ...(walk(siblings, stack) as object) };
      }
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v, stack)]));
  };
  const { $defs: _defs, definitions: _definitions, ...rest } = schema as Record<string, unknown>;
  try {
    return { schema: walk(rest, []) as JsonSchema, expanded: true };
  } catch {
    return { schema, expanded: false };
  }
}

/** Operations behind a search tool, compared like tools where both runs found them. */
function compareCatalogs(before: Menu['catalog'], after: Menu['catalog'], ignored: (name: string) => boolean): Raw[] {
  if (!before && !after) return [];
  if (!before || !after) {
    return [{ rule: 'diff/catalog-queries', message: `Only the ${before ? 'older' : 'newer'} snapshot has a catalog (snapshot --catalog), so the operations behind ${(before ?? after)!.tool} weren't compared.` }];
  }
  const out: Raw[] = [];
  const where = `behind ${after.tool}`;
  if (JSON.stringify(before.queries) !== JSON.stringify(after.queries)) {
    out.push({ rule: 'diff/catalog-queries', message: `The two catalogs were read with different queries, so operations found on one side only say little. Pin them with catalog.queries in the config.` });
  }
  const partial = [before, after].filter((c) => c.failed?.length);
  if (partial.length) {
    out.push({ rule: 'diff/catalog-queries', message: `${partial.length === 2 ? 'Both catalogs are' : `The ${partial[0] === before ? 'older' : 'newer'} catalog is`} partial: some queries failed (rate limits or errors), so operations found on one side only say even less.` });
  }
  const oldOps = new Map(before.operations.filter((o) => !ignored(o.name)).map((o) => [o.name, o]));
  const newOps = new Map(after.operations.filter((o) => !ignored(o.name)).map((o) => [o.name, o]));
  for (const [name, op] of newOps) {
    const old = oldOps.get(name);
    if (!old) {
      out.push({ rule: 'diff/catalog-added', tool: name, message: `${name} (${where}) is new, or newly found by the same queries.` });
      continue;
    }
    for (const r of compareTool(old, op)) out.push({ ...r, message: `${r.message.replace(/\.$/, '')} (an operation ${where}).` });
  }
  const missing = [...oldOps.keys()].filter((n) => !newOps.has(n));
  if (missing.length) {
    out.push({
      rule: 'diff/catalog-missing',
      message: `${missing.length} operation${missing.length === 1 ? '' : 's'} ${where} weren't returned by the same queries this time: removed, renamed, or ranked lower. Check before relying on them: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}.`,
    });
  }
  return out;
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
  const schema = resolveRefs(t.inputSchema);
  const props = Object.keys(schema?.properties ?? {}).sort();
  if (props.length === 0) return undefined;
  return canonical({ props: Object.fromEntries(props.map((p) => [p, typeOf(schema!.properties![p])])), required: [...(schema?.required ?? [])].sort() });
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
/**
 * A parameter's schema without the parts diff classifies itself: with `object`,
 * its properties and required list (compared field by field); with `items`, the
 * same for its array items.
 */
function residual(schema: JsonSchema, nested: { object?: boolean; items?: boolean; union?: boolean } = {}): unknown {
  const { type: _t, enum: _e, const: _c, description: _d, ...rest } = schema as Record<string, unknown>;
  // A type written as anyOf/oneOf alternatives is compared as the type; a union's
  // options are compared one by one.
  if (typeAlternatives(schema) || nested.union) {
    delete rest.anyOf;
    delete rest.oneOf;
  }
  if (nested.object) {
    delete rest.properties;
    delete rest.required;
  }
  if (nested.items) delete rest.items;
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

/** The values a schema limits itself to: its enum, or a const as a one-value enum. */
function allowedValues(schema: JsonSchema): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum;
  return 'const' in schema ? [schema.const] : undefined;
}

function enumChange(before: JsonSchema, after: JsonSchema): { rule: string; message: string } | undefined {
  const a = allowedValues(before);
  const b = allowedValues(after);
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
