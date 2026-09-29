import type { MenuTool } from '../types.js';
import type { Rule, RuleFinding } from './rule.js';

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

/** The cut in characters, and how to name it in a message. */
export function resolveLimit(setting: number | string | undefined): { limit: number; who: string } {
  if (typeof setting === 'number') return { limit: setting, who: `your client (descriptionLimit ${setting.toLocaleString('en-US')})` };
  const client = setting ?? DEFAULT_CLIENT;
  const limit = CLIENT_LIMITS[client] ?? CLIENT_LIMITS[DEFAULT_CLIENT];
  const name = client === 'amazon-q' ? 'Amazon Q CLI' : 'Claude Code';
  return { limit, who: `${name} (${limit.toLocaleString('en-US')} characters${setting === undefined ? ', the default: set descriptionLimit for your client' : ''})` };
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
    const { limit, who } = resolveLimit(ctx.descriptionLimit);
    const names = ctx.menu.tools.map((t) => t.name);
    const findings: RuleFinding[] = [];
    for (const tool of ctx.menu.tools) {
      const text = tool.description ?? '';
      if (text.length <= limit || sentInFull(tool, ctx.fullDescriptions)) continue;
      const past = pastTheCut(text, names.filter((n) => n !== tool.name), limit);
      if (past.length === 0) continue;
      const one = past.length === 1;
      findings.push({
        tool: tool.name,
        message: `${tool.name}: the description is ${text.length.toLocaleString('en-US')} characters, and ${who} cuts it at ${limit.toLocaleString('en-US')}. ${one ? 'An instruction to the agent is' : `${past.length} instructions to the agent are`} past the cut${past[0].straddles ? `, the first cut mid-instruction (it starts at ${past[0].at.toLocaleString('en-US')})` : `, the first at ${past[0].at.toLocaleString('en-US')}`}, so the model never sees ${one ? 'it' : 'them'}. Move ${one ? 'it' : 'them'} into the first ${limit.toLocaleString('en-US')} characters, or list the tool in fullDescriptions if your client sends it uncut.`,
        detail: past
          .slice(0, 3)
          .map((i) => {
            const sentence = sentenceAround(text, i.at);
            return `char ${i.at.toLocaleString('en-US')}${i.straddles ? ' (cut mid-instruction)' : ''}: “${sentence.length > 200 ? sentence.slice(0, 197) + '…' : sentence}”`;
          })
          .concat(past.length > 3 ? [`…and ${past.length - 3} more`] : []),
      });
    }
    return findings;
  },
};

/** A short cut to check against when the client's own cut isn't set: one real client cut at 280. */
const SHORT_CUT = 280;

export const cut: Rule = {
  id: 'description/cut',
  severity: 'info',
  lesson: 'truncated description',
  summary: 'Descriptions longer than your client sends, and instructions a shorter cut would hide',
  run(ctx) {
    const { limit, who } = resolveLimit(ctx.descriptionLimit);
    const names = ctx.menu.tools.map((t) => t.name);
    const others = (tool: MenuTool) => names.filter((n) => n !== tool.name);
    const tools = ctx.menu.tools.filter((t) => !sentInFull(t, ctx.fullDescriptions));
    const findings: RuleFinding[] = [];
    const long = tools.filter((tool) => {
      const text = tool.description ?? '';
      return text.length > limit && pastTheCut(text, others(tool), limit).length === 0;
    });
    if (long.length) {
      findings.push({
        message: `${long.length === 1 ? '1 description is' : `${long.length} descriptions are`} longer than ${who} sends, so the model gets a prefix that can read as complete: ${list(long, (t) => `${t.name} (${(t.description ?? '').length.toLocaleString('en-US')})`)}. Nothing past the cut reads as an instruction, but check what's there.`,
      });
    }
    // With the default cut, say what a shorter client cut would hide.
    if (ctx.descriptionLimit === undefined && limit > SHORT_CUT) {
      const hidden = tools.filter((tool) => {
        const text = tool.description ?? '';
        return text.length > SHORT_CUT && pastTheCut(text, others(tool), SHORT_CUT).some((i) => i.at < limit);
      });
      if (hidden.length) {
        findings.push({
          message: `${hidden.length === 1 ? '1 description gives' : `${hidden.length} descriptions give`} the agent instructions after character ${SHORT_CUT}: ${list(hidden, (t) => t.name)}. ${who.split(' (')[0]} sends ${limit.toLocaleString('en-US')} characters, so they arrive there, but a client that cuts shorter never shows them (one real client cut at ${SHORT_CUT}). If yours cuts descriptions, set descriptionLimit to its cut.`,
        });
      }
    }
    return findings;
  },
};

function list(tools: MenuTool[], show: (t: MenuTool) => string): string {
  return tools.slice(0, 5).map(show).join(', ') + (tools.length > 5 ? `, and ${tools.length - 5} more` : '');
}
