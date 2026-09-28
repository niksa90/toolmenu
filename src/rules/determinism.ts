import { compareMenus, type ToolChange } from '../compare.js';
import type { Rule } from './rule.js';

const LABELS: Record<ToolChange['kind'], string> = {
  added: 'tool added',
  removed: 'tool removed',
  moved: 'order changed',
  description: 'description changed',
  inputSchema: 'inputSchema changed',
  outputSchema: 'outputSchema changed',
  annotations: 'annotations changed',
  other: 'definition changed',
};

export const nondeterministic: Rule = {
  id: 'menu/nondeterministic',
  severity: 'error',
  lesson: '05',
  summary: 'Two identical tools/list calls must return the same menu',
  run(ctx) {
    if (!ctx.secondList) return [];
    const changes = compareMenus(ctx.menu.tools, ctx.secondList);
    if (changes.length === 0) return [];
    const onlyOrder = changes.every((c) => c.kind === 'moved');
    return [
      {
        message: onlyOrder
          ? 'Two identical tools/list calls returned the tools in a different order. Every conversation can miss the prompt cache. The spec says servers SHOULD return a deterministic order.'
          : 'Two identical tools/list calls returned different menus. Every conversation can miss the prompt cache.',
        detail: changes.slice(0, 10).map((c) => `${LABELS[c.kind]}: ${c.tool} (position ${c.position})`)
          .concat(changes.length > 10 ? [`…and ${changes.length - 10} more`] : []),
      },
    ];
  },
};
