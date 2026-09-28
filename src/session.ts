import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { cacheBreak, compareMenus, type ToolChange } from './compare.js';
import { connect, listTools, type Connection, type Target } from './connect.js';
import { buildMenu } from './menu.js';
import { isContainerWrapper, MAIN_SEED, probeMenu, probeVariance, seeded } from './probe.js';
import { varianceFinding } from './rules/determinism.js';
import { classifyFailure, FAILURE_LABELS, SETUP_FAILURES, type FailureClass } from './failures.js';
import type { Era, Finding, Menu, MenuTool, Severity } from './types.js';
import { SEVERITY_RANK } from './types.js';
import { verbOf, WRITE_VERBS } from './words.js';

export type Step =
  | { kind: 'list' }
  | { kind: 'call'; tool: string; args: Record<string, unknown> }
  | { kind: 'wait_for'; event: 'tools_list_changed'; timeoutMs: number };

export interface Scenario {
  allowWrites: boolean;
  steps: Step[];
}

const LIST_CHANGED = 'notifications/tools/list_changed';

/** Read and check a scenario file. Mistakes are reported before anything runs. */
export async function loadScenario(path: string): Promise<Scenario> {
  let data: unknown;
  try {
    data = parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseScenario(data, path);
}

export function parseScenario(data: unknown, where = 'scenario'): Scenario {
  const doc = data as { allow_writes?: unknown; steps?: unknown };
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.steps) || doc.steps.length === 0) {
    throw new Error(`${where}: expected "steps:" with at least one step`);
  }
  if (doc.allow_writes !== undefined && typeof doc.allow_writes !== 'boolean') {
    throw new Error(`${where}: allow_writes must be true or false`);
  }
  const steps = doc.steps.map((raw, i): Step => {
    const at = `${where}: step ${i + 1}`;
    if (raw === 'list' || (raw && typeof raw === 'object' && 'list' in raw)) return { kind: 'list' };
    if (raw && typeof raw === 'object' && 'call' in raw) {
      const r = raw as { call: unknown; args?: unknown };
      if (typeof r.call !== 'string' || !r.call) throw new Error(`${at}: "call" needs a tool name`);
      if (r.args !== undefined && (typeof r.args !== 'object' || r.args === null || Array.isArray(r.args))) {
        throw new Error(`${at}: "args" must be a map`);
      }
      return { kind: 'call', tool: r.call, args: (r.args as Record<string, unknown>) ?? {} };
    }
    if (raw && typeof raw === 'object' && 'wait_for' in raw) {
      const r = raw as { wait_for: unknown; timeout_ms?: unknown };
      if (r.wait_for !== 'tools_list_changed') throw new Error(`${at}: wait_for supports "tools_list_changed"`);
      if (r.timeout_ms !== undefined && (typeof r.timeout_ms !== 'number' || r.timeout_ms <= 0)) {
        throw new Error(`${at}: timeout_ms must be a positive number`);
      }
      return { kind: 'wait_for', event: 'tools_list_changed', timeoutMs: (r.timeout_ms as number) ?? 5000 };
    }
    throw new Error(`${at}: expected "list", "call: <tool>" or "wait_for: tools_list_changed"`);
  });
  return { allowWrites: doc.allow_writes === true, steps };
}

export function stepLabel(step: Step): string {
  if (step.kind === 'list') return 'list';
  if (step.kind === 'call') return `call ${step.tool}${Object.keys(step.args).length ? ' ' + JSON.stringify(step.args) : ''}`;
  return `wait_for ${step.event}`;
}

export type Scope = 'global' | 'connection-local' | 'per-process' | 'unclear';

export interface StepRecord {
  index: number;
  label: string;
  status: 'ok' | 'refused' | 'failed' | 'timed-out';
  /** Why no call was made, when none was: set where the status is set, never parsed from text. */
  reason?: 'missing' | 'refused';
  note?: string;
  /** Why the call failed, when it did (a tool error or a failed request). */
  failure?: FailureClass;
  changed: boolean;
  listChanged: number;
  scope?: Scope;
  tools: number;
  tokens: number;
}

export interface SessionResult {
  scenario: string;
  server: Menu['server'];
  transport: Target['kind'];
  listening: boolean;
  baseline: { tools: number; tokens: number };
  final: { tools: number; tokens: number };
  /** Undefined when not checked (processes: 1). */
  connectionCheck?: 'same' | 'different';
  steps: StepRecord[];
  findings: Finding[];
}

export interface SessionOptions {
  timeoutMs?: number;
  /** How long to wait for a list_changed notification after a change. */
  noticeGraceMs?: number;
  rules?: Record<string, Severity | 'off'>;
  ignore?: string[];
  scenarioName?: string;
  /** Server processes (stdio) or connections (HTTP) to compare before the first step, the main one included (default 2). */
  processes?: number;
}

type Raw = Omit<Finding, 'severity'> & { severity: Severity };

/** Observe the menu while a scripted session runs. No LLM: the scenario is the agent. */
export async function session(target: Target, scenario: Scenario, options: SessionOptions = {}): Promise<SessionResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const grace = options.noticeGraceMs ?? 500;
  const raw: Raw[] = [];
  // The main process runs with a pinned hash seed, and so does every scope probe:
  // a probe with a different seed would count ordering variance as a change.
  const mainTarget = seeded(target, MAIN_SEED);
  const conn = await connect(mainTarget, { timeoutMs });
  try {
    const era = conn.era;
    const modern = era === 'modern';
    const declared = (conn.capabilities.tools as { listChanged?: boolean } | undefined)?.listChanged === true;
    let listening = !modern; // 2025-era notifications arrive on the session itself
    if (modern && declared) {
      try {
        await conn.client.listen({ toolsListChanged: true });
        listening = true;
      } catch {
        listening = false;
      }
    }

    const menuOf = async (c: Connection) => buildMenu((await listTools(c, { timeoutMs })).tools, serverOf(c));
    let current = await menuOf(conn);
    const baseline = current;

    // Fresh processes or connections, same credentials, must see the same menu.
    let connectionCheck: SessionResult['connectionCheck'];
    for (const probe of await probeVariance(target, current.tools, options.processes ?? 2, timeoutMs)) {
      if (probe.error) {
        raw.push({ rule: target.kind === 'stdio' ? 'menu/process-variance' : 'menu/connection-variance', severity: 'info', step: 0, message: `Couldn't ${target.kind === 'stdio' ? 'start a second server process' : 'open a second connection'} to compare menus, so this wasn't checked: ${probe.error.split('\n')[0]}` });
        continue;
      }
      const f = varianceFinding(current.tools, probe.tools ?? [], { transport: target.kind, modern, wrapper: isContainerWrapper(target) });
      connectionCheck = f ? 'different' : connectionCheck ?? 'same';
      if (f) {
        raw.push({ ...f, step: 0 });
        break;
      }
    }

    const steps: StepRecord[] = [];
    for (const [i, step] of scenario.steps.entries()) {
      const index = i + 1;
      const label = stepLabel(step);
      const record: StepRecord = { index, label, status: 'ok', changed: false, listChanged: 0, tools: current.tools.length, tokens: current.totalTokens };
      const mark = conn.wire.notifications.length;

      if (step.kind === 'call') {
        const tool = current.tools.find((t) => t.name === step.tool);
        if (!tool) {
          record.status = 'failed';
          record.reason = 'missing';
          record.note = `${step.tool} isn't in the menu at this point`;
          raw.push({ rule: 'session/step-failed', severity: 'error', step: index, message: `Step ${index} calls ${step.tool}, which isn't in the menu at this point.` });
        } else if (!scenario.allowWrites && tool.annotations?.readOnlyHint !== true) {
          record.status = 'refused';
          record.reason = 'refused';
          record.note = 'not marked readOnlyHint';
          raw.push({
            rule: 'session/refused',
            severity: 'error',
            step: index,
            tool: step.tool,
            message: `Refused to call ${step.tool}: it isn't marked readOnlyHint, and session calls tools for real. Set "allow_writes: true" in the scenario if that's intended.`,
          });
        }
        if (record.status === 'ok') try {
          const result = await conn.client.callTool({ name: step.tool, arguments: step.args }, { timeout: timeoutMs });
          if (result.isError) {
            const text = (Array.isArray(result.content) ? result.content : [])
              .map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : ''))
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
            const short = clip(text, 120);
            record.note = text ? `the tool returned an error: ${short}` : 'the tool returned an error';
            record.failure = classifyFailure(text, { hadArguments: Object.keys(step.args).length > 0 });
            // A setup failure is reported once, for the whole run (session/untested).
            if (!SETUP_FAILURES.has(record.failure)) raw.push({
              rule: 'session/tool-error',
              severity: 'warn',
              step: index,
              tool: step.tool,
              message: `Step ${index} (${label}) returned an error${text ? ` (“${short}”)` : ''}. A step that fails tests less than it looks, so a clean run can hide a broken setup: check credentials and arguments.`,
            });
          }
        } catch (error) {
          record.status = 'failed';
          record.note = error instanceof Error ? error.message.split('\n')[0] : String(error);
          const code = (error as { code?: unknown }).code;
          record.failure = classifyFailure(record.note, { code: typeof code === 'number' ? code : undefined, hadArguments: Object.keys(step.args).length > 0 });
          if (!SETUP_FAILURES.has(record.failure)) raw.push({ rule: 'session/step-failed', severity: 'error', step: index, tool: step.tool, message: `Step ${index} (${label}) failed: ${record.note}` });
        }
      } else if (step.kind === 'wait_for') {
        const arrived = await waitFor(() => conn.wire.notificationsSince(mark, LIST_CHANGED) > 0, step.timeoutMs);
        if (!arrived) {
          record.status = 'timed-out';
          record.note = `no list_changed within ${step.timeoutMs} ms`;
        }
      }

      // List even after a failed step: a call that errored or timed out may still
      // have changed the menu, and the change belongs to this step, not the next.
      let next: Menu;
      try {
        next = await menuOf(conn);
      } catch (error) {
        const why = error instanceof Error ? error.message.split('\n')[0] : String(error);
        record.status = 'failed';
        record.note = record.note ? `${record.note}; then listing the menu failed: ${why}` : `listing the menu failed: ${why}`;
        raw.push({ rule: 'session/step-failed', severity: 'error', step: index, message: `After step ${index} (${label}), listing the menu failed: ${why}` });
        steps.push(record);
        continue;
      }
      const changes = compareMenus(current.tools, next.tools);
      if (changes.length) {
        record.changed = true;
        if (conn.wire.notificationsSince(mark, LIST_CHANGED) === 0) {
          await waitFor(() => conn.wire.notificationsSince(mark, LIST_CHANGED) > 0, grace);
        }
        const origin =
          step.kind === 'list'
            ? 'no tool call in between'
            : record.reason === 'missing'
              ? 'no tool call made (the tool wasn\'t in the menu)'
              : record.reason === 'refused'
                ? 'no tool call made (refused)'
                : record.status === 'failed'
                  ? 'the call failed, but the menu changed: the server may have applied it anyway'
                  : undefined;
        raw.push(...changeFindings(current.tools, next.tools, changes, index, origin));

        if (declared && listening && conn.wire.notificationsSince(mark, LIST_CHANGED) === 0) {
          raw.push({
            rule: 'session/unannounced',
            severity: 'warn',
            step: index,
            message: `The menu changed without a notifications/tools/list_changed, although the server declared listChanged. Clients that cache the list won't know to re-fetch it. The spec says servers SHOULD send it.`,
          });
        }

        if (step.kind !== 'list') {
          const probe = await probeMenu(mainTarget, timeoutMs);
          record.scope = scopeOf(changes, next.tools, probe.tools, target.kind);
          raw.push(...scopeFindings(record.scope, modern, index));
        }
        current = next;
      }
      record.listChanged = conn.wire.notificationsSince(mark, LIST_CHANGED);
      record.tools = current.tools.length;
      record.tokens = current.totalTokens;
      steps.push(record);
    }

    raw.push(...untested(steps, target));

    return {
      scenario: options.scenarioName ?? 'scenario',
      server: baseline.server,
      transport: target.kind,
      listening,
      baseline: { tools: baseline.tools.length, tokens: baseline.totalTokens },
      final: { tools: current.tools.length, tokens: current.totalTokens },
      connectionCheck,
      steps,
      findings: settle(mergeSideEffects(raw), options),
    };
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Calls that failed before reaching the tool's logic (credentials, this machine,
 * the network) tested nothing but whether a failed call changes the menu. Said
 * once. An error when no call got through at all: otherwise an expired CI secret
 * turns the job green while testing nothing.
 */
function untested(steps: StepRecord[], target: Target): Raw[] {
  const calls = steps.filter((s) => s.label.startsWith('call ') && s.reason === undefined);
  const setup = calls.filter((s) => s.failure && SETUP_FAILURES.has(s.failure));
  if (setup.length === 0) return [];
  const byClass = new Map<FailureClass, StepRecord[]>();
  for (const s of setup) byClass.set(s.failure!, [...(byClass.get(s.failure!) ?? []), s]);
  const all = setup.length === calls.length;
  const how = target.kind === 'http' ? 'real credentials (--header "Authorization: …")' : 'real credentials (--env KEY=…)';
  return [
    {
      rule: 'session/untested',
      severity: all ? 'error' : 'warn',
      message: `${all ? `All ${calls.length}` : `${setup.length} of ${calls.length}`} tool calls failed before reaching the tool: ${[...byClass].map(([c, list]) => `${list.length} on ${FAILURE_LABELS[c]}`).join(', ')}. Those steps only tested whether a failed call changes the menu.${byClass.has('auth') || byClass.has('not-found') ? ` Run with ${how}.` : ''}`,
      detail: [...byClass].map(([c, list]) => `${c}: steps ${list.map((s) => s.index).join(', ')} (“${(list[0].note ?? '').replace(/^the tool returned an error: /, '').slice(0, 100)}”)`),
    },
  ];
}

function serverOf(c: Connection): Menu['server'] {
  return { name: c.server.name, version: c.server.version, protocolVersion: c.protocolVersion, era: c.era };
}

function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (done()) return resolve(true);
    const start = Date.now();
    const timer = setInterval(() => {
      if (done()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start >= ms) {
        clearInterval(timer);
        resolve(false);
      }
    }, 20);
  });
}

const EDIT_KINDS = new Set<ToolChange['kind']>(['description', 'inputSchema', 'outputSchema', 'annotations', 'other', 'serialization']);

/** Turn a menu change into findings, with the cost of each. */
export function changeFindings(before: MenuTool[], after: MenuTool[], changes: ToolChange[], step: number, origin?: string): Raw[] {
  const out: Raw[] = [];
  const brk = cacheBreak(before, after);
  // Claude's docs: adding, removing or reordering a tool invalidates the entire
  // cache (SPEC §20), not just what follows the change. So the cost is the whole
  // tool list and everything after it; toolmenu can measure this server's part.
  const total = after.reduce((sum, t) => sum + t.tokens, 0);
  const cost = !brk
    ? []
    : [
        `the change starts at position ${brk.position}${brk.position >= after.length ? ' (tools removed from the end)' : ''}; any change to the tool list invalidates the cached prompt, so the whole tool list (this server's part: ~${total.toLocaleString('en-US')} tokens, estimate) and the conversation after it are processed again`,
      ];
  const why = origin ? [origin] : [];

  const added = changes.filter((c) => c.kind === 'added');
  const others = changes.filter((c) => c.kind !== 'added');
  const lastKept = Math.max(-1, ...after.map((t, i) => (added.some((a) => a.tool === t.name) ? -1 : i)));
  const appended = added.length > 0 && added.every((a) => a.position > lastKept);

  if (added.length) {
    const names = added.map((a) => a.tool);
    if (appended) {
      const tokens = after.filter((t) => names.includes(t.name)).reduce((s, t) => s + t.tokens, 0);
      out.push({
        rule: 'session/append',
        severity: 'warn',
        step,
        message: `+${names.length} tool${names.length === 1 ? '' : 's'} appended at the end of the list (${names.join(', ')}). The end of the tool list isn't the end of the prompt: most clients send tools first (Claude's Messages API does), so any change to them, an append too, invalidates the cached conversation after them. Appends are cache-safe only if your client adds new tools after the cached content, as tool search (deferred loading) does.`,
        detail: [`~${tokens.toLocaleString('en-US')} new tokens (estimate)`, ...why],
      });
    } else {
      const first = Math.min(...added.map((a) => a.position));
      out.push({
        rule: 'session/mid-insert',
        severity: 'error',
        step,
        message: `+${names.length} tool${names.length === 1 ? '' : 's'} inserted at position ${first} (${names.join(', ')}). Invalidates the cached prompt: the tool list and the conversation after it are processed again.`,
        detail: [...cost, ...why],
      });
    }
  }
  const moved = changes.filter((c) => c.kind === 'moved');
  if (moved.length) {
    out.push({ rule: 'session/reorder', severity: 'error', step, message: `Tool order changed mid-session (${moved.map((m) => m.tool).join(', ')}).`, detail: [...cost, ...why] });
  }
  const removed = changes.filter((c) => c.kind === 'removed');
  if (removed.length) {
    out.push({ rule: 'session/remove', severity: 'error', step, message: `${removed.map((r) => r.tool).join(', ')} disappeared from the menu mid-session.`, detail: [...cost, ...why] });
  }
  const edits = new Map<string, string[]>();
  for (const c of changes.filter((c) => EDIT_KINDS.has(c.kind))) edits.set(c.tool, [...(edits.get(c.tool) ?? []), c.kind === 'other' ? 'definition' : c.kind === 'serialization' ? 'key order (same content, different bytes)' : c.kind]);
  for (const [tool, fields] of edits) {
    out.push({ rule: 'session/edit', severity: 'error', step, tool, message: `${tool}: ${fields.join(', ')} changed mid-session.`, detail: [...cost, ...why] });
  }
  return out;
}

/**
 * Does a fresh connection see this step's changes? All of them: the server's tool
 * set changed. None: the change belongs to this connection (or, on stdio, this
 * process). Reorders alone can't tell, and a mix is unclear.
 */
export function scopeOf(changes: ToolChange[], next: MenuTool[], probe: MenuTool[], transport: Target['kind']): Scope {
  const probeByName = new Map(probe.map((t) => [t.name, t]));
  const nextByName = new Map(next.map((t) => [t.name, t]));
  const verdicts = new Set<boolean>();
  for (const c of changes) {
    if (c.kind === 'moved') continue;
    if (c.kind === 'added') verdicts.add(probeByName.has(c.tool));
    else if (c.kind === 'removed') verdicts.add(!probeByName.has(c.tool));
    else {
      const seen = probeByName.get(c.tool);
      verdicts.add(!!seen && compareMenus([seen], [nextByName.get(c.tool)!]).length === 0);
    }
  }
  if (verdicts.size !== 1) return 'unclear';
  if (verdicts.has(true)) return 'global';
  return transport === 'http' ? 'connection-local' : 'per-process';
}

function scopeFindings(scope: Scope, modern: boolean, step: number): Raw[] {
  if (scope === 'connection-local') {
    return [
      {
        rule: 'session/connection-local',
        severity: modern ? 'error' : 'info',
        step,
        message: modern
          ? `The change is local to this connection: a fresh connection with the same credentials still sees the old menu. On 2026-07-28 the tool set MUST NOT vary per-connection or as a side effect of other requests on the connection.`
          : `The change is local to this connection: a fresh connection still sees the old menu. Allowed before 2026-07-28; ruled out from 2026-07-28 on.`,
      },
    ];
  }
  if (scope === 'per-process' && modern) {
    return [
      {
        rule: 'session/side-effect',
        severity: 'warn',
        step,
        message: `A freshly started server doesn't show this change. On stdio every connection is its own process, so toolmenu can't tell a per-connection change from a global one. On 2026-07-28 the tool set MUST NOT change as a side effect of requests on the connection.`,
      },
    ];
  }
  return [];
}

/** stdio's side-effect warning is the same for every step: say it once, name the steps. */
function mergeSideEffects(raw: Raw[]): Raw[] {
  const side = raw.filter((f) => f.rule === 'session/side-effect');
  if (side.length < 2) return raw;
  const steps = side.map((f) => f.step);
  return raw
    .filter((f) => f.rule !== 'session/side-effect' || f === side[0])
    .map((f) => (f === side[0] ? { ...f, message: `Steps ${steps.join(', ')}: ${f.message}` } : f));
}

function describe(changes: ToolChange[]): string[] {
  return changes.slice(0, 8).map((c) => `${c.kind}: ${c.tool} (position ${c.position})`).concat(changes.length > 8 ? [`…and ${changes.length - 8} more`] : []);
}

function settle(raw: Raw[], options: SessionOptions): Finding[] {
  const ignore = (options.ignore ?? []).map((g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
  return raw
    .filter((f) => options.rules?.[f.rule] !== 'off' && !(f.tool && ignore.some((re) => re.test(f.tool!))))
    .map((f) => ({ ...f, severity: (options.rules?.[f.rule] as Severity | undefined) ?? f.severity }))
    .sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

export type { Era };

/*
 * Tools that unlock more tools. A parameter that names what to unlock
 * (`domains`, `toolset`…) is the strongest sign; "unlock"/"capabilities" in
 * the name or description, and a description that talks about loading tools,
 * back it up. Words like "scope" or "mode" alone say nothing: `get_my_scope_ids`
 * changes no menu.
 */
// A parameter that names what to unlock. Strong names say so alone; weak ones
// (`category` is also a search filter: GitHub, Firecrawl) need the tool's name or
// description to back them up.
const UNLOCK_PARAM = /^(?:domains?|toolsets?|tool_?sets?|capabilit(?:y|ies)|packs?|bundles?|namespaces?)$/i;
const WEAK_UNLOCK_PARAM = /^(?:categor(?:y|ies)|modules?|features?|groups?)$/i;
const UNLOCK_NAME = /unlock|enable|activate|capabilit|toolset|load_?tools|expand/i;
const UNLOCK_DESC = /(?:unlock|enable|activate|load|expose|add)s?[^.]{0,60}tools?|more tools|toolsets?|capabilit(?:y|ies)|unlock/i;

interface Unlocker {
  tool: MenuTool;
  score: number;
  /** The parameter that names what to unlock, if there is one. */
  param?: string;
  /** Values to try for it, from the schema's enum. */
  values: unknown[];
}

/**
 * At most `max` characters, cut by code point at a word boundary, never inside a
 * character. Drops U+FFFD left over from a server that cut its own message by bytes.
 */
export function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\uFFFD+$/u, ''));
  if (chars.length <= max) return chars.join('');
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, '') + '…';
}

function isWriteLike(t: MenuTool): boolean {
  if (t.annotations?.destructiveHint === true) return true;
  const verb = verbOf(t.name);
  return verb !== undefined && WRITE_VERBS.has(verb) && !UNLOCK_NAME.test(t.name);
}

function enumOf(schema: MenuTool['inputSchema']): unknown[] {
  if (!schema) return [];
  if (schema.enum?.length) return schema.enum;
  if (schema.items?.enum?.length) return schema.items.enum;
  return [];
}

export function unlockers(tools: MenuTool[]): Unlocker[] {
  const found: Unlocker[] = [];
  for (const tool of tools) {
    const props = tool.inputSchema?.properties ?? {};
    const backed = UNLOCK_NAME.test(tool.name) || UNLOCK_DESC.test(tool.description ?? '');
    const param = Object.keys(props).find((p) => UNLOCK_PARAM.test(p)) ?? (backed ? Object.keys(props).find((p) => WEAK_UNLOCK_PARAM.test(p)) : undefined);
    let score = 0;
    if (param) score += enumOf(props[param]).length ? 3 : 2;
    if (UNLOCK_NAME.test(tool.name)) score += 2;
    if (UNLOCK_DESC.test(tool.description ?? '')) score += 1;
    if (score >= 2) found.push({ tool, score, param, values: param ? enumOf(props[param]) : [] });
  }
  return found.sort((a, b) => b.score - a.score);
}

/** A YAML value for an unlock parameter: an array if the schema takes one. */
function unlockValue(u: Unlocker, value: unknown): string {
  const schema = u.tool.inputSchema?.properties?.[u.param!];
  return schema?.type === 'array' || schema?.items ? `[${JSON.stringify(value)}]` : JSON.stringify(value);
}

export function starterScenario(menu: Menu): string {
  const readOnly = menu.tools.filter((t) => t.annotations?.readOnlyHint === true);
  const required = (t: MenuTool) => t.inputSchema?.required ?? [];
  const found = unlockers(menu.tools.filter((t) => t.annotations?.readOnlyHint === true || !isWriteLike(t)));
  const unlocking = new Set(found.filter((u) => u.param).map((u) => u.tool));
  const ready = readOnly.filter((t) => required(t).length === 0 && !unlocking.has(t)).slice(0, 12);
  const needsArgs = readOnly.filter((t) => required(t).length > 0);
  // The best candidate with a real value runs for real: two unlocks, then a repeat.
  const live = found.find((u) => u.values.length > 0 && u.tool.annotations?.readOnlyHint === true && required(u.tool).every((p) => p === u.param));
  const changers = found.filter((u) => u !== live).map((u) => u.tool);
  const example = (t: MenuTool, p: string) => {
    const schema = t.inputSchema?.properties?.[p];
    const u = found.find((x) => x.tool === t && x.param === p);
    if (u?.values.length) return unlockValue(u, u.values[0]);
    if (schema?.enum?.length) return JSON.stringify(schema.enum[0]);
    if (schema?.type === 'boolean') return 'false';
    if (schema?.type === 'integer' || schema?.type === 'number') return '1';
    return 'TODO';
  };
  const argNames = (t: MenuTool) => {
    const u = found.find((x) => x.tool === t);
    return u?.param && !required(t).includes(u.param) ? [...required(t), u.param] : required(t);
  };
  const placeholder = (t: MenuTool) => `{ ${argNames(t).map((p) => `${p}: ${example(t, p)}`).join(', ')} }`;
  const lines = [
    `# toolmenu session scenario for ${menu.server.name ?? 'the server'} ${menu.server.version ?? ''}`.trimEnd(),
    `# Written by \`toolmenu session --init\`. Every step lists the menu afterwards; toolmenu`,
    `# reports any change, where in the list it happened, and what it may cost the cache.`,
    '#',
    '# Only tools marked readOnlyHint are called. Replace each TODO with a real value',
    '# and uncomment the steps that matter, above all anything that unlocks tools.',
    'allow_writes: false',
    'steps:',
    '  - list',
  ];
  for (const t of ready) lines.push(`  - call: ${t.name}`);
  if (live) {
    const [first, second] = live.values;
    lines.push('', `  # ${live.tool.name} looks like it unlocks tools. Unlock, list, and unlock again:`);
    for (const v of second === undefined ? [first] : [first, second]) {
      lines.push(`  - call: ${live.tool.name}`, `    args: { ${live.param}: ${unlockValue(live, v)} }`, '  - list');
    }
    lines.push('  # The same unlock twice should change nothing.', `  - call: ${live.tool.name}`, `    args: { ${live.param}: ${unlockValue(live, first)} }`, '  - list');
  }
  if (changers.length) {
    lines.push('', `  # ${live ? 'These also' : 'These'} look like they could change the menu. Try them:`);
    for (const t of changers.slice(0, 8)) {
      if (t.annotations?.readOnlyHint !== true) lines.push(`  # (not marked readOnlyHint: needs allow_writes: true)`);
      lines.push(`  # - call: ${t.name}`);
      if (argNames(t).length) lines.push(`  #   args: ${placeholder(t)}`);
      lines.push('  # - list');
    }
  }
  const rest = needsArgs.filter((t) => !changers.includes(t) && t !== live?.tool).slice(0, 10);
  if (rest.length) {
    lines.push('', '  # Read-only tools that need arguments:');
    for (const t of rest) lines.push(`  # - call: ${t.name}`, `  #   args: ${placeholder(t)}`);
  }
  // The unlock block already ends with a list.
  if (!live) lines.push('', '  - list');
  if (ready[0]) lines.push(`  # Repeat a call: the menu shouldn't change the second time either.`, `  - call: ${ready[0].name}`, '  - list');
  if (readOnly.length === 0) {
    lines.push('', '# No tool is marked readOnlyHint, so nothing can be called without allow_writes: true.');
  }
  return lines.join('\n') + '\n';
}
