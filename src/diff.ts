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
  /** Every place one change was found, when it's reached from several (a shared definition, or several tools). */
  places?: string[];
  /**
   * Every tool the change was found in, when it's the same change in several
   * (same rule, same parameter path, same schema before and after). `tool` is
   * then left out. Counts are per change: one finding, however many tools.
   */
  tools?: string[];
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
  // additionalProperties: false removed (widens) or added (breaks callers sending extras).
  'diff/properties-opened': { severity: 'info', class: 'minor' },
  'diff/properties-closed': { severity: 'error', class: 'breaking' },
  'diff/annotations': { severity: 'info', class: 'notice' },
  'diff/other': { severity: 'info', class: 'notice' },
  'diff/order': { severity: 'info', class: 'notice' },
  // A tool lost a parameter and gained a required one with a close name: likely a
  // rename. A hint next to the two breaking findings, not a change of its own.
  'diff/param-renamed': { severity: 'warn' },
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

/** Per class: how many changes (findings), and how many tools they touch. */
export type ClassCounts = Record<ChangeClass, { changes: number; tools: number }>;

export interface DiffResult {
  before: Menu['server'];
  after: Menu['server'];
  findings: DiffFinding[];
  tokens: TokenChange;
  /** Breaking, minor and notice changes: counted per change, with the tools they touch. */
  classes: ClassCounts;
  /** What the changes call for by semver: breaking → major, new → minor, other → patch. */
  suggestedBump: Bump;
  /**
   * The smallest bump the release line needs (with a release to check): the
   * suggested one, one step lower under 1.0.0 (npm's caret: ^0.2.3 accepts
   * 0.2.x), none under 0.1.0.
   */
  requiredBump?: Bump;
  actualBump?: Bump;
  /** When the actual bump is too small: the version to release instead (2.0.0). */
  releaseAs?: string;
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

/**
 * A finding before settle. `place`, `head`, `tail`: where in the schema, and what
 * changed there, as the message's first clause and the rest (say, collapsePlaces).
 * `across`: how to say the same change found in several tools (groupAcrossTools).
 */
type Raw = {
  rule: string;
  tool?: string;
  message: string;
  detail?: string[];
  fix?: string;
  confidence?: 'unsure';
  place?: string;
  head?: string;
  tail?: string;
  group?: string;
  /** The schema the change is about, before and after (say). */
  node?: unknown;
  places?: string[];
  tools?: string[];
  across?: Across;
  /** Catalog operations: the search tool they were found behind. */
  behind?: string;
};

/** The same change in several tools, said once. */
interface Across {
  /** Equal for the same change in any tool. */
  key: string;
  /** The message for the tools it was found in ("25 of 29 tools", their names listed short). */
  say: (count: string, list: string, members: Raw[]) => string;
}

/**
 * In fixes: the release a breaking change should ship in. Resolved once the
 * versions are known (resolveFixes): "release it as 2.0.0", or "ship it in a
 * major release" when there are none to check.
 */
const BREAKING_RELEASE = '\u0000breaking-release\u0000';

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
    raw.push({
      rule: 'diff/tool-renamed',
      tool: to.name,
      message: `${code(from.name)} was renamed to ${code(to.name)} (same parameters). Agents, saved prompts and evals that call ${code(from.name)} now get an unknown-tool error.`,
      fix: `Keep ${code(from.name)} as an alias for one release, or ${BREAKING_RELEASE}.`,
    });
  }
  for (const t of removed.filter((t) => !renamedFrom.has(t.name))) {
    raw.push({
      rule: 'diff/tool-removed',
      tool: t.name,
      message: `${code(t.name)} was removed. Calls to it now fail with an unknown-tool error.`,
      fix: `Keep the removed tool (marked deprecated in its description) for one release, or ${BREAKING_RELEASE}.`,
      across: {
        key: 'diff/tool-removed',
        say: (count, list) => `${count} were removed: ${list}. Calls to them now fail with an unknown-tool error.`,
      },
    });
  }
  for (const t of added.filter((t) => !renamedTo.has(t.name))) {
    raw.push({
      rule: 'diff/tool-added',
      tool: t.name,
      message: `${code(t.name)} is new (~${fmt(t.tokens)} tokens, estimate).`,
      across: {
        key: 'diff/tool-added',
        say: (count, list, members) => `${count} are new (~${fmt(members.reduce((n, m) => n + (newByName.get(m.tool!)?.tokens ?? 0), 0))} tokens together, estimate): ${list}.`,
      },
    });
  }

  for (const t of newTools) {
    const old = oldByName.get(t.name);
    if (old) raw.push(...compareTool(old, t));
  }
  for (const { from, to } of renames) raw.push(...compareTool(from, to).filter((f) => f.rule !== 'diff/description' && f.rule !== 'diff/other'));

  collapseDialects(raw);
  collapseMenuWide(raw);

  const moved = compareMenus(oldTools, newTools).filter((c) => c.kind === 'moved');
  if (moved.length) {
    const names = moved.map((m) => m.tool);
    raw.push({
      rule: 'diff/order',
      message: `The tool order changed: ${names.length === 1 ? `${code(names[0])} moved` : `${names.length} tools moved (${shortList(names)})`}. A new order rewrites the prompt cache once per deploy, so between releases it's only a notice; within a session it matters.`,
      ...(names.length > LIST_SHORT ? { detail: [`moved: ${names.join(', ')}`] } : {}),
    });
  }

  raw.push(...compareCatalogs(before.catalog, after.catalog, ignored));

  // Ignored tools leave the token counts and the budget too.
  const tokens = tokenChange(oldTools, newTools);
  if (options.tokenBudget !== undefined && tokens.after > options.tokenBudget) {
    const grew = tokens.tools.filter((t) => t.delta > 0).slice(0, 3);
    raw.push({
      rule: 'diff/token-budget',
      message: `The menu is ~${fmt(tokens.after)} tokens (estimate), ~${fmt(tokens.after - options.tokenBudget)} over the budget of ${fmt(options.tokenBudget)}. Every conversation that loads it pays that before its first message.`,
      fix: grew.length
        ? `Trim what grew most (${grew.map((t) => code(t.name)).join(', ')}), or raise tokenBudget in the config.`
        : 'Trim the longest tool descriptions, or raise tokenBudget in the config.',
    });
  }

  // Only what survives ignore and 'off' counts toward the bump. Settled once:
  // the bump and the reported findings come from the same list. Grouped after
  // settling, so an ignored tool is never listed in a group.
  const changes = groupAcrossTools(settle(raw, options), oldTools.length, newTools.length);
  const classes = classCounts(changes);
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
      message: `The ${release.source === 'server' ? 'server-reported' : 'release'} version went backwards (${release.before} → ${release.after}), so the bump can't be checked.`,
      fix: release.source === 'server' ? 'Pass the release versions with --release old..new.' : 'Pass --release as old..new, the older release first.',
    });
  }
  const required = release && actualBump ? requiredBump(suggestedBump, release.before) : undefined;
  const short = release && actualBump && required && BUMP_RANK[actualBump] < BUMP_RANK[required];
  if (short) versionRaw.push(bumpFinding(release, actualBump, required, suggestedBump, classes));
  resolveFixes(changes, release && required ? (short ? nextVersion(release.before, required) : 'enough') : undefined);

  return {
    before: before.server,
    after: after.server,
    findings: [...changes, ...settle(versionRaw, options)].map(finished).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]),
    tokens,
    classes,
    suggestedBump,
    ...(required ? { requiredBump: required } : {}),
    ...(actualBump ? { actualBump } : {}),
    ...(short ? { releaseAs: nextVersion(release.before, required) } : {}),
    ...(release ? { release } : {}),
    ...(notChecked ? { bumpNotChecked: notChecked } : {}),
  };
}

/** A name or path as code: `click.pageId`. */
function code(s: string): string {
  return '`' + s + '`';
}

/** How many names a message lists before "… (+N)"; detail has them all. */
const LIST_SHORT = 6;

function shortList(names: string[]): string {
  return names.length <= LIST_SHORT ? names.join(', ') : `${names.slice(0, LIST_SHORT).join(', ')}, … (+${names.length - LIST_SHORT})`;
}

/** "25 of 29 tools", "all 29 tools", "3 operations behind `search`". */
function countPhrase(n: number, total: number, behind: string | undefined): string {
  if (behind) return `${n} operations behind ${code(behind)}`;
  return n === total && n > 2 ? `all ${n} tools` : total > n ? `${n} of ${total} tools` : `${n} tools`;
}

function acrossKey(f: DiffFinding): string | undefined {
  const r = f as Raw;
  return r.across && r.tool ? [f.severity, r.behind ?? '', r.across.key, f.fix ?? '', f.confidence ?? ''].join('\u0000') : undefined;
}

/**
 * The same change in several tools (the same rule, parameter path, and schema
 * before and after: `pageId` made required in 25 tools) as one finding that
 * lists them. Its tools go in `tools`, and in detail when there are more than a
 * message lists. "n of total": removals count against the old menu's tools.
 */
function groupAcrossTools(findings: DiffFinding[], oldTotal: number, newTotal: number): DiffFinding[] {
  const byKey = new Map<string, DiffFinding[]>();
  for (const f of findings) {
    const key = acrossKey(f);
    if (key !== undefined) byKey.set(key, [...(byKey.get(key) ?? []), f]);
  }
  const out: DiffFinding[] = [];
  for (const f of findings) {
    const key = acrossKey(f);
    const list = key === undefined ? undefined : byKey.get(key)!;
    if (!list || list.length < 2) {
      out.push(f);
      continue;
    }
    if (list[0] !== f) continue;
    const names = list.map((m) => m.tool!);
    const places = list.flatMap((m) => m.places ?? ((m as Raw).place ? [(m as Raw).place!] : []));
    const behind = (f as Raw).behind;
    // Removed tools are counted against the old menu (they're not in the new one);
    // everything else is about tools in the new menu.
    const total = f.rule === 'diff/tool-removed' ? oldTotal : newTotal;
    const { tool: _tool, ...first } = f;
    const detail = [...(f.detail ?? []), ...(names.length > LIST_SHORT ? [`${behind ? 'operations' : 'tools'}: ${names.join(', ')}`] : [])];
    out.push({
      ...first,
      message: (f as Raw).across!.say(countPhrase(names.length, total, behind), shortList(names), list as Raw[]),
      ...(detail.length ? { detail } : {}),
      tools: names,
      ...(places.length ? { places } : {}),
    });
    if (!detail.length) delete out[out.length - 1].detail;
  }
  return out;
}

function classCounts(findings: DiffFinding[]): ClassCounts {
  const c: ClassCounts = { breaking: { changes: 0, tools: 0 }, minor: { changes: 0, tools: 0 }, notice: { changes: 0, tools: 0 } };
  const tools: Record<ChangeClass, Set<string>> = { breaking: new Set(), minor: new Set(), notice: new Set() };
  for (const f of findings) {
    if (!f.class) continue;
    c[f.class].changes++;
    for (const t of f.tools ?? (f.tool ? [f.tool] : [])) tools[f.class].add(t);
  }
  for (const k of Object.keys(c) as ChangeClass[]) c[k].tools = tools[k].size;
  return c;
}

/** Fill in the release a breaking change should ship in: a version, or "a major release". */
function resolveFixes(findings: DiffFinding[], next: string | undefined): void {
  const phrase = next === 'enough' ? 'say so in the release notes' : next ? `release it as ${next}` : 'ship it in a major release';
  for (const f of findings) if (f.fix) f.fix = f.fix.split(BREAKING_RELEASE).join(phrase);
}

/** A finding without the fields only diff uses to build it. */
function finished(f: DiffFinding): DiffFinding {
  const { place: _p, head: _h, tail: _t, group: _g, node: _n, across: _a, behind: _b, ...rest } = f as DiffFinding & Raw;
  return rest;
}

const BUMP_WORD: Record<Bump, string> = { major: 'breaking changes', minor: 'new features', patch: 'other changes', none: 'no changes' };

/** The version bump is smaller than the changes call for: say by how much, and what to release instead. */
function bumpFinding(release: { before: string; after: string; source: 'release' | 'server' }, actual: Bump, required: Bump, suggested: Bump, classes: ClassCounts): Raw {
  const what = suggested === 'major' ? classes.breaking : suggested === 'minor' ? classes.minor : classes.notice;
  const changes = `${BUMP_WORD[suggested]} (${what.changes} change${what.changes === 1 ? '' : 's'}${what.tools ? ` in ${what.tools} tool${what.tools === 1 ? '' : 's'}` : ''})`;
  const whose = release.source === 'server' ? 'The server-reported version' : 'The release version';
  const v = parseSemver(release.before)!;
  const zero = v.nums[0] === 0 && required !== suggested
    ? ` Under 1.0.0 each step is one lower: npm's ^${release.before} accepts any ${v.nums[0]}.${v.nums[1]}.x, so breaking changes need a minor bump and new features a patch.`
    : '';
  const need = `${suggested === 'major' ? 'They need' : 'That needs'} a ${required} bump.${zero}`;
  return {
    rule: 'diff/version-bump',
    message:
      actual === 'none'
        ? `${whose} stayed ${release.after}, but the menu has ${changes}. ${need}`
        : `${release.before} → ${release.after} is a ${actual} bump, but the menu has ${changes}. ${need}`,
    fix:
      suggested === 'major'
        ? `Release it as ${nextVersion(release.before, required)}, or make the breaking changes compatible (each one's next step says how).`
        : `Release it as ${nextVersion(release.before, required)}.`,
  };
}

/** The first version after `version` with this bump. */
function nextVersion(version: string, bump: Bump): string {
  const v = parseSemver(version);
  if (!v) return 'the next version';
  const [M, m, p] = v.nums;
  return bump === 'major' ? `${M + 1}.0.0` : bump === 'minor' ? `${M}.${m + 1}.0` : bump === 'patch' ? `${M}.${m}.${p + 1}` : version;
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
      message: `${names.length} tools declare a different JSON Schema dialect ($schema ${pair}) and changed nothing else outside their parameters: most likely a schema generator upgrade. ${shortList(names)}.`,
      ...(names.length > LIST_SHORT ? { detail: [`tools: ${names.join(', ')}`] } : {}),
      tools: names,
    });
  }
}

/**
 * Findings that are one change made to the whole menu, found in several tools
 * (zod 4 dropping additionalProperties: false from every object; a refactor
 * across tools): one line naming the tools, every place in `places`.
 */
const MENU_WIDE: Record<string, { say: (tools: number, places: number) => string; fix?: string }> = {
  'diff/properties-opened': {
    say: (t, p) => `${t} tools now accept properties they don't list (additionalProperties: false removed at ${p} places). Most likely a schema generator upgrade: zod 4 writes nothing where zod 3 wrote false.`,
  },
  'diff/properties-closed': {
    say: (t, p) => `${t} tools now reject properties they don't list (additionalProperties: false added at ${p} places). Calls that send an extra property fail validation.`,
    fix: `Leave these objects open until a breaking release, or ${BREAKING_RELEASE}.`,
  },
  'diff/schema-equivalent': { say: (t) => `${t} tools were restructured or respelled ($ref, $defs, key order) but accept the same input.` },
};

function collapseMenuWide(raw: Raw[]): void {
  for (const [rule, { say, fix }] of Object.entries(MENU_WIDE)) {
    const list = raw.filter((r) => r.rule === rule && r.tool);
    if (list.length < 2) continue;
    const at = raw.indexOf(list[0]);
    for (const r of list) raw.splice(raw.indexOf(r), 1);
    const places = list.flatMap((r) => r.places ?? [r.place ?? r.tool!]);
    const names = list.map((r) => r.tool!);
    raw.splice(at, 0, {
      rule,
      message: `${say(list.length, places.length)} ${shortList(names)}.`,
      ...(names.length > LIST_SHORT ? { detail: [`tools: ${names.join(', ')}`] } : {}),
      ...(fix ? { fix } : {}),
      tools: names,
      places,
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
    const detail = textDiff(old.description ?? '', t.description ?? '');
    out.push({
      rule: 'diff/description',
      tool: name,
      message: `${code(name)}: the description changed. Agents read it to choose the tool and its arguments.`,
      detail,
      across: {
        key: `diff/description\u0000${digest(detail)}`,
        say: (count, list) => `The description changed the same way in ${count}: ${list}. Agents read it to choose the tool and its arguments.`,
      },
    });
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
    const which = ea.expanded ? 'the new input schema expands' : eb.expanded ? 'the old input schema expands' : 'the old and new input schemas expand';
    out.push({
      rule: 'diff/schema-other',
      tool: name,
      message: `${code(name)}: ${which} past ${fmt(MAX_EXPANDED_NODES)} nodes through ${ea.expanded || eb.expanded ? 'its' : 'their'} $refs, so both are compared as written, $defs entries by name. A $ref moved to another name reads as a change.`,
      fix: 'Review the changes reported for this tool by hand.',
    });
  }
  const oldEmpty = isEmptySchema(a);
  const newEmpty = isEmptySchema(b);
  if (oldEmpty || newEmpty) {
    if (canonical(a) !== canonical(b)) {
      const which = oldEmpty && newEmpty ? 'old and new input schemas are' : `${oldEmpty ? 'old' : 'new'} input schema is`;
      out.push({
        rule: 'diff/schema-other',
        tool: name,
        message: `${code(name)}: the ${which} empty or invalid (no type, no properties), so its parameter changes can't be classified.`,
        fix: newEmpty ? 'Check that the server still builds this schema: an empty one usually means a schema generator or SDK mismatch.' : 'Review its parameters by hand.',
        across: {
          key: `diff/schema-other\u0000empty\u0000${which}`,
          say: (count, list) => `In ${count}, the ${which.replace(/ is$/, 's are')} empty or invalid (no type, no properties), so parameter changes can't be classified: ${list}.`,
        },
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
    // additionalProperties: false coming or going is said by compareObject.
    if (rest.additionalProperties === false) delete rest.additionalProperties;
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
      out.push({ rule: 'diff/schema-dialect', tool: name, message: `${code(name)}: the input schema declares a different JSON Schema dialect ($schema ${pair}), and nothing else outside its parameters changed.`, detail: [pair] });
    } else {
      const keys = changedKeys(ra, rb);
      out.push({
        rule: 'diff/schema-other',
        tool: name,
        message: `${code(name)}: the input schema changed outside its parameters, in keywords toolmenu doesn't classify: ${keys}.`,
        fix: 'Review it: a new constraint on the whole input can reject calls that worked.',
        across: { key: `diff/schema-other\u0000shell\u0000${digest([ra, rb])}`, say: (count, list) => `The input schema changed the same way outside its parameters in ${count}, in keywords toolmenu doesn't classify (${keys}): ${list}.` },
      });
    }
  }
  // Never silent: the schemas differ, and nothing above says how. Spellings the
  // rules treat as one (a type as anyOf alternatives or a list) don't count.
  if (expanded && out.length === found && canonical(sameTypes(a)) !== canonical(sameTypes(b))) {
    out.push({ rule: 'diff/schema-other', tool: name, message: `${code(name)}: the input schema changed in a way toolmenu doesn't classify.`, fix: 'Review it by hand.' });
  }
  // Spelled differently, accepts the same: say so, so the refactor needs no review.
  if (canonical(a) === canonical(b) && canonical(old.inputSchema) !== canonical(t.inputSchema)) {
    const delta = countTokens(JSON.stringify(t.inputSchema ?? {})) - countTokens(JSON.stringify(old.inputSchema ?? {}));
    out.push({
      rule: 'diff/schema-equivalent',
      tool: name,
      message: `${code(name)}: the input schema was restructured ($ref, $defs, key order) but accepts the same input: ${delta === 0 ? 'no change in size' : `~${fmt(Math.abs(delta))} tokens ${delta < 0 ? 'fewer' : 'more'}`} (estimate).`,
    });
  }
  return out.concat(compareRest(old, t));
}

/** Which keywords differ between two schema fragments, with their values when short: `minProperties: (unset) → 1`. */
function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => canonical(a[k]) !== canonical(b[k])).sort();
  const one = (k: string) => {
    const pair = `${show(a[k])} → ${show(b[k])}`;
    return pair.length <= 60 ? `${k} ${pair}` : k;
  };
  return keys.length > 5 ? `${keys.slice(0, 5).map(one).join(', ')}, and ${keys.length - 5} more` : keys.map(one).join(', ');
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
    // The options' descriptions stay, as the node's (describedAs).
    const described = describedAs(s);
    if (described) out.description = described;
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
    if (removed.length) {
      w.out.push({
        rule: 'diff/schema-other',
        tool: w.tool,
        message: `${code(name)}: ${pool} ${removed.length === 1 ? 'entry' : 'entries'} removed (${list(removed)}). The schema is too large to expand, so what referred to ${removed.length === 1 ? 'it' : 'them'} is compared by name only.`,
        fix: `Review the parameters that referred to ${removed.length === 1 ? 'it' : 'them'}.`,
      });
    }
    if (added.length) w.out.push({ rule: 'diff/schema-other', tool: w.tool, message: `${code(name)}: ${pool} ${added.length === 1 ? 'entry' : 'entries'} added (${list(added)}).` });
    for (const [k, def] of Object.entries(b)) {
      if (k in a) compareSchema(w, `${name}.${pool}.${k}`, a[k], def, 1);
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
 *
 * The message is `place` + `head` + "." + `tail`: "`click.pageId` is new and
 * required. Existing calls don't send it…". The same change in several tools
 * (the same path inside each, the same schema before and after, descriptions
 * aside) is said once for them all (groupAcrossTools): "`pageId` is new and
 * required in 25 of 29 tools: click, drag, … (+19). Existing calls…".
 */
function say(w: Walk, rule: string, place: string, head: string, tail: string, node: unknown, more: { detail?: string[]; groupAs?: string; fix?: string; confidence?: 'unsure' } = {}): void {
  const { detail, groupAs, fix, confidence } = more;
  const field = place.replace(/(\[\]|\([^()]*(?:\([^()]*\)[^()]*)*\))+$/, '').split('.').pop();
  // groupAs: findings that are one change wherever they're found in the tool,
  // whatever the field (additionalProperties: false dropped from every object).
  const group = groupAs ?? [rule, head, tail, field, digest(node), w.scope ?? '', digest(detail)].join('\u0000');
  const rel = place.startsWith(w.tool) ? place.slice(w.tool.length).replace(/^\./, '') : place;
  w.out.push({
    rule,
    tool: w.tool,
    message: sentence(code(place) + head, tail),
    place,
    head,
    tail,
    group,
    node,
    ...(detail ? { detail } : {}),
    ...(fix ? { fix } : {}),
    ...(confidence ? { confidence } : {}),
    across: pathAcross(rule, rel, head, tail, node, detail),
  });
}

/** "`x` was removed." + " Calls that…" */
function sentence(head: string, tail: string, more = ''): string {
  return `${head}.${tail ? ' ' + tail : ''}${more ? ' ' + more : ''}`;
}

/** The same change at the same path inside several tools. */
function pathAcross(rule: string, rel: string, head: string, tail: string, node: unknown, detail: string[] | undefined, more = '', places = ''): Across {
  return {
    key: [rule, rel, head, tail, digest(shape(node)), digest(detail), places].join('\u0000'),
    say: (count, list) => sentence(`${rel ? code(rel) : 'The input schema'}${head} in ${count}: ${list}`, tail, more),
  };
}

/** Values as code, at most eight: `news`, `d`, and 3 more. */
function values(list: unknown[]): string {
  const shown = list.slice(0, 8).map((v) => code(typeof v === 'string' ? v : JSON.stringify(v)));
  return shown.join(', ') + (list.length > 8 ? `, and ${list.length - 8} more` : '');
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
  const requiredFix = (p: string, schema: JsonSchema, was: string) =>
    hasDefault(schema)
      ? `Take ${code(p)} out of required: its default already covers calls that leave it out.`
      : `${was} ${code(p)} optional and fall back to a default when it's missing, or ${BREAKING_RELEASE}.`;

  // Removing an optional parameter only breaks callers if the new schema rejects
  // unknown properties; otherwise calls that still send it stay valid.
  const closed = newS.additionalProperties === false;
  // additionalProperties: false removed, or added (absent, true and {} are one
  // spelling after expansion). zod 4 drops it from every object: one finding for
  // the tool (collapsePlaces), and one line for the menu (collapseMenuWide).
  const wasClosed = oldS.additionalProperties === false;
  if (wasClosed && newS.additionalProperties === undefined) {
    say(w, 'diff/properties-opened', path, ` now accepts properties it doesn't list (additionalProperties: false removed)`, '', null, { groupAs: 'diff/properties-opened' });
  } else if (!wasClosed && oldS.additionalProperties === undefined && closed) {
    say(w, 'diff/properties-closed', path, ` now rejects properties it doesn't list (additionalProperties: false added)`, 'Calls that send an extra property fail validation.', null, {
      groupAs: 'diff/properties-closed',
      fix: `Leave it open until a breaking release, or ${BREAKING_RELEASE}.`,
    });
  }
  const gone = Object.keys(oldProps).filter((p) => !(p in newProps));
  for (const p of gone) {
    const fix = `Keep accepting ${code(p)} (marked deprecated) for one release, or ${BREAKING_RELEASE}.`;
    if (oldReq.has(p)) {
      say(w, 'diff/param-removed', `${path}.${p}`, ' was removed', `It was required, so every existing call sends it${closed ? ', and the object now rejects properties it doesn\'t list: those calls fail validation.' : ', and the server no longer reads it.'}`, oldProps[p], { fix });
    } else if (closed) {
      say(w, 'diff/param-removed', `${path}.${p}`, ' (optional) was removed', 'The object rejects properties it doesn\'t list, so calls that still send it fail validation.', oldProps[p], { fix });
    } else {
      say(w, 'diff/param-dropped', `${path}.${p}`, ' (optional) was removed', 'Calls that still send it stay valid, but the server may ignore it.', oldProps[p]);
    }
  }
  const fresh: string[] = [];
  for (const [p, schema] of Object.entries(newProps)) {
    const before = oldProps[p];
    const at = `${path}.${p}`;
    if (!before) {
      if (newReq.has(p)) {
        fresh.push(p);
        say(w, 'diff/param-required', at, ' is new and required', `Existing calls don't send it, so they fail validation.${defaulted(schema)}`, schema, { fix: requiredFix(p, schema, 'Make') });
      } else say(w, 'diff/param-added', at, ' is a new optional parameter', '', schema);
      continue;
    }
    if (!oldReq.has(p) && newReq.has(p)) {
      say(w, 'diff/param-required', at, ' was optional and is now required', `Calls that leave it out fail validation.${defaulted(schema)}`, [before, schema], { fix: requiredFix(p, schema, 'Keep') });
    } else if (oldReq.has(p) && !newReq.has(p)) say(w, 'diff/param-relaxed', at, ' was required and is now optional', '', [before, schema]);
    compareSchema(w, at, before, schema, depth);
  }
  for (const [from, to] of likelyRenames(gone, fresh, oldProps, newProps)) {
    const [a, b] = [typeOf(oldProps[from]), typeOf(newProps[to])];
    const types = a === b ? (a ? `both ${a}` : 'both untyped') : `${a || 'any'} → ${b === 'array' ? `array of ${typeOf(newProps[to].items ?? {}) || 'any'}` : b || 'any'}`;
    say(w, 'diff/param-renamed', `${path}.${from}`, ` → ${code(to)} looks like a rename`, `${code(from)} was removed and ${code(to)} is new and required (${types}). Both stay breaking for existing calls.`, [oldProps[from], newProps[to]], {
      fix: `If it is a rename, accept ${code(from)} for one more release and treat it as ${code(to)}; either way, name the rename in the release notes.`,
      confidence: 'unsure',
    });
  }
}

/**
 * Removed parameters that look renamed to a new required one next to them: a
 * close name (case, separators, a plural, one or two letters) and the same
 * type, or an array of it. Only one-to-one: a name close to two others is no
 * guess.
 */
function likelyRenames(gone: string[], fresh: string[], oldProps: Record<string, JsonSchema>, newProps: Record<string, JsonSchema>): [string, string][] {
  const fits = (from: string, to: string) => closeNames(from, to) && sameKind(oldProps[from], newProps[to]);
  const pairs: [string, string][] = [];
  for (const from of gone) {
    const to = fresh.filter((n) => fits(from, n));
    if (to.length === 1 && gone.filter((g) => fits(g, to[0])).length === 1) pairs.push([from, to[0]]);
  }
  return pairs;
}

function closeNames(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[-_.\s]/g, '');
  const [x, y] = [norm(a), norm(b)];
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long === `${short}s` || long === `${short}es` || (short.endsWith('y') && long === `${short.slice(0, -1)}ies`)) return true;
  if (short.length < 5) return false;
  return editDistance(x, y) <= (long.length >= 10 ? 2 : 1);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** The same type, or one side an array of the other's type. */
function sameKind(a: JsonSchema, b: JsonSchema): boolean {
  const [x, y] = [typeOf(a), typeOf(b)];
  if (x === y) return true;
  if (y === 'array') return typeOf(b.items ?? {}) === x;
  if (x === 'array') return typeOf(a.items ?? {}) === y;
  return false;
}

/**
 * One schema against its next version, anywhere in a tool: its type, allowed
 * values and description; array items, object fields and union options, each
 * compared the same way; and whatever's left, as one "review it". `at` is its
 * path, and the path nested fields hang off: `gen.rows[]` for array items,
 * `gen.block(kind="text")` for a union option.
 */
function compareSchema(w: Walk, at: string, before: JsonSchema, after: JsonSchema, depth: number): void {
  // Past the limit, a change is said as such, not passed off as an unclassified one.
  if (depth >= MAX_DEPTH) {
    if (canonical(sameTypes(before)) !== canonical(sameTypes(after))) {
      say(w, 'diff/schema-other', at, ` changed more than ${MAX_DEPTH} levels deep, below where toolmenu compares field by field`, '', [before, after], { fix: 'Review it by hand.' });
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
    compareUnion(w, at, optionsOf(before), optionsOf(after), depth);
  } else {
    if (oldType !== newType) {
      // Widening (boolean → boolean|string, object → any) accepts every call that
      // worked before; only a narrower or different type breaks callers.
      const pair = `${oldType || 'any'} → ${newType || 'any'}`;
      if (accepts(after, before)) say(w, 'diff/type-widened', at, ` now accepts more types: ${pair}`, '', [before, after]);
      else {
        say(w, 'diff/param-type', at, ` changed type: ${pair}`, `Calls that send ${oldType ? `${article(oldType)} ${oldType}` : 'any other type'} fail validation.`, [before, after], {
          fix: oldType && newType ? `Accept both (${[...new Set([...oldType.split('|'), ...newType.split('|')])].join('|')}) for one release, or ${BREAKING_RELEASE}.` : `Restore the old type, or ${BREAKING_RELEASE}.`,
        });
      }
    }
    const e = enumChange(before, after);
    if (e) say(w, e.rule, at, e.head, e.tail, [before, after], e.fix ? { fix: e.fix } : {});
  }
  // Array items: compared like a parameter of their own (no items schema = any element).
  const isArray = (s: JsonSchema) => typesOf(s)?.includes('array') ?? false;
  const arrays = !union && isArray(before) && isArray(after);
  if (arrays) compareSchema(w, `${at}[]`, before.items ?? {}, after.items ?? {}, depth + 1);
  const [da, db] = [describedAs(before), describedAs(after)];
  if (da !== db) {
    say(w, 'diff/description', at, ': the description changed', 'Agents read it to fill in the value.', [before, after], { detail: textDiff(da, db) });
  }
  const object = !union && hasProperties(before) && hasProperties(after);
  if (object) compareObject(w, at, before, after, depth + 1);
  // What no rule above covers. A breaking type change already covers a reshaped
  // schema: no duplicate notice. A widened type can still bring new constraints.
  // A union against a plain schema is covered by its options entirely.
  if (union && !(oldOptions && newOptions)) return;
  const rest = (s: JsonSchema) => residual(s, { object, items: arrays, union }) as Record<string, unknown>;
  if ((union || oldType === newType || accepts(after, before)) && canonical(rest(before)) !== canonical(rest(after))) {
    say(w, 'diff/schema-other', at, ` changed in keywords toolmenu doesn't classify: ${changedKeys(rest(before), rest(after))}`, '', [before, after], {
      fix: 'Review it: a tighter constraint (a lower maximum, a new pattern or format) rejects calls that met the old one.',
    });
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

/**
 * What a schema says about itself: its description, or, for a type written as
 * anyOf/oneOf alternatives, the descriptions its options carry. Sentry writes a
 * nullable string as anyOf [{type: string, description}, {type: null}]; a
 * description moved from the option to the node is the same one.
 */
function describedAs(s: JsonSchema): string {
  const own = typeof s.description === 'string' ? s.description : '';
  if (!typeAlternatives(s)) return own;
  // Its own text and its options', each once: a change to either is seen, even
  // when the field has a description of its own (review of #15, sentry-both).
  const texts = [own, ...((s.anyOf ?? s.oneOf) as JsonSchema[]).map((o) => (typeof o.description === 'string' ? o.description : ''))].filter(Boolean);
  return [...new Set(texts)].join(' ');
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

/**
 * A schema with the spellings that accept the same input written one way, the ones
 * schema generators switch between (zod 3 → 4 did both in chrome-devtools-mcp
 * 1.9.0 → 1.10.1, 61 "review it"s): `additionalProperties: {}` is `true`, and an
 * integer's `maximum: 2^53 − 1` / `minimum: −(2^53 − 1)` (zod 4 adds them to every
 * `.int()`) exclude nothing a call can send.
 */
function unspelled(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(unspelled);
  if (!node || typeof node !== 'object') return node;
  const s = node as Record<string, unknown>;
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(s).map(([k, v]) => [k, SCHEMA_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v) ? mapValues(v as Record<string, unknown>, unspelled) : unspelled(v)]),
  );
  // additionalProperties absent, true and {} all allow any extra property: written
  // as absent. false stays (compareObject says when it comes or goes).
  const a = out.additionalProperties;
  if (a === true || (a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).length === 0)) delete out.additionalProperties;
  // Property names are strings anyway (zod 4 adds this to z.record).
  const names = out.propertyNames as Record<string, unknown> | undefined;
  if (names && typeof names === 'object' && Object.keys(names).length === 1 && names.type === 'string') delete out.propertyNames;
  const integer = s.type === 'integer' || (Array.isArray(s.type) && s.type.includes('integer'));
  if (integer && out.maximum === Number.MAX_SAFE_INTEGER) delete out.maximum;
  if (integer && out.minimum === Number.MIN_SAFE_INTEGER) delete out.minimum;
  return out;
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
function compareUnion(outer: Walk, at: string, oldOptions: JsonSchema[], newOptions: JsonSchema[], depth: number): void {
  // Findings about the union, and inside its options, group by the union itself:
  // one union definition shared by fields of different objects (a heading's
  // content and a table cell's) is one change, whatever the objects around it.
  const w: Walk = { ...outer, scope: digest([shape(oldOptions), shape(newOptions)]) };
  const d = discriminator(oldOptions);
  const key = d && d === discriminator(newOptions) ? d : undefined;
  const { pairs, gone, fresh } = pairOptions(oldOptions, newOptions, key);
  const oldLabels = optionLabels(oldOptions, key);
  const newLabels = optionLabels(newOptions, key);
  for (const o of gone) {
    say(w, 'diff/param-type', at, `: no longer accepts the ${code(oldLabels.get(o)!)} option`, 'Calls that send it fail validation.', o, { fix: `Keep accepting that option for one release, or ${BREAKING_RELEASE}.` });
  }
  for (const o of fresh) say(w, 'diff/type-widened', at, ` now also accepts ${article(newLabels.get(o)!)} ${code(newLabels.get(o)!)} option`, '', o);
  for (const [prev, next] of pairs) {
    const k = newLabels.get(next)!;
    compareSchema(w, `${at}(${k})`, prev, next, depth + 1);
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
    const more = `The same change at ${rest.length} more place${rest.length === 1 ? '' : 's'}, in the same definition.`;
    const rel = (r: Raw) => (r.place!.startsWith(r.tool!) ? r.place!.slice(r.tool!.length).replace(/^\./, '') : r.place!);
    const original = first.detail;
    first.message = sentence(code(first.place!) + first.head, first.tail!, more);
    first.detail = [...(original ?? []), ...rest.slice(0, 10).map((r) => `also at ${rel(r)}`), ...(rest.length > 10 ? [`…and ${rest.length - 10} more`] : [])];
    first.places = list.map((r) => r.place!);
    first.across = pathAcross(first.rule, rel(first), first.head!, first.tail!, first.node, original, more, list.map(rel).join('\u0000'));
    for (const r of rest) out.splice(out.indexOf(r), 1);
  }
  // Grouping across tools goes by place (`place` stays until the finding is finished).
  for (const r of out.slice(from)) {
    delete r.group;
    delete r.node;
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
    return { schema: unspelled(walk(rest, [])) as JsonSchema, expanded: true };
  } catch {
    return { schema, expanded: false };
  }
}

/** What the operations are behind: the search tool or router by name, or "the command routers" as words. */
function catalogSource(c: NonNullable<Menu['catalog']>): string {
  return (c.routers?.length ?? 0) > 1 ? c.tool : code(c.tool);
}

/** Operations behind a search tool, compared like tools where both runs found them. */
function compareCatalogs(before: Menu['catalog'], after: Menu['catalog'], ignored: (name: string) => boolean): Raw[] {
  if (!before && !after) return [];
  if (!before || !after) {
    return [
      {
        rule: 'diff/catalog-queries',
        message: `Only the ${before ? 'older' : 'newer'} snapshot has a catalog (snapshot --catalog), so the operations behind ${catalogSource((before ?? after)!)} weren't compared.`,
        fix: 'Snapshot both versions with --catalog.',
      },
    ];
  }
  const out: Raw[] = [];
  const where = `behind ${catalogSource(after)}`;
  if (JSON.stringify(before.queries) !== JSON.stringify(after.queries)) {
    out.push({
      rule: 'diff/catalog-queries',
      message: "The two catalogs were read with different queries, so an operation found on one side only may just not have matched the other side's queries.",
      fix: 'Pin the queries with catalog.queries in the config, and snapshot both again.',
    });
  }
  const partial = [before, after].filter((c) => c.failed?.length);
  if (partial.length) {
    out.push({
      rule: 'diff/catalog-queries',
      message: `${partial.length === 2 ? 'Both catalogs are' : `The ${partial[0] === before ? 'older' : 'newer'} catalog is`} partial: some queries failed (rate limits or errors), so operations found on one side only say even less.`,
      fix: 'Snapshot again with --catalog once the rate limit has reset.',
    });
  }
  const oldOps = new Map(before.operations.filter((o) => !ignored(o.name)).map((o) => [o.name, o]));
  const newOps = new Map(after.operations.filter((o) => !ignored(o.name)).map((o) => [o.name, o]));
  for (const [name, op] of newOps) {
    const old = oldOps.get(name);
    if (!old) {
      out.push({ rule: 'diff/catalog-added', tool: name, message: `${code(name)} (${where}) is new, or newly found by the same queries.` });
      continue;
    }
    for (const r of compareTool(old, op)) out.push({ ...r, message: `Behind ${catalogSource(after)}: ${r.message}`, behind: after.tool });
  }
  const missing = [...oldOps.keys()].filter((n) => !newOps.has(n));
  if (missing.length) {
    out.push({
      rule: 'diff/catalog-missing',
      message: `${missing.length} operation${missing.length === 1 ? '' : 's'} ${where} weren't returned by the same queries this time: removed, renamed, or ranked lower. ${shortList(missing)}.`,
      ...(missing.length > LIST_SHORT ? { detail: [`operations: ${missing.join(', ')}`] } : {}),
      fix: 'Search for them by name before relying on them.',
    });
  }
  return out;
}

const TOOL_FIELDS = new Set(['name', 'description', 'inputSchema', 'outputSchema', 'annotations', 'tokens']);

/** Output schema, annotations and any other fields (title, icons, _meta…). */
function compareRest(old: MenuTool, t: MenuTool): Raw[] {
  const out: Raw[] = [];
  const name = t.name;
  // Tool-level changes that read the same in any tool: said once for all of them.
  const same = (key: string, say: Across['say']): Across => ({ key, say });
  if (canonical(old.outputSchema) !== canonical(t.outputSchema)) {
    const what = old.outputSchema === undefined ? 'now declares an outputSchema' : t.outputSchema === undefined ? 'no longer declares an outputSchema' : 'changed its outputSchema';
    const why = old.outputSchema === undefined ? 'Clients that validate structured output will check results against it.' : t.outputSchema === undefined ? 'Clients that relied on structured output get none described.' : 'Clients that validate structured output check results against the new one.';
    out.push({
      rule: 'diff/schema-other',
      tool: name,
      message: `${code(name)} ${what}. ${why}`,
      ...(t.outputSchema !== undefined ? { fix: 'Check that what the tool returns matches it.' } : {}),
      across: same(`output\u0000${what}`, (count, list) => `${count[0].toUpperCase()}${count.slice(1)} ${what.replace(/^now declares/, 'now declare').replace(/^no longer declares/, 'no longer declare').replace(/^changed its/, 'changed their')}: ${list}. ${why}`),
    });
  }

  const a = old.annotations ?? {};
  const b = t.annotations ?? {};
  // Compare effective hints, with the spec's defaults: readOnlyHint false,
  // destructiveHint true (meaningful only when not read-only).
  let safety = false;
  if (readOnly(a) && !readOnly(b)) {
    out.push({
      rule: 'diff/safety-hint',
      tool: name,
      message: `${code(name)} is no longer marked read-only (readOnlyHint ${show(a.readOnlyHint)} → ${show(b.readOnlyHint)}). Clients that auto-approve read-only tools will now ask first, or, if set to trust the server, call something that may write.`,
      fix: 'If the tool still only reads, restore readOnlyHint: true; if it writes now, say so in the release notes.',
    });
    safety = true;
  } else if (!readOnly(b) && !destructive(a) && destructive(b)) {
    out.push({
      rule: 'diff/safety-hint',
      tool: name,
      message: `${code(name)} was marked additive-only and is now destructive (destructiveHint ${show(a.destructiveHint)} → ${show(b.destructiveHint)}; unset means destructive). Clients that auto-approve additive tools may now ask first.`,
      fix: 'If the tool still never deletes or overwrites, set destructiveHint: false; if it does now, say so in the release notes.',
    });
    safety = true;
  }
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => canonical(a[k]) !== canonical(b[k]))
    .map((k) => `${k} ${show(a[k])} → ${show(b[k])}`);
  if (changed.length && !safety) {
    const what = changed.join(', ');
    out.push({
      rule: 'diff/annotations',
      tool: name,
      message: `${code(name)}: annotations changed (${what}).`,
      across: same(`annotations\u0000${what}`, (count, list) => `Annotations changed the same way (${what}) in ${count}: ${list}.`),
    });
  }

  const others = [...new Set([...Object.keys(old), ...Object.keys(t)])].filter((k) => !TOOL_FIELDS.has(k) && canonical(old[k]) !== canonical(t[k])).sort();
  if (others.length) {
    const what = others.map((k) => {
      const pair = `${show(old[k])} → ${show(t[k])}`;
      return pair.length <= 60 ? `${k} ${pair}` : k;
    }).join(', ');
    out.push({
      rule: 'diff/other',
      tool: name,
      message: `${code(name)}: ${what} changed. Clients may show these; the agent may read them.`,
      across: same(`other\u0000${what}`, (count, list) => `The same fields changed (${what}) in ${count}: ${list}. Clients may show these; the agent may read them.`),
    });
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

/**
 * A parameter's schema without the parts diff classifies itself: with `object`,
 * its properties, required list and additionalProperties: false (compareObject);
 * with `items`, its array items; with `union`, its options.
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
    if (rest.additionalProperties === false) delete rest.additionalProperties;
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

function enumChange(before: JsonSchema, after: JsonSchema): { rule: string; head: string; tail: string; fix?: string } | undefined {
  const a = allowedValues(before);
  const b = allowedValues(after);
  if (!a && !b) return undefined;
  if (!a && b) {
    return { rule: 'diff/enum-narrowed', head: `: now limited to ${values(b)}`, tail: 'Calls that send any other value fail validation.', fix: `Accept other values for one more release, or ${BREAKING_RELEASE}.` };
  }
  if (a && !b) return { rule: 'diff/enum-widened', head: ': no longer limited to a fixed set of values', tail: '' };
  const gone = a!.filter((v) => !b!.some((w) => canonical(w) === canonical(v)));
  const fresh = b!.filter((v) => !a!.some((w) => canonical(w) === canonical(v)));
  if (gone.length) {
    return {
      rule: 'diff/enum-narrowed',
      head: `: no longer accepts ${values(gone)}`,
      tail: `Calls that send ${gone.length === 1 ? 'it' : 'them'} fail validation.`,
      fix: `Restore ${gone.length === 1 ? values(gone) : 'them'}, or ${BREAKING_RELEASE}.`,
    };
  }
  if (fresh.length) return { rule: 'diff/enum-widened', head: `: now also accepts ${values(fresh)}`, tail: '' };
  return undefined;
}

/**
 * A text change as two lines, whitespace flattened (a description's line breaks
 * would break the report's layout). A long text shows only where it changed,
 * with a few words around it: "- …for the currently selected page since…".
 */
function textDiff(before: string, after: string): string[] {
  const cut = (s: string) => (s.length > 240 ? s.slice(0, 237) + '…' : s);
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  const [a, b] = [flat(before), flat(after)];
  // Only whitespace changed: show it.
  if (a === b) return [`- ${cut(JSON.stringify(before))}`, `+ ${cut(JSON.stringify(after))}`];
  if (a.length <= 160 && b.length <= 160) return [`- ${a || '(none)'}`, `+ ${b || '(none)'}`];
  const [wa, wb] = [a.split(' '), b.split(' ')];
  let start = 0;
  while (start < wa.length && start < wb.length && wa[start] === wb[start]) start++;
  let end = 0;
  while (end < wa.length - start && end < wb.length - start && wa[wa.length - 1 - end] === wb[wb.length - 1 - end]) end++;
  const context = 4;
  const from = Math.max(0, start - context);
  const excerpt = (words: string[]) => {
    const to = Math.min(words.length, words.length - end + context);
    const text = words.slice(from, to).join(' ');
    return `${from > 0 ? '…' : ''}${text || '(nothing)'}${to < words.length ? '…' : ''}`;
  };
  return [`- ${cut(a ? excerpt(wa) : '(none)')}`, `+ ${cut(b ? excerpt(wb) : '(none)')}`];
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

/**
 * The smallest bump a release line needs for these changes. From 1.0.0, what
 * semver says. Under 1.0.0 each step is one lower, as npm's caret reads it
 * (^0.2.3 accepts any 0.2.x, never 0.3.0): breaking changes need a minor bump,
 * new features a patch. Under 0.1.0 (^0.0.3 accepts only 0.0.3) anything goes.
 */
function requiredBump(suggested: Bump, version: string | undefined): Bump {
  const v = parseSemver(version);
  if (!v || v.nums[0] !== 0) return suggested;
  if (v.nums[1] === 0) return 'none';
  return suggested === 'major' ? 'minor' : suggested === 'minor' ? 'patch' : suggested;
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
