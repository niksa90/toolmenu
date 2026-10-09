export type Severity = 'error' | 'warn' | 'info';

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** Tool the finding is about, when there is one. */
  tool?: string;
  /** Extra lines shown under the message. */
  detail?: string[];
  /** For `session`: the scenario step that caused it (0 = before the first step). */
  step?: number;
  /** For `session`: every step it happened at, when one finding stands for several (`step` is the first). */
  steps?: number[];
  /**
   * The next step, as one instruction the reader can act on ("Sort the values",
   * "Rerun with --processes 1"). Shown as "Next:" in every format. Omitted only when
   * there is nothing to do.
   */
  fix?: string;
  /**
   * 'unsure': a heuristic or an inference that can be wrong (a guess from names,
   * a failure whose cause isn't known). The message then says what was seen and
   * where, not what it means. Absent: toolmenu observed it directly.
   */
  confidence?: 'unsure';
  /** For `session` tool errors: the tool's whole error text, when the message shows only part of it. */
  serverText?: string;
}

/** A tool exactly as the server returned it, plus toolmenu's token estimate. */
export interface MenuTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
  tokens: number;
  [key: string]: unknown;
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  [key: string]: unknown;
}

export type Era = 'modern' | 'legacy';

export interface Menu {
  toolmenu: 1;
  server: { name?: string; version?: string; protocolVersion?: string; era?: Era };
  capturedAt: string;
  /** In server order. Order is the point. */
  tools: MenuTool[];
  totalTokens: number;
  listMeta?: { ttlMs?: number; cacheScope?: string };
  /**
   * 'session': every tool a session saw (session --union-out), in the order first
   * seen, which is the unlock order, not an order any client was served.
   */
  from?: 'session';
  /** Operations behind a search tool (snapshot --catalog). Not part of the menu or its tokens. */
  catalog?: import('./catalog.js').Catalog;
}
