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
}
