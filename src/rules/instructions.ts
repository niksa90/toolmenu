import { count, type Rule, type RuleFinding } from './rule.js';

/** Verbs a tool name usually starts with: they tell a tool (call submit_feedback) from a field written the same way. */
const VERBS = new Set(
  'get list search find fetch read browse create add update edit delete remove set mark save submit send upload download run start stop check explore suggest report publish apply cancel move import export confirm forget remember restore dismiss reply generate prepare format replace reopen answer undo parse query lookup describe show open close resolve call invoke execute'.split(' '),
);

/** Last words of a name that make it a field or a setting, not a tool: open_url, read_only, check_first. */
const FIELD_ENDS = new Set('url urls link links id ids at on only with here first hr ms seconds minutes hours days count total'.split(' '));

/**
 * A sentence that says why a tool isn't listed: old names, or a condition on it (a login,
 * a token, an account, an unlock, a private mode). The rule's own fix, already done. A
 * word like "token" alone isn't one: it has to sit near what makes it a condition.
 */
const CONDITION = String.raw`(?:tokens?|(?:api )?keys?|account|log ?in|sign ?in|logged in|signed in|authenticat\w*|credentials?|scope)`;
const AVAILABILITY = String.raw`(?:only|available|unlock\w*|adds?|requires?|needs?|after|once|with an?)`;
/** Up to 120 characters within one sentence: a full stop inside a URL or rs_live_... doesn't end it. */
const GAP = String.raw`(?:[^.;]|\.(?!\s|$)){0,120}?`;
const EXPLAINED = [
  /\b(?:old(?:er)? (?:tool )?names|formerly|renamed|deprecated|private mode|unlock\w*)\b/i,
  /\bwhen (?:the )?tools are available\b/i,
  new RegExp(String.raw`\b${AVAILABILITY}\b${GAP}\b${CONDITION}\b`, 'i'),
  new RegExp(String.raw`\b${CONDITION}\b${GAP}\b(?:unlock\w*|adds?|only)\b`, 'i'),
];

interface Mention {
  at: number;
  before: string;
  after: string;
  sentence: string;
}

/** Each place `word` stands alone in `text`: where, what comes before and after it on its line, and its sentence. */
function mentions(text: string, word: string): Mention[] {
  const found: Mention[] = [];
  const re = new RegExp(String.raw`(?<![\w/.:-])${word}(?![\w-])`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const line0 = text.lastIndexOf('\n', m.index) + 1;
    const lineEnd = text.indexOf('\n', m.index);
    found.push({
      at: m.index,
      before: text.slice(Math.max(line0, m.index - 40), m.index),
      after: text.slice(m.index + word.length, lineEnd === -1 ? m.index + word.length + 20 : Math.min(lineEnd, m.index + word.length + 20)),
      sentence: wholeSentence(text, m.index),
    });
  }
  return found;
}

/** Every property name in a schema, at any depth. */
function propertyNames(schema: unknown, out: Set<string>): void {
  if (Array.isArray(schema)) for (const item of schema) propertyNames(item, out);
  else if (schema && typeof schema === 'object') {
    const props = (schema as { properties?: unknown }).properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) for (const key of Object.keys(props)) out.add(key);
    for (const value of Object.values(schema)) if (value && typeof value === 'object') propertyNames(value, out);
  }
}

/**
 * A URI template (RFC 6570) as a pattern for the URIs it expands to. A plain {var} is one
 * path segment; {+var} and {#var} may span slashes; {/var}, {.var}, {;var}, {?var} and
 * {&var} add their own prefix, or nothing when the variable is undefined.
 */
function templatePattern(template: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = template.split(/(\{[^}]+\})/);
  const source = parts
    .map((part) => {
      if (!part.startsWith('{')) return escape(part);
      const op = part[1];
      if (op === '+' || op === '#') return '.*';
      if (op === '/') return '(?:/[^?#]*)?';
      if (op === '.') return String.raw`(?:\.[^/?#]*)?`;
      if (op === ';') return '(?:;[^/?#]*)?';
      if (op === '?' || op === '&') return '(?:[?&][^#]*)?';
      return '[^/?#]+';
    })
    .join('');
  return new RegExp(`^${source}$`);
}

export const unknownName: Rule = {
  id: 'instructions/unknown-name',
  severity: 'warn',
  summary: "The server's instructions name a tool or resource the server doesn't list",
  run(ctx) {
    const text = ctx.instructions;
    if (!text) return [];
    const tools = ctx.menu.tools.map((t) => t.name);
    const listed = new Set(tools);
    const fields = new Set<string>();
    for (const t of ctx.menu.tools) {
      propertyNames(t.inputSchema, fields);
      propertyNames(t.outputSchema, fields);
    }
    // Words in the instructions that read as something else, by the bench (2026-11-19, 52
    // servers): fields and values (chart_url, read_only, action=update_budget, stop_loss: 2),
    // subcommands of a listed tool (participate submit_position), prompts, and tools the
    // sentence itself says are old or need a login, a token or an unlock first.
    const prompts = new Set((ctx.menu.prompts ?? []).map((p) => p.name).filter((n): n is string => typeof n === 'string'));
    const toolPattern = tools.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const afterTool = toolPattern ? new RegExp(String.raw`(?:^|[^\w])(?:${toolPattern})\s+$`) : undefined;
    const counts = ({ before, after, sentence }: Mention) =>
      !/[=]\s*["'`]?$/.test(before) && !/^\.\w/.test(after) && !/^\s*[:=]\s*(?:["'`\d-]|true\b|false\b|null\b)/.test(after) && !afterTool?.test(before) && !EXPLAINED.some((re) => re.test(sentence));

    // snake_case words that read as a tool name, not in the menu: not a field in any
    // schema, and not the end of a namespaced tool name (search_stories for worklore_search_stories).
    const named = [...new Set(text.match(/(?<![\w/.:-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w-])/g) ?? [])];
    const missingTools: { name: string; at: number }[] = [];
    for (const w of named) {
      if (listed.has(w) || fields.has(w) || prompts.has(w) || tools.some((n) => n.endsWith(`_${w}`))) continue;
      const parts = w.split('_');
      if (!VERBS.has(parts[0]) || FIELD_ENDS.has(parts[parts.length - 1])) continue;
      // The first mention that's neither a value nor a subcommand, nor in a sentence that already says why.
      const kept = mentions(text, w).find(counts);
      if (kept) missingTools.push({ name: w, at: kept.at });
    }

    // Resource URIs in a scheme the server lists resources under, that match no listed
    // resource or template. Only when the lists were read in full (--lists resources).
    const missingUris: { name: string; at: number }[] = [];
    const resources = ctx.menu.resources;
    const templates = ctx.menu.resourceTemplates;
    const cut = ctx.lists?.read.some((r) => (r.kind === 'resources' || r.kind === 'resourceTemplates') && r.first.truncated);
    if ((resources || templates) && !cut) {
      const uris = new Set((resources ?? []).map((r) => r.uri).filter((u): u is string => typeof u === 'string'));
      const patterns = (templates ?? []).map((t) => t.uriTemplate).filter((u): u is string => typeof u === 'string');
      const schemes = new Set([...uris, ...patterns].map((u) => u.split('://')[0]));
      const seen = new Set<string>();
      for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s`'")\]<>,*]+/g)) {
        const raw = m[0];
        // Markdown and sentence ends: **acme://guide**, acme://guide.
        const uri = raw.replace(/[.;:!?_]+$/, '');
        const next = text[m.index + raw.length] ?? '';
        // zavod://blog/<slug>: a placeholder in the text, not a URI to read
        if (/[<{]/.test(next) || uri.endsWith('/') || seen.has(uri)) continue;
        seen.add(uri);
        const scheme = uri.split('://')[0];
        if (!schemes.has(scheme) || scheme === 'http' || scheme === 'https') continue;
        if (uris.has(uri) || patterns.includes(uri) || patterns.some((p) => templatePattern(p).test(uri))) continue;
        missingUris.push({ name: uri, at: m.index });
      }
    }
    // In the order the agent reads them: by the mention that counted.
    missingTools.sort((a, b) => a.at - b.at);
    if (!missingTools.length && !missingUris.length) return [];

    const names = (list: { name: string }[]) => list.map((x) => x.name).join(', ');
    const what = [
      missingTools.length ? `${count(missingTools.length, 'tool')} the menu doesn't list (${names(missingTools)})` : '',
      missingUris.length ? `${count(missingUris.length, 'resource')} no listed resource or template matches (${names(missingUris)})` : '',
    ].filter(Boolean);
    // Listed without credentials, a menu may lack what a login adds (Dreamwork's guest mode).
    const login = ctx.usedAuth ? '' : ' This menu was listed without credentials; if a login adds them, list with credentials to check.';
    // A server with prompts whose list wasn't read: a prompt's name can read as a tool here.
    const unreadPrompts = missingTools.length && ctx.capabilities.prompts !== undefined && !ctx.menu.prompts ? ' The server declares prompts and they weren\'t listed, so one of these may be a prompt: list them with --lists prompts.' : '';
    const finding: RuleFinding = {
      // A tool name is read from the words, so unsure; a URI in the server's own scheme isn't.
      ...(missingTools.length ? { confidence: 'unsure' as const } : {}),
      message: `The server's instructions name ${what.join(', and ')}. A client may give the agent the instructions; an agent that follows them asks for something this server didn't offer, and gets an error.${login}${unreadPrompts}`,
      detail: [...missingTools, ...missingUris].map(({ name, at }) => `${name}: “${sentenceAt(text, at, name.length)}”`),
      fix: 'Name only what the server lists, in the words it lists them: rename the instructions or the tool, or say when one is available (after a login, behind an unlock tool).',
    };
    return [finding];
  },
};

/** The whole sentence or line around position `at`, however long: what explains a name can be far from it. */
function wholeSentence(text: string, at: number): string {
  const start = Math.max(text.lastIndexOf('. ', at) + 1, text.lastIndexOf('\n', at) + 1);
  const ends = [text.indexOf('. ', at), text.indexOf('\n', at)].filter((i) => i !== -1);
  return text.slice(start, ends.length ? Math.min(...ends) + 1 : text.length);
}

/** The sentence around position `at`, to quote: at most 120 characters each way. */
function sentenceAt(text: string, at: number, length: number): string {
  const start = Math.max(text.lastIndexOf('. ', at) + 1, text.lastIndexOf('\n', at) + 1, at - 120);
  const endDot = text.indexOf('. ', at + length);
  const end = Math.min(endDot === -1 ? text.length : endDot + 1, at + length + 120);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}
