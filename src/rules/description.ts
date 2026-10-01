import type { MenuTool } from '../types.js';
import { clip, kept, num, type Rule, type RuleFinding } from './rule.js';

/*
 * Clients that cut tool descriptions, and where. Only reported cuts, with sources:
 * - claude-code: 2,048 characters, "… [truncated]" appended, silently (anthropics/claude-code#87650);
 *   the Claude Code changelog lists CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH to change it from 2.1.280.
 * - amazon-q: 10,024 characters, with a warning (Amazon Q CLI 1.19; makenotion/notion-mcp-server#145).
 * Other clients send the description in full or don't document a cut. Your own
 * client may cut elsewhere: set descriptionLimit to its number.
 */
export const CLIENT_LIMITS: Record<string, number> = { 'claude-code': 2048, 'amazon-q': 10024 };
export const DEFAULT_CLIENT = 'claude-code';

/**
 * The cut in characters, the client to name in a message ("Claude Code", "your
 * client"), and whether it's toolmenu's assumption rather than the user's setting.
 */
export function resolveLimit(setting: number | string | undefined): { limit: number; who: string; assumed: boolean } {
  if (typeof setting === 'number') return { limit: setting, who: 'your client', assumed: false };
  const client = setting ?? DEFAULT_CLIENT;
  const limit = CLIENT_LIMITS[client] ?? CLIENT_LIMITS[DEFAULT_CLIENT];
  return { limit, who: client === 'amazon-q' ? 'Amazon Q CLI' : 'Claude Code', assumed: setting === undefined };
}

/** The fix's last words when the cut is assumed, not set. */
function unlessOtherClient(assumed: boolean): string {
  return assumed ? ' If your client isn\'t Claude Code, set descriptionLimit to its cut.' : '';
}

/*
 * An instruction tells the agent what to do or not do: "use X", "call this tool",
 * "don't retry", "never guess one", "if the user asks…". A description of
 * behaviour uses the same words without addressing the agent: "never throws",
 * "instead of failing", "rather than erroring", "was never recognized". Only
 * instructions count, and every one past the cut is checked, not just the first.
 */
const VERBS = 'use|call|retry|guess|invent|make up|fabricate|hand[- ]?construct|construct|build|surface|pass|send|assume|query|search|fetch|ask|expose|show|display|look up|write|put|add|include|rely on|trust|confuse|mix up|treat';
const INSTRUCTION = [
  new RegExp(String.raw`\b(?:don'?t|do not|never|must not|should not|avoid)\s+(?:${VERBS})\b`, 'gi'),
  /\b(?:use|call|try|prefer)\s+(?:this tool|this one|that tool|the [\w-]+ tool)\b/gi,
  /\buse this (?:tool )?(?:when|for|to|if|only)\b/gi,
  /\bonly (?:use|call)\b/gi,
  /\b(?:if|when) the user\b/gi,
  /\bmeans call\b/gi,
  /\bnot for\b/gi,
  /\bdeprecated\b/gi,
  /\b(?:before|after) (?:calling|using)\b/gi,
];

interface Instruction {
  at: number;
  text: string;
}

function sentenceAround(text: string, at: number): string {
  const start = Math.max(0, Math.max(text.lastIndexOf('. ', at), text.lastIndexOf('\n', at)) + 1);
  const ends = [text.indexOf('. ', at), text.indexOf('\n', at)].filter((i) => i !== -1);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  return text.slice(start, end).trim().replace(/\s+/g, ' ');
}

/** Every instruction to the agent in a description, in order (several per sentence possible). */
export function instructions(text: string, otherTools: string[]): Instruction[] {
  const found = new Map<number, string>();
  for (const re of INSTRUCTION) for (const m of text.matchAll(re)) found.set(m.index ?? 0, m[0]);
  // Naming another tool alongside use/call/instead is an instruction too:
  // "call render_html first", "use get_progress_table instead", and the
  // contrast "(get_a and get_b don't answer this)".
  // The whole name only: a tool called `search` isn't named by "research".
  const nameChar = /[\w-]/;
  for (const name of otherTools) {
    let at = text.indexOf(name);
    while (at !== -1) {
      const whole = !nameChar.test(text[at - 1] ?? '') && !nameChar.test(text[at + name.length] ?? '');
      if (whole && /\b(use|call|instead|prefer|first|rather than|don'?t|doesn'?t|do not|does not|isn'?t|aren'?t|won'?t|unlike)\b/i.test(sentenceAround(text, at))) found.set(at, name);
      at = text.indexOf(name, at + name.length);
    }
  }
  return [...found].sort((a, b) => a[0] - b[0]).map(([at, t]) => ({ at, text: t }));
}

/**
 * The instructions a cut at `limit` hides, one per sentence. An instruction that
 * starts before the cut but ends after it counts too: "Use task_getProgressT…"
 * loses the tool name, which is the part that routes.
 */
export function pastTheCut(text: string, otherTools: string[], limit: number): (Instruction & { straddles: boolean })[] {
  const seen = new Set<string>();
  const out: (Instruction & { straddles: boolean })[] = [];
  for (const i of instructions(text, otherTools)) {
    if (i.at + i.text.length <= limit) continue;
    const sentence = sentenceAround(text, i.at);
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    out.push({ ...i, straddles: i.at < limit });
  }
  return out;
}

/** Tool names or globs (`*`) a client sends in full, uncut. */
export function sentInFull(tool: MenuTool, patterns: string[] | undefined): boolean {
  return (patterns ?? []).some((p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(tool.name));
}

export const buried: Rule = {
  id: 'description/buried',
  severity: 'warn',
  lesson: 'truncated description',
  summary: 'Instructions to the agent sit past the point where your client cuts descriptions',
  run(ctx) {
    const { limit, who, assumed } = resolveLimit(ctx.descriptionLimit);
    const all = ctx.menu.tools.map((t) => t.name);
    const findings: RuleFinding[] = [];
    for (const tool of ctx.menu.tools) {
      const text = tool.description ?? '';
      if (text.length <= limit || sentInFull(tool, ctx.fullDescriptions)) continue;
      const past = pastTheCut(text, all.filter((n) => n !== tool.name), limit);
      if (past.length === 0) continue;
      const one = past.length === 1;
      const first = past[0];
      findings.push({
        tool: tool.name,
        // Which sentences are instructions is read from the words: a guess.
        confidence: 'unsure',
        message: `${tool.name}: ${one ? 'a sentence that reads as an instruction to the agent sits' : `${past.length} sentences that read as instructions to the agent sit`} past character ${num(limit)}, where ${who} cuts the description, so the model never sees ${one ? 'it' : 'them'}. The description is ${num(text.length)} characters; the ${one ? '' : 'first '}instruction ${first.straddles ? `starts at ${num(first.at)} and is cut in the middle` : `is at ${num(first.at)}`}.`,
        detail: past
          .slice(0, 5)
          .map((i) => `char ${num(i.at)}${i.straddles ? ' (cut mid-instruction)' : ''}: “${clip(sentenceAround(text, i.at), 200)}”`)
          .concat(past.length > 5 ? [`…and ${past.length - 5} more`] : []),
        fix: `Move “${clip(sentenceAround(text, first.at), 70)}”${one ? '' : ' and the rest above'} into the first ${num(limit)} characters of the ${tool.name} description, or list ${tool.name} in fullDescriptions if your client sends it uncut.${unlessOtherClient(assumed)}`,
      });
    }
    return findings;
  },
};

/** A short cut to check against when the client's own cut isn't set: one real client cut at 280. */
const SHORT_CUT = 280;

/** “…the last words before ✂ the first words after…”, to find the cut in the text. */
function aroundTheCut(text: string, at: number): string {
  const before = text.slice(Math.max(0, at - 30), at).replace(/\s+/g, ' ');
  const after = text.slice(at, at + 30).replace(/\s+/g, ' ');
  return `“…${before}✂${after}…”`;
}

export const cut: Rule = {
  id: 'description/cut',
  severity: 'info',
  lesson: 'truncated description',
  summary: 'Descriptions longer than your client sends',
  run(ctx) {
    const { limit, who, assumed } = resolveLimit(ctx.descriptionLimit);
    const all = ctx.menu.tools.map((t) => t.name);
    const long = kept(ctx.menu.tools, ctx).filter((tool) => {
      const text = tool.description ?? '';
      return !sentInFull(tool, ctx.fullDescriptions) && text.length > limit && pastTheCut(text, all.filter((n) => n !== tool.name), limit).length === 0;
    });
    if (long.length === 0) return [];
    const one = long.length === 1;
    // One summary: a long description is a question for its author, not a defect.
    return [
      {
        ...(one ? { tool: long[0].name } : {}),
        message: `${one ? `The ${long[0].name} description is` : `${long.length} descriptions are`} longer than the ${num(limit)} characters ${who} sends. The model gets the start, with no sign that anything is missing, so a cut list or example can read as complete. Nothing past the cut reads as an instruction to the agent, so this is a check, not a bug.`,
        detail: long.map((t) => {
          const text = t.description ?? '';
          return `${t.name}: ${num(text.length)} characters, ${num(text.length - limit)} past the cut, which falls at ${aroundTheCut(text, limit)}`;
        }),
        fix: `Check that what's past the cut ${one ? 'in' : 'in each of'} ${one ? long[0].name : 'these'} can be lost, and move anything the agent needs into the first ${num(limit)} characters.${unlessOtherClient(assumed)}`,
      },
    ];
  },
};

export const lateInstruction: Rule = {
  id: 'description/late-instruction',
  severity: 'info',
  lesson: 'truncated description',
  summary: 'Instructions to the agent that a client cutting descriptions short would hide',
  run(ctx) {
    // Only with the default cut: once descriptionLimit is set, description/buried checks the real one.
    if (ctx.descriptionLimit !== undefined) return [];
    const { limit, who } = resolveLimit(undefined);
    if (limit <= SHORT_CUT) return [];
    const all = ctx.menu.tools.map((t) => t.name);
    const late: { tool: MenuTool; at: number; straddles: boolean; sentence: string; more: number }[] = [];
    for (const tool of kept(ctx.menu.tools, ctx)) {
      const text = tool.description ?? '';
      if (text.length <= SHORT_CUT || sentInFull(tool, ctx.fullDescriptions)) continue;
      // Past the default cut is description/buried's.
      const hidden = pastTheCut(text, all.filter((n) => n !== tool.name), SHORT_CUT).filter((i) => i.at < limit);
      if (hidden.length) late.push({ tool, at: hidden[0].at, straddles: hidden[0].straddles, sentence: sentenceAround(text, hidden[0].at), more: hidden.length - 1 });
    }
    if (late.length === 0) return [];
    const one = late.length === 1;
    const client = who;
    return [
      {
        ...(one ? { tool: late[0].tool.name } : {}),
        confidence: 'unsure',
        message: `${one ? `The ${late[0].tool.name} description gives` : `${late.length} descriptions give`} the agent instructions ${late.some((l) => l.straddles) ? 'that run past' : 'after'} character ${SHORT_CUT}, where a client that cuts descriptions short never shows them (one real client cut at ${SHORT_CUT}). ${client} sends ${num(limit)} characters, so there they arrive.`,
        // One that starts before the cut and runs past it is cut in the middle: say so, or "char 264" reads as before the cut.
        detail: late.map((l) => `${l.tool.name}: char ${num(l.at)}${l.straddles ? ` (runs past ${SHORT_CUT})` : ''}: “${clip(l.sentence, 120)}”${l.more ? ` (and ${l.more} more after it)` : ''}`),
        fix: `If your client cuts descriptions, set descriptionLimit to its cut and toolmenu checks against that. Otherwise, moving ${one ? 'the instruction' : 'each instruction'} into the first sentences is cheap insurance.`,
      },
    ];
  },
};
