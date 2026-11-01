/*
 * $ref resolution inside one JSON Schema, the way a client that must not fetch
 * anything resolves it (2026-07-28, SEP-2106): JSON Pointers, $anchor and
 * $dynamicAnchor, draft-07 plain-name $id ("#node"), and embedded resources
 * named by $id, each pointer resolved inside the resource it's written in.
 * Shared by spec/ref (does it resolve?) and the token breakdown (which $defs
 * entries are used?), so the two always agree.
 */

/** Keywords whose value is one schema. */
const ONE = ['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'contentSchema'];
/** Keywords whose value is a list of schemas (draft-07 `items` can be one too). */
const LIST = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'];
/** Keywords whose value maps names to schemas (draft-07 `dependencies` maps to a schema or a list of names; only the schemas count). */
const MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'];

/** Each subschema of a schema node, with the step that reaches it: `{ key: 'properties', name: 'a' }`. */
export function children(node: Record<string, unknown>): { key: string; name?: string; index?: number; value: unknown }[] {
  const out: { key: string; name?: string; index?: number; value: unknown }[] = [];
  for (const key of ONE) {
    const v = node[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push({ key, value: v });
  }
  for (const key of LIST) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((value, index) => out.push({ key, index, value }));
  }
  for (const key of MAP) {
    const v = node[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [name, value] of Object.entries(v)) if (value && typeof value === 'object' && !Array.isArray(value)) out.push({ key, name, value });
    }
  }
  return out;
}

/** A percent-escape that doesn't decode is kept as written, never thrown. */
function decode(part: string): string {
  let text = part;
  try {
    text = decodeURIComponent(part);
  } catch {
    // keep it raw
  }
  return text.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** `base` + `ref` the way a URI resolves: absolute stays, relative joins an absolute base, otherwise as written. */
function join(base: string, ref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref;
  if (/^[a-z][a-z0-9+.-]*:/i.test(base)) {
    try {
      return new URL(ref, base).href;
    } catch {
      return ref;
    }
  }
  return ref;
}

const strip = (uri: string) => uri.replace(/#$/, '');

/** What a ref points to: the value (an object, or a boolean schema such as `true`), and the top-level $defs entry it belongs to. */
export interface Target {
  value: unknown;
  entry?: string;
}

export interface SchemaIndex {
  /** What a ref written inside a resource with base `base` points to; undefined when nothing in the schema matches. */
  resolve(ref: string, base: string): Target | undefined;
  /** Every $ref and $dynamicRef in the schema, with where it's written and the resource base it's resolved against. */
  refs: { ref: string; base: string; path: string[]; node: object }[];
  /** The top-level $defs/definitions entry (`$defs/A`) a node belongs to, if any. */
  entryOf(node: object): string | undefined;
}

/** Index one schema: its resources, anchors and references. */
export function indexSchema(schema: unknown): SchemaIndex {
  const resources = new Map<string, object>();
  const anchors = new Map<string, object>();
  const refs: SchemaIndex['refs'] = [];
  const entries = new Map<object, string>();
  const root = (schema && typeof schema === 'object' ? schema : {}) as Record<string, unknown>;
  const rootBase = typeof root.$id === 'string' && !root.$id.startsWith('#') ? strip(root.$id) : '';
  resources.set(rootBase, root);

  const walk = (node: unknown, base: string, path: string[], entry: string | undefined, depth: number) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 64) return;
    const s = node as Record<string, unknown>;
    if (entry) entries.set(s, entry);
    let here = base;
    if (typeof s.$id === 'string') {
      if (s.$id.startsWith('#')) anchors.set(`${base}#${s.$id.slice(1)}`, s); // draft-07 plain name
      else {
        here = strip(join(base, s.$id));
        resources.set(here, s);
      }
    }
    for (const key of ['$anchor', '$dynamicAnchor']) if (typeof s[key] === 'string') anchors.set(`${here}#${s[key]}`, s);
    for (const key of ['$ref', '$dynamicRef']) if (typeof s[key] === 'string') refs.push({ ref: s[key] as string, base: here, path, node: s });
    for (const c of children(s)) {
      const step = c.key === 'properties' ? c.name! : c.name !== undefined ? `<${c.key}>.${c.name}` : c.index !== undefined ? `<${c.key}>.${c.index}` : `<${c.key}>`;
      const owner = entry ?? (depth === 0 && (c.key === '$defs' || c.key === 'definitions') ? `${c.key}/${c.name}` : undefined);
      walk(c.value, here, [...path, step], owner, depth + 1);
    }
  };
  walk(root, rootBase, [], undefined, 0);

  const pointer = (resource: object, fragment: string): Target | undefined => {
    if (fragment === '' || fragment === '/') return { value: resource, entry: entries.get(resource) };
    const parts = fragment.slice(1).split('/').map(decode);
    let node: unknown = resource;
    for (const part of parts) {
      if (Array.isArray(node) && /^\d+$/.test(part) && Number(part) < node.length) node = node[Number(part)];
      else if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, part)) node = (node as Record<string, unknown>)[part];
      else return undefined;
    }
    // An object target knows its entry; a boolean schema ($defs: { Any: true }) gets it from the path.
    const entry =
      node && typeof node === 'object'
        ? entries.get(node as object)
        : resource === root && (parts[0] === '$defs' || parts[0] === 'definitions') && parts.length >= 2
          ? `${parts[0]}/${parts[1]}`
          : undefined;
    return { value: node, ...(entry ? { entry } : {}) };
  };

  return {
    refs,
    entryOf: (node) => entries.get(node),
    resolve(ref, base) {
      const target = ref === '' ? base : ref.startsWith('#') ? `${base}${ref}` : join(base, ref);
      const hash = target.indexOf('#');
      const where = strip(hash < 0 ? target : target.slice(0, hash));
      // Split a pointer into segments before decoding any: "~1" is a "/" inside one segment.
      const fragment = hash < 0 ? '' : target.slice(hash + 1);
      const resource = resources.get(where);
      if (!resource) return undefined;
      if (fragment === '' || fragment.startsWith('/')) return pointer(resource, fragment);
      const anchored = anchors.get(`${where}#${decode(fragment)}`);
      return anchored ? { value: anchored, ...(entries.get(anchored) ? { entry: entries.get(anchored) } : {}) } : undefined;
    },
  };
}

/**
 * Is the ref a network URI, which clients must not fetch? A fragment-only ref
 * ("#/$defs/Typo", "#anchor") points into the schema it's written in, whatever that
 * schema's $id: when it doesn't resolve, it's missing, not remote.
 */
export function isNetworkRef(ref: string, base: string): boolean {
  if (ref === '' || ref.startsWith('#')) return false;
  return /^https?:\/\//i.test(join(base, ref));
}

/** Which top-level $defs/definitions entries a schema uses, following refs from outside them and then from the entries used. */
export function usedEntries(schema: unknown): Set<string> {
  const index = indexSchema(schema);
  const used = new Set<string>();
  const queue = index.refs.filter((r) => !index.entryOf(r.node));
  while (queue.length) {
    const r = queue.pop()!;
    const entry = index.resolve(r.ref, r.base)?.entry;
    if (!entry || used.has(entry)) continue;
    used.add(entry);
    // Every ref written inside the entry now counts too ($ref and $dynamicRef on one node alike).
    for (const inner of index.refs) if (index.entryOf(inner.node) === entry) queue.push(inner);
  }
  return used;
}
