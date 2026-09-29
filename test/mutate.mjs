// Mutation testing for diff: edit a real schema at every position diff compares,
// and check that what diff says matches the edit. The edits and what each must
// produce:
//
//   enum-narrowed       drop a value              → only diff/enum-narrowed, major
//   enum-widened        add a value               → only diff/enum-widened, minor
//   type-changed        string ↔ boolean …        → only diff/param-type, major
//   made-required       an optional field         → only diff/param-required, major
//   property-removed    a required field          → only diff/param-removed, major
//   property-added      a new optional field      → only diff/param-added, minor
//   option-removed      one union option          → only diff/param-type, major
//   options-reordered   a union's options         → nothing
//   moved-to-defs       a block into $defs + $ref → only diff/schema-equivalent
//   description-changed a field's description     → only diff/description, patch
//
// "Only": no other rule, no "review it" (diff/schema-other). One change is one
// kind of finding everywhere it's reached, however deep, and whichever
// definitions it's shared through. And whatever the edit, a schema that accepts
// something different never gets no findings at all.

import { diffMenus, resolveRefs } from '../dist/diff.js';
import { canonical } from '../dist/compare.js';
import { buildMenu } from '../dist/menu.js';

/** Keywords whose subschemas diff compares field by field. Below any other keyword it doesn't. */
const MAP_KEYWORDS = new Set(['properties', '$defs', 'definitions']);
const LIST_KEYWORDS = new Set(['anyOf', 'oneOf']);

/**
 * Every schema node diff compares, as a JSON pointer (array of keys) from the
 * tool's inputSchema. Stops at keywords diff doesn't classify
 * (additionalProperties, allOf, not, if/then/else…), and at $refs (their targets
 * are visited as $defs entries).
 */
export function sites(schema) {
  const out = [];
  const visit = (node, ptr) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    out.push({ ptr, node });
    for (const [k, v] of Object.entries(node)) {
      if (MAP_KEYWORDS.has(k) && v && typeof v === 'object') for (const [name, s] of Object.entries(v)) visit(s, [...ptr, k, name]);
      else if (LIST_KEYWORDS.has(k) && Array.isArray(v)) v.forEach((s, i) => visit(s, [...ptr, k, i]));
      else if (k === 'items' && v && typeof v === 'object' && !Array.isArray(v)) visit(v, [...ptr, k]);
    }
  };
  visit(schema, []);
  return out;
}

const get = (root, ptr) => ptr.reduce((n, k) => n?.[k], root);
const clone = (v) => structuredClone(v);
/** The value a discriminator fixes: a field like this names a union option, it isn't one to mutate. */
const fixed = (s) => s && ('const' in s || (Array.isArray(s.enum) && s.enum.length === 1));
const PRIMITIVE = { string: 'boolean', boolean: 'string', integer: 'string', number: 'string' };

/** Each mutation: where it applies, how it edits a copy of the node, and what diff may say. */
export const MUTATIONS = {
  'enum-narrowed': {
    applies: (n) => Array.isArray(n.enum) && n.enum.length >= 2 && !('const' in n),
    edit: (n) => void n.enum.pop(),
    rules: ['diff/enum-narrowed'],
    bump: 'major',
  },
  'enum-widened': {
    applies: (n) => Array.isArray(n.enum) && n.enum.length >= 2 && n.enum.every((v) => typeof v === 'string') && !('const' in n),
    edit: (n) => void n.enum.push('__mutation__'),
    rules: ['diff/enum-widened'],
    bump: 'minor',
  },
  'type-changed': {
    applies: (n) => typeof n.type === 'string' && n.type in PRIMITIVE && !n.enum && !('const' in n) && !n.anyOf && !n.oneOf,
    edit: (n) => void (n.type = PRIMITIVE[n.type]),
    rules: ['diff/param-type'],
    bump: 'major',
  },
  'made-required': {
    applies: (n) => optionalFields(n).length > 0,
    edit: (n) => void (n.required = [...(n.required ?? []), optionalFields(n)[0]]),
    rules: ['diff/param-required'],
    bump: 'major',
  },
  'property-removed': {
    applies: (n) => requiredFields(n).length > 0,
    edit: (n) => {
      const p = requiredFields(n)[0];
      delete n.properties[p];
      n.required = n.required.filter((r) => r !== p);
    },
    rules: ['diff/param-removed'],
    bump: 'major',
  },
  'property-added': {
    applies: (n) => isObject(n),
    edit: (n) => void (n.properties.__mutation__ = { type: 'string' }),
    rules: ['diff/param-added'],
    bump: 'minor',
  },
  'option-removed': {
    applies: (n) => distinctOptions(n) >= 2,
    edit: (n) => void options(n).pop(),
    rules: ['diff/param-type'],
    bump: 'major',
  },
  'options-reordered': {
    applies: (n) => distinctOptions(n) >= 2,
    edit: (n) => void options(n).reverse(),
    rules: [],
    bump: 'none',
  },
  'moved-to-defs': {
    applies: (n, ptr) => ptr.length > 0 && isObject(n) && !JSON.stringify(n).includes('"$ref"'),
    edit: null, // needs the root: see mutate()
    rules: ['diff/schema-equivalent'],
    bump: 'patch',
  },
  'description-changed': {
    applies: (n, ptr) => ptr.length > 0 && typeof n.description === 'string' && n.description.length > 0,
    edit: (n) => void (n.description += ' (mutated)'),
    rules: ['diff/description'],
    bump: 'patch',
  },
};

function isObject(n) {
  return n.properties && typeof n.properties === 'object' && !Array.isArray(n.properties);
}
function optionalFields(n) {
  if (!isObject(n)) return [];
  const req = new Set(n.required ?? []);
  return Object.keys(n.properties).filter((p) => !req.has(p) && !fixed(n.properties[p]));
}
function requiredFields(n) {
  if (!isObject(n)) return [];
  return (n.required ?? []).filter((p) => p in n.properties && !fixed(n.properties[p]));
}
function options(n) {
  return n.anyOf ?? n.oneOf;
}
function distinctOptions(n) {
  const o = options(n);
  return Array.isArray(o) ? new Set(o.map((x) => canonical(x))).size === o.length && o.length : 0;
}

/** The tool with `kind` applied at `ptr`, or undefined when it doesn't apply there. */
export function mutate(tool, ptr, kind) {
  const m = MUTATIONS[kind];
  const node = get(tool.inputSchema, ptr);
  if (!node || !m.applies(node, ptr)) return undefined;
  const next = clone(tool);
  if (kind === 'moved-to-defs') {
    const root = next.inputSchema;
    const parent = get(root, ptr.slice(0, -1));
    root.$defs = { ...(root.$defs ?? {}), __moved__: clone(node) };
    parent[ptr[ptr.length - 1]] = { $ref: '#/$defs/__moved__' };
    return next;
  }
  m.edit(get(next.inputSchema, ptr));
  return next;
}

/**
 * What diff says about one mutation, and whether that's what it should say. The
 * expectation is relaxed only where the edit can't be seen: an unused $defs entry
 * (the expanded schemas are equal).
 */
export function check(tool, ptr, kind) {
  const next = mutate(tool, ptr, kind);
  if (!next) return undefined;
  const m = MUTATIONS[kind];
  const d = diffMenus(buildMenu([tool], {}), buildMenu([next], {}));
  const rules = [...new Set(d.findings.map((f) => f.rule))].sort();
  const invisible = canonical(resolveRefs(tool.inputSchema)) === canonical(resolveRefs(next.inputSchema));
  const problems = [];
  if (invisible) {
    // An edit nothing refers to changes no accepted input: at most the notice.
    if (rules.some((r) => r !== 'diff/schema-equivalent')) problems.push(`an unreferenced edit gave ${rules.join(', ')}`);
  } else {
    const unexpected = rules.filter((r) => !m.rules.includes(r));
    if (unexpected.length) problems.push(`unexpected ${unexpected.join(', ')}`);
    for (const r of m.rules) if (!rules.includes(r)) problems.push(`missing ${r}`);
    if (m.rules.length && d.suggestedBump !== m.bump) problems.push(`bump ${d.suggestedBump}, expected ${m.bump}`);
    if (!m.rules.length && d.findings.length) problems.push(`findings on a change that accepts the same: ${rules.join(', ')}`);
  }
  return { problems, rules, bump: d.suggestedBump, findings: d.findings, invisible };
}

/**
 * Up to `perKind` sites per tool and mutation kind, spread over the schema
 * (every site when perKind is Infinity), checked. Returns every mismatch.
 */
export function run(menu, { perKind = 6 } = {}) {
  const failures = [];
  let checked = 0;
  for (const tool of menu.tools) {
    const all = sites(tool.inputSchema);
    for (const kind of Object.keys(MUTATIONS)) {
      const applicable = all.filter((s) => MUTATIONS[kind].applies(s.node, s.ptr));
      const step = Math.max(1, Math.ceil(applicable.length / perKind));
      for (let i = 0; i < applicable.length; i += step) {
        const r = check(tool, applicable[i].ptr, kind);
        if (!r) continue;
        checked++;
        if (r.problems.length) {
          failures.push({ tool: tool.name, kind, at: '/' + applicable[i].ptr.join('/'), problems: r.problems, messages: r.findings.map((f) => `${f.severity} ${f.rule}: ${f.message.slice(0, 160)}`) });
        }
      }
    }
  }
  return { checked, failures };
}
