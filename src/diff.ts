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

/** How deep nested objects are compared field by field. Deeper, a change is one schema-other notice. */
const MAX_DEPTH = 8;

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

  compareObject(name, name, a!, b!, out, 0);
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

/**
 * One object schema against its next version: its properties, their types,
 * enums, requiredness and descriptions, and, for properties that are objects or
 * arrays of objects, theirs too, under a path (`gen.body.text`, `gen.items[].id`).
 */
function compareObject(tool: string, path: string, oldS: JsonSchema, newS: JsonSchema, out: Raw[], depth: number): void {
  const oldProps = oldS.properties ?? {};
  const newProps = newS.properties ?? {};
  const oldReq = new Set(oldS.required ?? []);
  const newReq = new Set(newS.required ?? []);

  // Removing an optional parameter only breaks callers if the new schema rejects
  // unknown properties; otherwise calls that still send it stay valid.
  const closed = newS.additionalProperties === false;
  for (const p of Object.keys(oldProps)) {
    if (!(p in newProps)) {
      out.push(
        oldReq.has(p) || closed
          ? { rule: 'diff/param-removed', tool, message: `${path}.${p} was removed. Calls that pass it can fail.` }
          : { rule: 'diff/param-dropped', tool, message: `${path}.${p} (optional) was removed. Calls that still send it stay valid, but the server may ignore it.` },
      );
    }
  }
  for (const [p, schema] of Object.entries(newProps)) {
    const before = oldProps[p];
    const at = `${path}.${p}`;
    if (!before) {
      out.push(
        newReq.has(p)
          ? { rule: 'diff/param-required', tool, message: `${at} is new and required. Existing calls don't send it.${hasDefault(schema) ? ` It has a default (${show(schema.default)}), so the server may still accept calls without it, but clients that validate arguments won't.` : ''}` }
          : { rule: 'diff/param-added', tool, message: `${at} is a new optional parameter.` },
      );
      continue;
    }
    if (!oldReq.has(p) && newReq.has(p)) {
      out.push({ rule: 'diff/param-required', tool, message: `${at} was optional and is now required.${hasDefault(schema) ? ` It has a default (${show(schema.default)}), so the server may still accept calls without it, but clients that validate arguments won't.` : ''}` });
    } else if (oldReq.has(p) && !newReq.has(p)) {
      out.push({ rule: 'diff/param-relaxed', tool, message: `${at} was required and is now optional.` });
    }
    const oldType = typeOf(before);
    const newType = typeOf(schema);
    if (oldType !== newType) {
      // Widening (boolean → boolean|string, object → any) accepts every call that
      // worked before; only a narrower or different type breaks callers.
      out.push(
        accepts(schema, before)
          ? { rule: 'diff/type-widened', tool, message: `${at} now accepts more types: ${oldType || 'any'} → ${newType || 'any'}.` }
          : { rule: 'diff/param-type', tool, message: `${at} changed type: ${oldType || 'any'} → ${newType || 'any'}. Calls that worked before can fail.` },
      );
    }
    const e = enumChange(before, schema);
    if (e) {
      out.push({ rule: e.rule, tool, message: `${at}: ${e.message}` });
    }
    // Array parameters: the element type and allowed values count like the
    // parameter's own (no items schema = any element).
    const isArray = (s: JsonSchema) => typesOf(s)?.includes('array') ?? false;
    const arrays = isArray(before) && isArray(schema);
    if (arrays) {
      const oldItems = before.items ?? {};
      const newItems = schema.items ?? {};
      const oldItemType = typeOf(oldItems);
      const newItemType = typeOf(newItems);
      if (oldItemType !== newItemType) {
        out.push(
          accepts(newItems, oldItems)
            ? { rule: 'diff/type-widened', tool, message: `${at} (array items) now accept more types: ${oldItemType || 'any'} → ${newItemType || 'any'}.` }
            : { rule: 'diff/param-type', tool, message: `${at} (array items) changed type: ${oldItemType || 'any'} → ${newItemType || 'any'}. Calls that worked before can fail.` },
        );
      }
      const ie = enumChange(oldItems, newItems);
      if (ie) out.push({ rule: ie.rule, tool, message: `${at} (array items): ${ie.message}` });
    }
    if ((before.description ?? '') !== (schema.description ?? '')) {
      out.push({ rule: 'diff/description', tool, message: `${at}: parameter description changed.`, detail: textDiff(String(before.description ?? ''), String(schema.description ?? '')) });
    }
    // Objects, and arrays of objects, are compared field by field below, with the
    // same rules; what's left is checked here, so a classified change can't hide it.
    const deeper = depth < MAX_DEPTH;
    const nestedObject = deeper && hasProperties(before) && hasProperties(schema);
    const nestedItems = deeper && arrays && hasProperties(before.items) && hasProperties(schema.items);
    // A breaking type change already covers a reshaped schema: no duplicate
    // notice. A widened type can still bring new constraints, so it's checked.
    const rest = (s: JsonSchema) => residual(s, { object: nestedObject, items: nestedItems });
    if ((oldType === newType || accepts(schema, before)) && canonical(rest(before)) !== canonical(rest(schema))) {
      out.push({ rule: 'diff/schema-other', tool, message: `${at}: changed in a way toolmenu doesn't classify (constraints, formats, combinators…). Review it.` });
    }
    if (nestedObject) compareObject(tool, at, before, schema, out, depth + 1);
    if (nestedItems) compareObject(tool, `${at}[]`, before.items!, schema.items!, out, depth + 1);
  }
}

function hasProperties(s: JsonSchema | undefined): boolean {
  return !!s && typeof s.properties === 'object' && s.properties !== null && !Array.isArray(s.properties);
}

/** Nodes a $ref expansion may produce before it gives up and compares the schema as spelled. */
const MAX_EXPANDED_NODES = 50_000;

/**
 * The schema with local $refs (`#/$defs/…`, `#/definitions/…`) replaced by what
 * they point to, and $defs dropped when nothing refers to it any more: two
 * spellings of one schema compare equal. A cycle, or a $ref toolmenu can't follow
 * (another document), stays a $ref, and $defs stays with it. Keywords next to a
 * $ref (a description) win over the target's.
 */
export function resolveRefs(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema || typeof schema !== 'object') return schema;
  let unresolved = false;
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
      if (target && typeof target === 'object' && !Array.isArray(target) && !stack.includes(o.$ref)) {
        const { $ref: _ref, ...siblings } = o;
        return { ...(walk(target, [...stack, o.$ref]) as object), ...(walk(siblings, stack) as object) };
      }
      unresolved = true;
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v, stack)]));
  };
  const { $defs, definitions, ...rest } = schema as Record<string, unknown>;
  let resolved: JsonSchema;
  try {
    resolved = walk(rest, []) as JsonSchema;
  } catch {
    return schema;
  }
  return unresolved ? { ...resolved, ...($defs !== undefined ? { $defs } : {}), ...(definitions !== undefined ? { definitions } : {}) } : resolved;
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
function residual(schema: JsonSchema, nested: { object?: boolean; items?: boolean } = {}): unknown {
  const { type: _t, enum: _e, const: _c, description: _d, items, ...rest } = schema as Record<string, unknown>;
  // A type written as anyOf/oneOf alternatives is compared as the type.
  if (typeAlternatives(schema)) delete rest[schema.anyOf ? 'anyOf' : 'oneOf'];
  if (nested.object) {
    delete rest.properties;
    delete rest.required;
  }
  if (items && typeof items === 'object') {
    const { enum: _ie, const: _ic, type: _it, ...itemRest } = items as Record<string, unknown>;
    if (nested.items) {
      delete itemRest.properties;
      delete itemRest.required;
    }
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
