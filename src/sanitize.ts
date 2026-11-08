/*
 * Text a server chose (tool names, descriptions, versions, error output), made safe
 * for where toolmenu prints it. The menu file keeps the exact bytes; only what's
 * shown changes.
 *
 * Shown as escapes, not dropped: a name with an escape sequence in it reads
 * `a\u001b[2Jb`, so the report says what the server really sent and two different
 * names never look the same. spec/tool-name says what's wrong with such a name.
 */

/**
 * Characters a terminal (or GitHub's log parser) acts on, or a reader can't see:
 * controls (C0, C1, DEL), format characters (the bidi overrides and isolates that
 * reorder what's shown, "Trojan Source"; zero-width spaces and joiners; the soft
 * hyphen; tag characters), line and paragraph separators, everything Unicode says
 * renders as nothing (variation selectors, Hangul fillers), and the blank braille
 * cell. Newline and tab are in it: a server's newline would start a line of its own
 * (a fake finding, a `::error::` workflow command). spec/tool-name uses the same class.
 */
export const HIDDEN_SOURCE = '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u2800]';
const UNSAFE = new RegExp(HIDDEN_SOURCE, 'gu');
// The same but newline and tab, for a report whose own lines are already made.
const UNSAFE_IN_REPORT = new RegExp(`(?![\\n\\t])${HIDDEN_SOURCE}`, 'gu');

const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
/**
 * A character as an escape: \u001b; past the first plane as its UTF-16 pair
 * (\udb40\udc41), which JSON and JavaScript read back as the same character, so a
 * JSON report run through terminalSafe() is still the same JSON.
 */
const visible = (c: string) =>
  NAMED[c] ??
  [...Array(c.length).keys()].map((i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');

/** One field of server text, for the terminal: every control character shown as an escape. */
export function plain(text: string): string {
  return text.replace(UNSAFE, visible);
}

/**
 * A whole report, last thing before it's printed: whatever control characters a field
 * still carries are shown as escapes. Its own newlines and tabs stay; the fields that
 * came from the server have already had theirs escaped by plain().
 */
export function terminalSafe(report: string): string {
  return report.replace(UNSAFE_IN_REPORT, visible);
}

/** Links toolmenu's own messages make, kept clickable in markdown. */
const OWN_LINKS = ['https://github.com/niksa90/toolmenu', 'https://code.claude.com/docs/', 'https://modelcontextprotocol.io/'];

/**
 * Markdown that GitHub would act on in plain text: links and images ([ ] !), HTML
 * and autolinks (< >), entities (&), escapes, table cells (|) and bold (*). Not _ or
 * ~: they're in most tool names, and at worst they italicize or strike text through.
 */
const MD_SPECIAL = /[\\`*[\]<>!|&]/;
/** MD_SPECIAL, and what GitHub links on its own: @mentions, #refs and GH-refs, bare URLs. */
const MD_INERT = new RegExp(`${MD_SPECIAL.source}|@|#(?=\\d)|\\bGH-(?=\\d)|:\\/\\/|\\bwww\\.`, 'gi');
const MD_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** A zero-width space, as an entity: breaks a mention, reference or autolink without showing. */
const ZWSP = '&#8203;';

/**
 * A link toolmenu's own messages make: one of OWN_LINKS, then the end, "/", "#" or "?",
 * with no dot segments (/../ would leave the path the prefix names) and nothing that
 * markdown or a URL parser reads specially.
 */
function ownLink(url: string): boolean {
  return OWN_LINKS.some((p) => url.startsWith(p) && (p.endsWith('/') || url.length === p.length || '/#?'.includes(url[p.length]))) && !/(^|[\\/])\.\.?([\\/?#]|$)|%2e|[\\\\*[\]!&@]/i.test(url);
}

/** Plain text (no backticks in it) as inert markdown. */
function mdPlain(text: string): string {
  let out = '';
  // A link toolmenu itself makes stays a link; anything else that would autolink doesn't.
  const parts = text.split(/(https?:\/\/[^\s<>()|`]+)/);
  parts.forEach((part, i) => {
    if (i % 2 === 1 && ownLink(part)) {
      out += part;
      return;
    }
    // One pass, so no replacement sees another's output (the # of an entity).
    out += part.replace(MD_INERT, (m) => {
      if (m === '@' || m === '#') return `${m}${ZWSP}`; // no mention or mailto link; no cross-reference on an issue
      if (/^GH-$/i.test(m)) return `${m.slice(0, 2)}${ZWSP}-`;
      if (m === '://') return `:${ZWSP}//`; // https://…: shown, not linked
      if (/^www\./i.test(m)) return `${m.slice(0, 3)}${ZWSP}.`;
      return MD_ESCAPE[m] ?? `\\${m}`;
    });
  });
  return out;
}

export interface MdOptions {
  /** In a table cell: pipes are escaped, even inside code spans (GFM requires it). */
  cell?: boolean;
}

/**
 * Text as a markdown code span that it can't close: a fence of backticks longer than
 * any run inside it, padded when it starts or ends with one. Control characters are
 * shown as escapes, so it's always one line.
 */
export function mdCode(text: string, options: MdOptions = {}): string {
  const shown = plain(text);
  if (!shown) return '';
  // A loop, not Math.max(...runs): a name with 100k backtick runs would overflow the stack.
  let longest = 0;
  for (const run of shown.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad = /^[`\s]|[`\s]$/.test(shown) ? ' ' : '';
  const body = options.cell ? shown.replace(/\|/g, '\\|') : shown;
  return `${fence}${pad}${body}${pad}${fence}`;
}

/**
 * A finding's text, or any line that carries server text, as markdown: toolmenu's own
 * `code` spans stay code, everything else is escaped. A backtick in a server's text
 * can only move where code starts and ends: every piece is rendered inert either way.
 */
export function mdText(text: string, options: MdOptions = {}): string {
  const pieces = plain(text).split('`');
  // An unpaired backtick: the last piece is text, the backtick shown.
  const unpaired = pieces.length % 2 === 0;
  return pieces
    .map((piece, i) => {
      const last = i === pieces.length - 1;
      if (i % 2 === 1 && !(unpaired && last)) return mdCode(piece, options);
      const escaped = mdPlain(piece);
      return unpaired && last ? `\\\`${escaped}` : escaped;
    })
    .join('');
}

type Write = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
const unguarded = new WeakMap<NodeJS.WritableStream, Write>();

/**
 * The net under every field: from here on, text written to `stream` goes through
 * terminalSafe(). For the CLI's stdout and stderr, whatever the command; JSON stays
 * the same JSON (its escapes read back as the same characters). Twice is once.
 */
export function guardStream(stream: NodeJS.WritableStream): void {
  if (unguarded.has(stream)) return;
  const write = stream.write.bind(stream) as Write;
  unguarded.set(stream, write);
  (stream as { write: Write }).write = (chunk, ...rest) => write(typeof chunk === 'string' ? terminalSafe(chunk) : chunk, ...rest);
}

/** Write past the net: only text already made safe, with toolmenu's own colour codes added. */
export function writeUnguarded(stream: NodeJS.WritableStream, text: string): void {
  (unguarded.get(stream) ?? (stream.write.bind(stream) as Write))(text);
}
