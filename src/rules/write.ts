import type { MenuTool } from '../types.js';
import { WRITE_VERBS, nouns, verbOf, words } from '../words.js';
import type { Rule, RuleFinding } from './rule.js';

const DRY_RUN_PARAMS = /^(dry[_-]?run|preview|validate[_-]?only|simulate|plan|what[_-]?if)$/i;
const PREVIEW_WORDS = new Set(['preview', 'validate', 'plan', 'simulate', 'dry']);

function isWriteByName(tool: MenuTool): boolean {
  return WRITE_VERBS.has(verbOf(tool.name) ?? '');
}

function hasAnnotations(tool: MenuTool): boolean {
  return !!tool.annotations && Object.keys(tool.annotations).length > 0;
}

export const unannotated: Rule = {
  id: 'write/unannotated',
  severity: 'warn',
  lesson: '02',
  summary: 'Tools that look like writes carry annotations',
  run(ctx) {
    return ctx.menu.tools
      .filter((t) => isWriteByName(t) && !hasAnnotations(t))
      .map((t): RuleFinding => ({
        tool: t.name,
        message: `${t.name}: the name suggests it changes something, but it has no annotations. Say readOnlyHint/destructiveHint so clients and agents know.`,
      }));
  },
};

export const noDryRun: Rule = {
  id: 'write/no-dry-run',
  severity: 'info',
  lesson: '02',
  summary: 'Destructive tools offer a way to look before leaping',
  run(ctx) {
    const missing: string[] = [];
    for (const tool of ctx.menu.tools) {
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
    // One finding, not one per tool: it's a design note, not a list of defects.
    return [
      {
        ...(missing.length === 1 ? { tool: missing[0] } : {}),
        message: `${missing.length === 1 ? `${missing[0]} is` : `${missing.length} tools are`} destructive with no dry_run/preview parameter and no matching preview tool. Where the effect is costly to undo, a dry run lets the agent catch its own mistake while it's cheap.`,
        ...(missing.length > 1 ? { detail: [missing.join(', ')] } : {}),
      },
    ];
  },
};
