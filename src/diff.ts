import { canonical, compareMenus } from './compare.js';
import { countTokens } from './menu.js';
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
type Raw = { rule: string; tool?: string; message: string; detail?: string[]; place?: string; text?: string; group?: string };

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
  const a = resolveRefs(old.inputSchema);
  const b = resolveRefs(t.inputSchema);
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
  if (out.length === found && canonical(sameTypes(a)) !== canonical(sameTypes(b))) {
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
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, sameTypes(v)]));
  const alternatives = typeAlternatives(s);
  if (alternatives) {
    delete out.anyOf;
    delete out.oneOf;
    out.type = [...new Set(alternatives)].sort();
  } else if (s.type !== undefined) {
    out.type = [...new Set(Array.isArray(s.type) ? s.type : [s.type])].sort();
  }
  return out;
}

/** Where a tool's schema comparison reports to. */
interface Walk {
  tool: string;
  out: Raw[];
}

/**
 * A finding at a place in the schema, about `node` (the schema there, before and
 * after). The place and what changed are kept apart, so one change reached
 * through a shared definition at several places can be said once
 * (collapsePlaces): the same rule and words, the same field name, and the same
 * schema before and after. Two different parameters removed are two findings.
 */
function say(w: Walk, rule: string, place: string, text: string, node: unknown, detail?: string[]): void {
  const field = place.replace(/( \([^()]*(?:\([^()]*\)[^()]*)*\))+$/, '').split('.').pop();
  const group = `${rule}\u0000${text}\u0000${field}\u0000${canonical(node ?? null)}\u0000${canonical(detail ?? null)}`;
  w.out.push({ rule, tool: w.tool, message: place + text, place, text, group, ...(detail ? { detail } : {}) });
}

/**
 * One object schema against its next version: which properties were removed,
 * added, or became required or optional; each one that's in both is compared by
 * compareSchema, under a path (`gen.body.text`).
 */
function compareObject(w: Walk, path: string, oldS: JsonSchema, newS: JsonSchema, depth: number): void {
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
    compareUnion(w, at, label, oldOptions ?? [before], newOptions ?? [after], depth);
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

/** The options of an anyOf/oneOf that isn't just a list of types. */
function unionOf(s: JsonSchema): JsonSchema[] | undefined {
  const options = (s.anyOf ?? s.oneOf) as unknown;
  if (!Array.isArray(options) || options.length === 0 || typeAlternatives(s)) return undefined;
  return options as JsonSchema[];
}

/**
 * A union's options, paired old with new: by the value of a discriminator every
 * option fixes (`kind: "text"`), else by type, else by position among options of
 * the same type. An option gone is breaking; a new one widens.
 */
function compareUnion(w: Walk, at: string, label: string, oldOptions: JsonSchema[], newOptions: JsonSchema[], depth: number): void {
  const d = discriminator(oldOptions);
  const key = d && d === discriminator(newOptions) ? d : undefined;
  const oldByKey = new Map(optionKeys(oldOptions, key).map((k, i) => [k, oldOptions[i]]));
  const newByKey = new Map(optionKeys(newOptions, key).map((k, i) => [k, newOptions[i]]));
  for (const k of oldByKey.keys()) {
    if (!newByKey.has(k)) say(w, 'diff/param-type', label, `: no longer accepts the ${k} option. Calls that sent it can fail.`, oldByKey.get(k));
  }
  for (const [k, next] of newByKey) {
    const prev = oldByKey.get(k);
    if (!prev) say(w, 'diff/type-widened', label, ` now also accepts a ${k} option.`, next);
    else compareSchema(w, `${at}(${k})`, `${label} (${k} option)`, prev, next, depth + 1);
  }
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
    const places = list.map((r) => r.place!);
    first.message = `${first.place}${first.text} The same change at ${rest.length} more place${rest.length === 1 ? '' : 's'}: a definition they share, most likely.`;
    first.detail = [...(first.detail ?? []), ...places.slice(0, 10).map((p) => `at ${p}`), ...(places.length > 10 ? [`…and ${places.length - 10} more`] : [])];
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
  if (!options.every(hasProperties)) return undefined;
  const names = Object.keys(options[0].properties!).sort();
  return names.find((n) => options.every((o) => fixedValue(o.properties![n]) !== undefined));
}

function fixedValue(s: JsonSchema | undefined): unknown {
  if (!s) return undefined;
  if ('const' in s) return s.const;
  return Array.isArray(s.enum) && s.enum.length === 1 ? s.enum[0] : undefined;
}

function optionKeys(options: JsonSchema[], key: string | undefined): string[] {
  const seen = new Map<string, number>();
  return options.map((o) => {
    const base = key ? `${key}=${JSON.stringify(fixedValue(o.properties![key]))}` : typeOf(o) || 'untyped';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} #${n}`;
  });
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
  if (!schema || typeof schema !== 'object') return schema;
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
    return walk(rest, []) as JsonSchema;
  } catch {
    return schema;
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
