import { count, type Rule, type RuleFinding } from './rule.js';

/**
 * Verbs a tool name usually starts with. With the first words of the menu's own tool
 * names, they tell a tool name in the instructions (call submit_feedback) from a field
 * or setting written the same way (work_authorization).
 */
const VERBS = new Set(
  'get list search find fetch read browse create add update edit delete remove set mark save submit send upload download run start stop check explore suggest report publish apply cancel move import export confirm forget remember restore dismiss reply generate prepare format replace reopen answer undo parse query lookup describe show open close resolve call invoke execute'.split(' '),
);

/** Last words of a name that make it a field or a setting, not a tool: open_url, read_only, check_first. */
const FIELD_ENDS = new Set('url urls link links id ids at on only with here first hr ms seconds minutes hours days count total'.split(' '));

/** A sentence that says why a tool isn't listed yet: the rule's own fix, already done. */
const EXPLAINED = /\b(?:old(?:er)? (?:tool )?names|former(?:ly)?|renamed|deprecated|unlock|only with|available only|only available|when (?:the )?tools are available|private mode|tokens?|log ?in|sign ?in|logged in|signed in|authenticat\w*|write.scope|account|another server|other server)\b/i;

/** Each place `word` stands alone in `text`: what comes before and after it on its line, and its sentence. */
function mentions(text: string, word: string): { before: string; after: string; sentence: string }[] {
  const found: { before: string; after: string; sentence: string }[] = [];
  const re = new RegExp(`(?<![\\w/.:-])${word}(?![\\w-])`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const line0 = text.lastIndexOf('\n', m.index) + 1;
    const lineEnd = text.indexOf('\n', m.index);
    found.push({
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

/** `worklore://story/{slug}` as a pattern: each {variable} is one or more characters but a slash. */
function templatePattern(template: string): RegExp {
  return new RegExp('^' + template.split(/\{[^}]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
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
    const afterTool = toolPattern ? new RegExp(`(?:^|[^\\w])(?:${toolPattern})\\s+$`) : undefined;
    // snake_case words that read as a tool name, not in the menu: not a field in any
    // schema, and not the end of a namespaced tool name (search_stories for worklore_search_stories).
    const named = [...new Set(text.match(/(?<![\w/.:-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w-])/g) ?? [])];
    const missingTools = named.filter((w) => {
      if (listed.has(w) || fields.has(w) || prompts.has(w) || tools.some((n) => n.endsWith(`_${w}`))) return false;
      const parts = w.split('_');
      if (!VERBS.has(parts[0]) || FIELD_ENDS.has(parts[parts.length - 1])) return false;
      // Every mention a value or a subcommand, or in a sentence that already says why the tool isn't there.
      return mentions(text, w).some(({ before, after, sentence }) =>
        !/[=]\s*["'`]?$/.test(before) && !/^\s*[:=]\s*(?:["'`\d-]|true\b|false\b|null\b)/.test(after) && !afterTool?.test(before) && !EXPLAINED.test(sentence));
    });

    // Resource URIs in a scheme the server lists resources under, that match no listed
    // resource or template. Only when the lists were read (--lists resources).
    const missingUris: string[] = [];
    const resources = ctx.menu.resources;
    const templates = ctx.menu.resourceTemplates;
    if (resources || templates) {
      const uris = new Set((resources ?? []).map((r) => r.uri).filter((u): u is string => typeof u === 'string'));
      const patterns = (templates ?? []).map((t) => t.uriTemplate).filter((u): u is string => typeof u === 'string');
      const schemes = new Set([...uris, ...patterns].map((u) => u.split('://')[0]));
      for (const raw of new Set(text.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s`'")\]<>,]+/g) ?? [])) {
        const uri = raw.replace(/[.;:!?]+$/, '');
        // zavod://blog/<slug>: a placeholder in the text, not a URI to read
        if (/[<{]/.test(text.slice(text.indexOf(raw) + raw.length, text.indexOf(raw) + raw.length + 1)) || uri.endsWith('/')) continue;
        if (!schemes.has(uri.split('://')[0]) || ['http', 'https'].includes(uri.split('://')[0])) continue;
        if (uris.has(uri) || patterns.includes(uri) || patterns.some((p) => templatePattern(p).test(uri))) continue;
        missingUris.push(uri);
      }
    }
    if (!missingTools.length && !missingUris.length) return [];

    const what = [
      missingTools.length ? `${count(missingTools.length, 'tool')} the menu doesn't list (${missingTools.join(', ')})` : '',
      missingUris.length ? `${count(missingUris.length, 'resource')} no listed resource or template matches (${missingUris.join(', ')})` : '',
    ].filter(Boolean);
    // Listed without credentials, a menu may lack what a login adds (Dreamwork's guest mode).
    const login = ctx.usedAuth ? '' : ' This menu was listed without credentials; if a login adds them, list with credentials to check.';
    // A tool name is read from the words, so unsure; a URI in the server's own scheme isn't.
    const finding: RuleFinding = {
      ...(missingTools.length ? { confidence: 'unsure' as const } : {}),
      message: `The server's instructions name ${what.join(', and ')}. A client may give the agent the instructions; an agent that follows them asks for something this server didn't offer, and gets an error.${login}`,
      detail: [
        ...missingTools.map((w) => `${w}: “${sentence(text, w)}”`),
        ...missingUris.map((u) => `${u}: “${sentence(text, u)}”`),
      ],
      fix: 'Name only what the server lists, in the words it lists them: rename the instructions or the tool, or say when one is available (after a login, behind an unlock tool).',
    };
    return [finding];
  },
};

/** The sentence around the first mention of `word`, cut to a line. */
function sentence(text: string, word: string): string {
  return sentenceAt(text, text.indexOf(word), word.length);
}

/** The whole sentence or line around position `at`, however long: what explains a name can be far from it. */
function wholeSentence(text: string, at: number): string {
  const start = Math.max(text.lastIndexOf('. ', at) + 1, text.lastIndexOf('\n', at) + 1);
  const ends = [text.indexOf('. ', at), text.indexOf('\n', at)].filter((i) => i !== -1);
  return text.slice(start, ends.length ? Math.min(...ends) + 1 : text.length);
}

/** The sentence around position `at`: from the last full stop or line break, at most 120 characters each way. */
function sentenceAt(text: string, at: number, length: number): string {
  const start = Math.max(text.lastIndexOf('. ', at) + 1, text.lastIndexOf('\n', at) + 1, at - 120);
  const endDot = text.indexOf('. ', at + length);
  const end = Math.min(endDot === -1 ? text.length : endDot + 1, at + length + 120);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}
