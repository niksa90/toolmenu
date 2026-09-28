import type { JsonSchema, MenuTool } from '../types.js';
import { COLLECTION_VERBS, LOOKUP_VERBS, VERBS, commonWords, nouns, singular, words } from '../words.js';
import type { Rule, RuleFinding } from './rule.js';

interface IdParam {
  param: string;
  /** Which kind of thing it identifies (singular noun), when we can tell. */
  kind?: string;
}

// form_id, form-id, formId, formID. Not uid or paid: the suffix needs a boundary.
// Not "key" either: in real menus it's as often a keyboard key as an identifier.
const ID_SUFFIX = /^(.+?)[_-](id|ids|uuid|uuids)$/i;
const CAMEL_ID = /^([a-z][a-zA-Z0-9]*?)(Id|Ids|ID|IDs|Uuid)$/;
const BARE_ID = /^(id|ids|uid|uuid)$/i;
const CREATE_VERBS = new Set(['create', 'add', 'new', 'insert', 'post', 'upsert', 'start', 'run', 'submit', 'duplicate', 'copy']);
// Words that join alternatives in a name: projectSlugOrId → project.
const JOINERS = new Set(['or', 'and', 'slug', 'name', 'handle']);
// Qualifiers in front of the kind: creatorRegionId and newRegionId are region IDs.
const QUALIFIERS = new Set([
  'creator', 'new', 'old', 'target', 'source', 'parent', 'child', 'from', 'to', 'destination', 'current',
  'previous', 'next', 'owner', 'assigned', 'assignee', 'primary', 'default', 'other', 'related', 'base', 'root',
]);
// A description that tells the agent not to make the value up.
const DONT_INVENT = /\b(do not|don't|never|avoid|must not)\s+(invent|make up|guess|fabricate|generate)\b/i;
// "Omit this in the normal case": optional, and the agent is told to leave it out.
const OMIT = /\b(omit|leave out|leave (it|this) (out|empty|unset|blank))\b/i;

/**
 * The agent is told not to make this value up, in the parameter's description
 * or in a sentence of the tool's description that names the parameter
 * ("don't invent a sessionId").
 */
function toldNotToInvent(tool: MenuTool, param: string, schema: JsonSchema | undefined): boolean {
  const own = typeof schema?.description === 'string' ? schema.description : '';
  if (DONT_INVENT.test(own) || OMIT.test(own)) return true;
  const spaced = param.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return (tool.description ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => {
      const lower = sentence.toLowerCase();
      return (lower.includes(param.toLowerCase()) || lower.includes(spaced)) && DONT_INVENT.test(sentence);
    });
}

/** Inputs that look like opaque IDs the agent has to supply. */
export function idParams(tool: MenuTool): IdParam[] {
  const params: IdParam[] = [];
  const props = tool.inputSchema?.properties ?? {};
  for (const [param, schema] of Object.entries(props)) {
    if (!looksLikeIdValue(schema)) continue;
    const match = CAMEL_ID.exec(param) ?? ID_SUFFIX.exec(param);
    const bare = BARE_ID.test(param);
    const opaqueFormat = schema.format === 'uuid' || (typeof schema.pattern === 'string' && /\[0-9a-f|\[a-f0-9/i.test(schema.pattern));
    if (!match && !bare && !opaqueFormat) continue;
    const kindWords = match?.[1] ? words(match[1]).map(singular).filter((w) => !JOINERS.has(w)) : [];
    while (kindWords.length > 1 && QUALIFIERS.has(kindWords[0])) kindWords.shift();
    const prefix = kindWords.join('_');
    // A bare `id` doesn't say what it identifies (naming/vague-id covers that), so no kind is guessed.
    params.push({ param, kind: prefix || undefined });
  }
  return params;
}

function looksLikeIdValue(schema: JsonSchema): boolean {
  if (schema.enum) return false; // a fixed set of values is chosen, not invented
  const type = schema.type;
  return type === undefined || type === 'string' || type === 'integer' || (Array.isArray(type) && type.includes('string'));
}

/** Does some other tool look like it hands out IDs of this kind? */
function isReturnedBySomeTool(kind: string, self: MenuTool, tools: MenuTool[], common: Set<string>): boolean {
  return tools.some((other) => {
    if (other.name === self.name) return false;
    const w = words(other.name).map(singular).filter((x) => !common.has(x));
    const verbs = w.filter((x) => VERBS.has(x));
    const subject = nouns(other.name).filter((x) => !common.has(x));
    // The kind in its name, as a noun or a word run (data_source), or as the verb itself (searchId ← search).
    const mentionsKind = w.join('_').split('_').includes(kind) || `_${w.join('_')}_`.includes(`_${kind}_`);
    const lookup = verbs.some((v) => LOOKUP_VERBS.has(v));
    const collection = verbs.some((v) => COLLECTION_VERBS.has(v)) || w.includes('children');
    const needsSameId = idParams(other).some((p) => p.kind === kind);
    // A list or search for that kind; a get that doesn't itself need the ID.
    if (lookup && mentionsKind && (collection || !needsSameId)) return true;
    // A search that names nothing in particular: that's how agents find IDs of any kind.
    if (collection && subject.length === 0) return true;
    // Creating a thing returns its ID.
    if (verbs.some((v) => CREATE_VERBS.has(v)) && mentionsKind && !needsSameId) return true;
    // Or an output schema that carries the ID.
    return outputMentions(other.outputSchema, kind);
  });
}

function outputMentions(schema: JsonSchema | undefined, kind: string, depth = 0, parent = ''): boolean {
  if (!schema || depth > 6) return false;
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const n = words(name).map(singular).join('_');
    if (n === `${kind}_id` || n === `${kind}_uuid` || (n === 'id' && singular(parent) === kind)) return true;
    if (outputMentions(child, kind, depth + 1, name)) return true;
  }
  if (schema.items && outputMentions(schema.items, kind, depth + 1, parent)) return true;
  return false;
}

export const authoredIds: Rule = {
  id: 'ids/authored',
  severity: 'warn',
  lesson: '01',
  summary: 'IDs the agent must supply should come from some other tool',
  run(ctx) {
    const findings: RuleFinding[] = [];
    const common = commonWords(ctx.menu.tools.map((t) => t.name));
    for (const tool of ctx.menu.tools) {
      for (const { param, kind } of idParams(tool)) {
        if (!kind || isReturnedBySomeTool(kind, tool, ctx.menu.tools, common)) continue;
        const schema = tool.inputSchema?.properties?.[param];
        if (saysWhereItComesFrom(schema, ctx.menu.tools, tool.name)) continue;
        // Optional, and the description already tells the agent not to invent it.
        const optional = !(tool.inputSchema?.required ?? []).includes(param);
        if (optional && toldNotToInvent(tool, param, schema)) continue;
        findings.push({
          tool: tool.name,
          message: `${tool.name}.${param}: looks like a ${kind} ID the agent must supply, but no tool appears to return one (no list/search/get tool for "${kind}", no output schema with a ${kind} ID). The agent may invent it. Heuristic.`,
        });
      }
    }
    return findings;
  },
};

const PROVENANCE = /\b(from|returned by|obtained|output of|result of|as (listed|shown|returned))\b/i;

/** The parameter's description says where the value comes from, or names the tool that gives it. */
function saysWhereItComesFrom(schema: JsonSchema | undefined, tools: MenuTool[], self: string): boolean {
  const text = typeof schema?.description === 'string' ? schema.description : '';
  if (!text) return false;
  return PROVENANCE.test(text) || tools.some((t) => t.name !== self && text.includes(t.name));
}
