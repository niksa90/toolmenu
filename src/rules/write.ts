import type { MenuTool } from '../types.js';
import { WRITE_VERBS, nouns, verbOf, words } from '../words.js';
import { count, kept, names, type Rule } from './rule.js';

const DRY_RUN_PARAMS = /^(dry[_-]?run|preview|validate[_-]?only|simulate|plan|what[_-]?if)$/i;
const PREVIEW_WORDS = new Set(['preview', 'validate', 'plan', 'simulate', 'dry']);
/** Write verbs that only add something; the others delete or overwrite. A guess from the name. */
const ADDITIVE_VERBS = new Set(['create', 'add', 'insert', 'send', 'post', 'publish', 'submit', 'upload', 'assign', 'invite', 'approve']);

function isWriteByName(tool: MenuTool): boolean {
  return WRITE_VERBS.has(verbOf(tool.name) ?? '');
}

function hasAnnotations(tool: MenuTool): boolean {
  return !!tool.annotations && Object.keys(tool.annotations).length > 0;
}

const WHY =
  'Without readOnlyHint and destructiveHint, a client has to assume the worst of every write, and neither the client nor the agent can tell a harmless create from a delete when deciding what to confirm.';

export const unannotated: Rule = {
  id: 'write/unannotated',
  severity: 'warn',
  lesson: '02',
  summary: 'Tools that look like writes carry annotations',
  run(ctx) {
    const bare = kept(ctx.menu.tools, ctx).filter((t) => isWriteByName(t) && !hasAnnotations(t));
    if (bare.length === 0) return [];
    const additive = (t: MenuTool) => ADDITIVE_VERBS.has(verbOf(t.name)!);
    // One finding, not one per tool: the same gap in 53 tools is one thing to fix.
    if (bare.length === 1) {
      const [tool] = bare;
      const adds = additive(tool);
      return [
        {
          tool: tool.name,
          confidence: 'unsure',
          message: `${tool.name} is named like a write ("${verbOf(tool.name)}") and has no annotations. ${WHY}`,
          fix: `Add annotations: { readOnlyHint: false, destructiveHint: ${!adds} } to ${tool.name} (${adds ? 'true if it can also delete or overwrite' : 'false if it only adds'}), or { readOnlyHint: true } if it changes nothing.`,
        },
      ];
    }
    const verbs = [...new Set(bare.map((t) => `${verbOf(t.name)}…`))];
    const overwrites = bare.filter((t) => !additive(t)).map((t) => t.name);
    const adds = bare.filter(additive).map((t) => t.name);
    return [
      {
        confidence: 'unsure',
        message: `${count(bare.length, 'tool')} are named like writes (${names(verbs, 6)}) and have no annotations. ${WHY}`,
        detail: [
          ...(overwrites.length ? [`Delete or overwrite, going by the name (destructiveHint: true): ${overwrites.join(', ')}`] : []),
          ...(adds.length ? [`Only add, going by the name (destructiveHint: false): ${adds.join(', ')}`] : []),
        ],
        fix: 'Add annotations to each: { readOnlyHint: false, destructiveHint: true } where it deletes or overwrites, { readOnlyHint: false, destructiveHint: false } where it only adds. The split above is a guess from the names: check each tool.',
      },
    ];
  },
};

export const noDryRun: Rule = {
  id: 'write/no-dry-run',
  severity: 'info',
  lesson: '02',
  summary: 'Destructive tools offer a way to look before leaping',
  run(ctx) {
    const missing: string[] = [];
    for (const tool of kept(ctx.menu.tools, ctx)) {
      const a = tool.annotations ?? {};
      const destructive = a.destructiveHint === true || (a.readOnlyHint === false && a.destructiveHint !== false);
      if (!destructive) continue;
      const hasParam = Object.keys(tool.inputSchema?.properties ?? {}).some((p) => DRY_RUN_PARAMS.test(p));
      const subject = new Set(nouns(tool.name));
      const hasPreviewTool = ctx.menu.tools.some(
        (other) =>
          other.name !== tool.name &&
          words(other.name).some((w) => PREVIEW_WORDS.has(w)) &&
          nouns(other.name).some((n) => subject.has(n)),
      );
      if (!hasParam && !hasPreviewTool) missing.push(tool.name);
    }
    if (missing.length === 0) return [];
    const one = missing.length === 1;
    // One finding, not one per tool: it's a design note, not a list of defects.
    return [
      {
        ...(one ? { tool: missing[0] } : {}),
        confidence: 'unsure',
        message: `${one ? `${missing[0]} is` : `${count(missing.length, 'tool')} are`} annotated as destructive, and toolmenu found no dry_run/preview-style parameter and no preview tool for the same thing. Where a mistake is costly to undo, a dry run lets the agent see what would change while it can still back out.`,
        ...(one ? {} : { detail: [missing.join(', ')] }),
        fix: `Where the effect is hard to undo, add a dry_run parameter${one ? ` to ${missing[0]}` : ''} that returns what would change without changing it. If it's cheap to undo, or a preview exists under another name, ignore this.`,
      },
    ];
  },
};
