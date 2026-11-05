/*
 * Colour for text output in a terminal: severities, the next step, the verdict. Applied
 * to the finished text, line by line, so every command's report gets it the same way
 * and the text itself never depends on it. Only when the stream is a terminal, unless
 * NO_COLOR (https://no-color.org) or FORCE_COLOR says otherwise; never for json,
 * markdown or github output.
 */

const ESC = '\x1b[';
const paint = (codes: string, text: string) => (text ? `${ESC}${codes}m${text}${ESC}0m` : text);

const SEVERITY: Record<string, string> = { ERROR: '1;31', WARN: '1;33', INFO: '1;36' };

/** Whether text written to this stream gets colour. */
export function colourFor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  return !!stream.isTTY && env.TERM !== 'dumb';
}

/** The report with ANSI colour: the same characters otherwise. */
export function colourise(text: string): string {
  // Lines deeper than the current finding's message are its evidence: dimmed.
  let evidenceFrom: number | undefined;
  return text
    .split('\n')
    .map((line) => {
      const indent = line.length - line.trimStart().length;
      const finding = /^(\s*)(ERROR|WARN|INFO)(\s+)(\S+)(.*)$/.exec(line);
      if (finding) {
        const [, lead, severity, gap, rule, rest] = finding;
        evidenceFrom = lead.length + severity.length + gap.length + 1;
        return `${lead}${paint(SEVERITY[severity], severity)}${gap}${paint('1', rule)}${rest.replace(/ · unsure\b/, paint('2;3', ' · unsure'))}`;
      }
      const next = /^(\s*)(→ Next:)(.*)$/.exec(line);
      if (next) return `${next[1]}${paint('1;32', next[2])}${paint('32', next[3])}`;
      if (!line.trim() || indent === 0) evidenceFrom = undefined;
      if (evidenceFrom !== undefined && indent >= evidenceFrom) return paint('2', line);
      if (/^✗ /.test(line)) return paint('1;31', line);
      if (/^✓ /.test(line)) return paint('1;32', line);
      const title = /^(toolmenu \w+)(.*)$/.exec(line);
      if (title) return `${paint('1;35', title[1])}${paint('1', title[2])}`;
      const step = /^((?:step \d+|final):)(.*)$/.exec(line);
      if (step) return `${paint('1', step[1])}${step[2].replace(/menu changed/g, paint('33', 'menu changed'))}`;
      return line;
    })
    .join('\n');
}

/** An error that stopped a command, with colour: what failed, the labelled evidence, the next step. */
export function colouriseError(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('toolmenu: ')) return `${paint('1;31', 'toolmenu:')}${paint('1', line.slice('toolmenu:'.length))}`;
      const next = /^(\s*)(→ Next:)(.*)$/.exec(line);
      if (next) return `${next[1]}${paint('1;32', next[2])}${paint('32', next[3])}`;
      const field = /^(\s{2})([a-z][a-z -]*?)(\s{2,})(.*)$/.exec(line);
      if (field) return `${field[1]}${paint('2', field[2])}${field[3]}${field[4]}`;
      return line;
    })
    .join('\n');
}
