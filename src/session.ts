import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { cacheBreak, canonical, compareMenus, type ToolChange } from './compare.js';
import { listTools, type Connection, type Target } from './connect.js';
import { buildMenu, toolDefinition } from './menu.js';
import { connectPatiently, isContainerWrapper, MAIN_SEED, probeMenu, probeVariance, seeded } from './probe.js';
import { varianceFinding } from './rules/determinism.js';
import { classifyFailure, FAILURE_LABELS, httpStatus, patiently, RATE_LIMIT_ADVICE, RATE_LIMIT_WAITS_MS, quotedSentence, RATE_LIMITED, serverWords, SETUP_FAILURES, tooMany, waitedFor, whyNot, type FailureClass } from './failures.js';
import type { Era, Finding, Menu, MenuTool, Severity } from './types.js';
import { SEVERITY_RANK } from './types.js';
import { leadingJson } from './catalog.js';
import { LOOKUP_VERBS, singular, VERBS, verbOf, words, WRITE_VERBS } from './words.js';

export type Step =
  | { kind: 'list' }
  | { kind: 'call'; tool: string; args: Record<string, unknown> }
  | { kind: 'wait_for'; event: 'tools_list_changed'; timeoutMs: number };

export interface Scenario {
  allowWrites: boolean;
  steps: Step[];
}

const LIST_CHANGED = 'notifications/tools/list_changed';
/** A server saying the session is gone: "Session not found or expired" (toolception). */
const SESSION_LOST = /session (?:not found|(?:has )?expired|is no longer valid)|(?:unknown|invalid|no valid) session/i;

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
  /**
   * Every tool the session saw, in the order first seen, each as last seen: the
   * menu to diff between releases when tools only appear after an unlock.
   */
  union: Menu;
  /** With --auto: which tools were called, and which weren't and why. */
  auto?: { called: string[]; skipped: import('./auto.js').AutoPlan['skipped'] };
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
  /** The union menu is kept as a baseline (--union-out): an unlock never called then leaves tools out of it. */
  unionOut?: boolean;
  /** session --auto: what the plan called and skipped, so a run that called nothing isn't a clean one. */
  auto?: { called: string[]; skipped: import('./auto.js').AutoPlan['skipped'] };
  /** Waits before retrying a request refused for being too many (default 2, 4, 8, 16, 32 s: a per-minute limit clears within them). */
  rateLimitWaitsMs?: number[];
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
  const waits = options.rateLimitWaitsMs ?? RATE_LIMIT_WAITS_MS;
  // Connecting and listing are read-only: a refusal for being too many is waited
  // out and they're sent again.
  const conn = await connectPatiently(mainTarget, { timeoutMs, waits });
  try {
    const era = conn.era;
    const modern = era === 'modern';
    const declared = (conn.capabilities.tools as { listChanged?: boolean } | undefined)?.listChanged === true;
    let listening = !modern; // 2025-era notifications arrive on the session itself
    if (modern && declared) {
      try {
        await patiently(() => conn.client.listen({ toolsListChanged: true }), { waits, error: tooMany });
        listening = true;
      } catch {
        listening = false;
      }
    }

    const menuOf = async (c: Connection) => buildMenu((await listTools(c, { timeoutMs })).tools, serverOf(c));
    const listPatiently = (waited = { ms: 0 }) => patiently(() => menuOf(conn), { waits, error: tooMany, waited });
    // A refusal that outlasts the waits, or a write's that isn't sent again, ends
    // the run with one finding, not one per step. `tool`: the write not sent again.
    let limitedAt: number | undefined;
    const limited = (index: number, why: string, waitedMs: number, tool?: string): void => {
      limitedAt = index;
      const said = serverWords(why);
      const last = scenario.steps.length;
      const unchecked = index < last ? `Steps ${index}–${last} weren't checked.` : `Step ${index} wasn't checked.`;
      raw.push({
        rule: 'session/rate-limited',
        severity: 'error',
        step: index,
        message: tool
          ? `Rate-limited at step ${index}: ${tool} said ${quotedSentence(said)} Not called again: it isn't marked readOnlyHint, so it may have done part of the work. ${unchecked} If the limit is the server's, give the run its own server instance or raise the limit; if it's an upstream API's, run later or with a higher quota.`
          : `Rate-limited at step ${index}, and still after waiting ${waitedFor(waitedMs)}: ${quotedSentence(said)} ${unchecked} ${RATE_LIMIT_ADVICE}`,
      });
    };
    let current = await listPatiently();
    // Map keeps first-insertion order; set() on a known name updates it in place.
    const seen = new Map<string, MenuTool>();
    const see = (menu: Menu) => menu.tools.forEach((t) => seen.set(t.name, t));
    see(current);
    const baseline = current;

    // Fresh processes or connections, same credentials, must see the same menu.
    let connectionCheck: SessionResult['connectionCheck'];
    for (const probe of await probeVariance(target, current.tools, options.processes ?? 2, timeoutMs, waits)) {
      if (probe.error) {
        raw.push({ rule: target.kind === 'stdio' ? 'menu/process-variance' : 'menu/connection-variance', severity: 'info', step: 0, message: `Couldn't ${target.kind === 'stdio' ? 'start a second server process' : 'open a second connection'} to compare menus, so this wasn't checked: ${serverWords(probe.error, 200)}` });
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
    const scopeUnchecked: { step: number; why: string }[] = [];
    // processes: 1 turns off every second process or connection, the scope probe too.
    const probes = (options.processes ?? 2) > 1;
    // The step after which toolmenu last opened a second process or connection (0:
    // before the first step). A server that keeps one session per client can end
    // this one when that happens.
    let probedAfter: number | undefined = probes ? 0 : undefined;
    const lost = (why: string, index: number): boolean => {
      if (probedAfter === undefined || !SESSION_LOST.test(why)) return false;
      // The server's own words, not the transport's wrapping of its JSON-RPC error.
      const said = serverWords(why);
      raw.push({
        rule: 'session/session-lost',
        severity: 'error',
        step: index,
        message: `The server ended this session (“${said}”) after toolmenu opened a second ${target.kind === 'stdio' ? 'process' : 'connection'} with the same credentials${probedAfter ? ` to check step ${probedAfter}'s scope` : ' to compare menus'}. A server that keeps one session per client does that, so the rest of the scenario didn't run. Run with --processes 1: toolmenu then opens no second one.`,
      });
      return true;
    };
    const callWaited = { ms: 0 };
    const listWaited = { ms: 0 };
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
          // Sent again after a refusal only when that repeats nothing: the transport's
          // 429 means the server never ran it; a tool that says it was rate-limited,
          // thrown or as its result, may have done part of the work first, so only a
          // read-only one is asked again.
          const readOnly = tool?.annotations?.readOnlyHint === true;
          callWaited.ms = 0;
          const result = await patiently(() => conn.client.callTool({ name: step.tool, arguments: step.args }, { timeout: timeoutMs }), {
            waits,
            waited: callWaited,
            error: (e) => httpStatus(e) === 429 || (readOnly && tooMany(e)),
            result: (r) => readOnly && r.isError === true && RATE_LIMITED.test(errorText(r)),
          });
          if (result.isError) {
            const text = errorText(result);
            if (RATE_LIMITED.test(text)) {
              limited(index, text, callWaited.ms, readOnly ? undefined : step.tool);
              record.status = 'failed';
              record.note = 'rate-limited';
              steps.push(record);
              break;
            }
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
          record.note = serverWords(error, 200);
          if (lost(record.note, index)) {
            steps.push(record);
            break;
          }
          if (tooMany(error)) {
            limited(index, record.note, callWaited.ms, httpStatus(error) === 429 || tool?.annotations?.readOnlyHint === true ? undefined : step.tool);
            record.note = 'rate-limited';
            steps.push(record);
            break;
          }
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
        listWaited.ms = 0;
        next = await listPatiently(listWaited);
      } catch (error) {
        const why = serverWords(error, 200);
        record.status = 'failed';
        record.note = record.note ? `${record.note}; then listing the menu failed: ${why}` : `listing the menu failed: ${why}`;
        if (lost(why, index)) {
          steps.push(record);
          break;
        }
        if (tooMany(error)) {
          limited(index, why, listWaited.ms);
          record.note = record.note?.startsWith('listing the menu failed') ? 'rate-limited listing the menu' : 'rate-limited listing the menu after the call';
          steps.push(record);
          break;
        }
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

        if (step.kind !== 'list' && probes) {
          // The main process is still running here: a server that holds a file or
          // a port can't start a second copy. That leaves the scope unknown, not
          // the run failed.
          const probeWaited = { ms: 0 };
          try {
            probedAfter = index;
            const probe = await probeMenu(mainTarget, timeoutMs, waits, probeWaited);
            record.scope = scopeOf(changes, next.tools, probe.tools, target.kind, baseline.tools);
            raw.push(...scopeFindings(record.scope, modern, index));
          } catch (error) {
            record.scope = 'unclear';
            scopeUnchecked.push({ step: index, why: whyNot(error, probeWaited.ms) });
          }
        }
        current = next;
        see(next);
      }
      record.listChanged = conn.wire.notificationsSince(mark, LIST_CHANGED);
      record.tools = current.tools.length;
      record.tokens = current.totalTokens;
      steps.push(record);
    }

    raw.push(...untested(steps, target));
    // --auto means "find what you can": an unlock it skipped is a gap too.
    raw.push(...unlockCoverage(baseline.tools, scenario, steps, options.unionOut === true || options.auto !== undefined, options.auto?.skipped, limitedAt));
    if (options.auto && !scenario.steps.some((s) => s.kind === 'call')) raw.push(nothingCalled(options.auto.skipped));
    if (scopeUnchecked.length) {
      const which = scopeUnchecked.map((s) => s.step);
      raw.push({
        rule: 'session/scope-unchecked',
        severity: 'info',
        step: which[0],
        message: `Couldn't ${target.kind === 'stdio' ? 'start a second server process' : 'open a second connection'} while the session ran, so whether the change${which.length === 1 ? ` at step ${which[0]}` : `s at steps ${which.join(', ')}`} reach${which.length === 1 ? 'es' : ''} a fresh ${target.kind === 'stdio' ? 'process' : 'connection'} wasn't checked: ${scopeUnchecked[0].why}`,
      });
    }

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
      union: buildMenu([...seen.values()].map(toolDefinition), baseline.server),
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

/**
 * Unlocks whose schema lists every value (an enum), and how many of those values
 * the run got through. The session sees, and --union-out keeps, only the tools
 * behind the values it unlocked: GitHub's enable_toolset has 19, the first starter
 * unlocked 2, and 72 of 81 tools never reached the baseline.
 */
function unlockCoverage(menu: MenuTool[], scenario: Scenario, steps: StepRecord[], baselineWanted: boolean, skipped: { tool: string; reason: string }[] = [], stoppedAt?: number): Raw[] {
  const out: Raw[] = [];
  // A run a rate limit stopped (session/rate-limited says so) is charged only for
  // values its scenario leaves out, not for ones in steps it never got to.
  const unrun = stoppedAt === undefined ? [] : scenario.steps.map((step, i) => ({ step, index: i + 1 })).filter((s) => s.index >= stoppedAt);
  for (const u of unlockers(menu)) {
    if (!u.param || u.values.length === 0) continue;
    const reached = new Set<string>();
    let last: number | undefined;
    const add = (arg: unknown) => {
      for (const v of Array.isArray(arg) ? arg : [arg]) if (v !== undefined) reached.add(canonical(v));
    };
    for (const record of steps) {
      const step = scenario.steps[record.index - 1];
      if (step?.kind !== 'call' || step.tool !== u.tool.name || record.status !== 'ok' || record.failure) continue;
      last = record.index;
      add(step.args[u.param]);
    }
    for (const { step } of unrun) if (step.kind === 'call' && step.tool === u.tool.name) add(step.args[u.param]);
    const missing = u.values.filter((v) => !reached.has(canonical(v)));
    // Never called: a scenario about something else, unless it's building the baseline.
    if (missing.length === 0 || (reached.size === 0 && !baselineWanted)) continue;
    const got = u.values.length - missing.length;
    const skip = skipped.find((s) => s.tool === u.tool.name)?.reason;
    const why =
      skip === 'open world'
        ? ` --auto skipped it: it's marked openWorldHint, so it's called only with --open-world.`
        : skip === 'not read-only'
          ? ` --auto skipped it: it isn't marked readOnlyHint, and --auto calls only tools that are.`
          : '';
    out.push({
      rule: 'session/unlock-coverage',
      severity: 'warn',
      tool: u.tool.name,
      ...(last !== undefined ? { step: last } : {}),
      message: `${u.tool.name} looks like it unlocks tools, and the run got through ${got} of its ${u.values.length} ${u.param} values. The tools behind the other ${missing.length} were never seen: this session didn't check them, and a baseline from it (--union-out, baseline-from: session) misses them, so diff can't either.${why}${why ? '' : ' Unlock every value (session --init puts every one in the starter).'}`,
      detail: [`not unlocked: ${missing.slice(0, 12).map((v) => JSON.stringify(v)).join(', ')}${missing.length > 12 ? `, and ${missing.length - 12} more` : ''}`],
    });
  }
  return out;
}

/**
 * --auto that called nothing: the run only listed the menu, so a clean result
 * says nothing about what the tools do to it. Why each tool was left out.
 */
function nothingCalled(skipped: { tool: string; reason: string }[]): Raw {
  const by = (reason: string) => skipped.filter((s) => s.reason === reason).map((s) => s.tool);
  const parts: string[] = [];
  const openWorld = by('open world');
  const needs = by('needs values');
  const writes = by('not read-only');
  if (openWorld.length) parts.push(`${openWorld.length} marked openWorldHint (call them with --open-world: they may cost API credits)`);
  if (needs.length) parts.push(`${needs.length} need values the schema doesn't give (--save-scenario puts them in a scenario to fill in)`);
  if (writes.length) parts.push(`${writes.length} not marked readOnlyHint`);
  const list = (names: string[]) => names.slice(0, 8).join(', ') + (names.length > 8 ? `, and ${names.length - 8} more` : '');
  return {
    rule: 'session/nothing-called',
    severity: 'warn',
    message: `--auto called no tools${parts.length ? `: ${parts.join('; ')}` : ''}. The run only listed the menu, so a clean result says nothing about what calls do to it.`,
    detail: [
      ...(openWorld.length ? [`open world: ${list(openWorld)}`] : []),
      ...(needs.length ? [`need values: ${list(needs)}`] : []),
    ],
  };
}

function serverOf(c: Connection): Menu['server'] {
  return { name: c.server.name, version: c.server.version, protocolVersion: c.protocolVersion, era: c.era };
}

/** A tool result's text, whitespace collapsed. */
function errorText(result: { content?: unknown }): string {
  return (Array.isArray(result.content) ? result.content : [])
    .map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
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
 * process). Reorders alone can't tell, and a mix is unclear. So can't a step that
 * takes the menu back to the session's `baseline` while fresh ones still serve it:
 * a fresh process starts there anyway (an unlock undone reads as "seen" by it).
 */
export function scopeOf(changes: ToolChange[], next: MenuTool[], probe: MenuTool[], transport: Target['kind'], baseline?: MenuTool[]): Scope {
  if (baseline && compareMenus(baseline, next).length === 0 && compareMenus(baseline, probe).length === 0) return 'unclear';
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
// `namespace` is weak too: Kubernetes and Pinecone take one on every read.
const UNLOCK_PARAM = /^(?:domains?|toolsets?|tool_?sets?|capabilit(?:y|ies)|packs?|bundles?)$/i;
const WEAK_UNLOCK_PARAM = /^(?:categor(?:y|ies)|modules?|features?|groups?|namespaces?)$/i;
const UNLOCK_NAME = /unlock|enable|activate|capabilit|toolset|load_?tools|expand/i;
// A description about loading tools: "Adds the audit tools", "enables more
// capabilities", "unlocks…". Whole words: "download" isn't "load", and a device's
// capabilities alone aren't tools.
const UNLOCK_DESC = /\b(?:unlock|enable|activate|load|expose|add)s?\b[^.]{0,60}\b(?:tools?|capabilit(?:y|ies))\b|\bmore tools\b|\btoolsets?\b|\bunlock/i;
// Said outright: a verb that unlocks, then what it gives. Enough to keep a lookup.
const UNLOCK_SAYS = /\b(?:unlock|enable|activate|load|expose|add)s?\b[^.]{0,60}\b(?:tools?|toolsets?|capabilit(?:y|ies))\b/i;
const LOOKUPS = new Set([...LOOKUP_VERBS, 'describe']);

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
  // Named as an unlock: changing the menu is its job, whatever its hints say
  // (toolception marks enable_toolset destructive). It's still only suggested,
  // never called without allow_writes.
  if (UNLOCK_NAME.test(t.name)) return false;
  if (t.annotations?.destructiveHint === true) return true;
  const verb = verbOf(t.name);
  return verb !== undefined && WRITE_VERBS.has(verb);
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
    const description = tool.description ?? '';
    // A lookup names toolsets without changing them (GitHub's get_toolset_tools,
    // toolception's list_toolsets, Firecrawl's find_tools), unless it says it does.
    const verb = verbOf(tool.name);
    if (verb && LOOKUPS.has(verb) && !UNLOCK_SAYS.test(description)) continue;
    const backed = UNLOCK_NAME.test(tool.name) || UNLOCK_DESC.test(description);
    const required = tool.inputSchema?.required ?? [];
    const param =
      Object.keys(props).find((p) => UNLOCK_PARAM.test(p)) ??
      (backed ? Object.keys(props).find((p) => WEAK_UNLOCK_PARAM.test(p)) : undefined) ??
      // Named like an unlock, one required parameter: that's what it takes
      // (toolception's enable_toolset { name }).
      (UNLOCK_NAME.test(tool.name) && required.length === 1 ? required[0] : undefined);
    let score = 0;
    if (param) score += enumOf(props[param]).length ? 3 : 2;
    if (UNLOCK_NAME.test(tool.name)) score += 2;
    if (UNLOCK_DESC.test(tool.description ?? '')) score += 1;
    if (score >= 2) found.push({ tool, score, param, values: param ? enumOf(props[param]) : [] });
  }
  return found.sort((a, b) => b.score - a.score);
}

/**
 * Unlocks whose values the schema doesn't give (no enum), each with a read-only
 * lister that should: no required arguments, a lookup verb, and a noun in common
 * with the unlock (toolception: enable_toolset { name } ← list_toolsets).
 */
export function unlockListers(tools: MenuTool[]): { unlock: string; lister: string }[] {
  const out: { unlock: string; lister: string }[] = [];
  const nounSet = (name: string) => new Set(words(name).map(singular).filter((w) => !VERBS.has(w)));
  for (const u of unlockers(tools.filter((t) => t.annotations?.readOnlyHint === true || !isWriteLike(t)))) {
    if (!u.param || u.values.length) continue;
    const mine = new Set([...nounSet(u.tool.name), ...nounSet(u.param)]);
    const lister = tools.find((t) => {
      if (t === u.tool || t.annotations?.readOnlyHint !== true || (t.inputSchema?.required ?? []).length) return false;
      const verb = verbOf(t.name);
      return !!verb && LOOKUPS.has(verb) && [...nounSet(t.name)].some((n) => mine.has(n));
    });
    if (lister) out.push({ unlock: u.tool.name, lister: lister.name });
  }
  return out;
}

/**
 * The values a listing offers, from its JSON (structuredContent, or text that
 * starts with JSON): the first list of strings, or of objects with a key, id,
 * slug or name, each item's own field first (toolception's `key: "quotes"`, not
 * the display name "Quotes" nested under it).
 */
export function valuesFromListing(result: { structuredContent?: unknown; content?: unknown }): string[] {
  const roots: unknown[] = [];
  if (result.structuredContent) roots.push(result.structuredContent);
  for (const part of Array.isArray(result.content) ? result.content : []) {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string') {
      const value = leadingJson(text);
      if (value !== undefined) roots.push(value);
    }
  }
  const idOf = (item: unknown): string | undefined => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return undefined;
    const o = item as Record<string, unknown>;
    for (const k of ['key', 'id', 'slug', 'name']) if (typeof o[k] === 'string' && o[k]) return o[k] as string;
    return undefined;
  };
  const walk = (v: unknown, depth: number): string[] | undefined => {
    if (depth > 5 || !v || typeof v !== 'object') return undefined;
    if (Array.isArray(v)) {
      const ids = v.map(idOf).filter((x): x is string => !!x);
      if (ids.length && ids.length === v.length) return [...new Set(ids)];
      for (const x of v) {
        const found = walk(x, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    for (const x of Object.values(v)) {
      const found = walk(x, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  for (const r of roots) {
    const found = walk(r, 0);
    if (found) return found;
  }
  return [];
}

/** A YAML value for an unlock parameter: an array if the schema takes one. */
function unlockValue(u: Unlocker, value: unknown): string {
  const schema = u.tool.inputSchema?.properties?.[u.param!];
  return schema?.type === 'array' || schema?.items ? `[${JSON.stringify(value)}]` : JSON.stringify(value);
}

/** At most this many values of one unlock in a scenario; the rest are named in a comment. */
export const MAX_UNLOCKS = 50;

export interface StarterOptions {
  /**
   * Values for unlocks whose schema has no enum, by tool name: read from the
   * server's own listing (toolception's list_toolsets), see unlockListers.
   */
  values?: Record<string, unknown[]>;
}

export function starterScenario(menu: Menu, options: StarterOptions = {}): string {
  const readOnly = menu.tools.filter((t) => t.annotations?.readOnlyHint === true);
  const required = (t: MenuTool) => t.inputSchema?.required ?? [];
  const found = unlockers(menu.tools.filter((t) => t.annotations?.readOnlyHint === true || !isWriteLike(t))).map((u) =>
    u.values.length === 0 && u.param && options.values?.[u.tool.name]?.length ? { ...u, values: options.values[u.tool.name] } : u,
  );
  const unlocking = new Set(found.filter((u) => u.param).map((u) => u.tool));
  const ready = readOnly.filter((t) => required(t).length === 0 && !unlocking.has(t)).slice(0, 12);
  const needsArgs = readOnly.filter((t) => required(t).length > 0);
  // The best candidate with real values runs for real: every value, so the tools
  // behind each are seen (a session baseline holds only what was unlocked), then a repeat.
  const live = found.find((u) => u.values.length > 0 && u.tool.annotations?.readOnlyHint === true && required(u.tool).every((p) => p === u.param));
  const others = found.filter((u) => u !== live);
  const changers = others.map((u) => u.tool);
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
    const shown = live.values.slice(0, MAX_UNLOCKS);
    lines.push('', `  # ${live.tool.name} looks like it unlocks tools. Unlock every ${live.param} (${live.values.length}), listing after each, then the first again:`);
    for (const v of shown) lines.push(`  - call: ${live.tool.name}`, `    args: { ${live.param}: ${unlockValue(live, v)} }`, '  - list');
    if (live.values.length > shown.length) {
      lines.push(`  # …and ${live.values.length - shown.length} more: ${live.values.slice(shown.length).map((v) => JSON.stringify(v)).join(', ')}`);
    }
    lines.push('  # The same unlock twice should change nothing.', `  - call: ${live.tool.name}`, `    args: { ${live.param}: ${unlockValue(live, shown[0])} }`, '  - list');
  }
  if (changers.length) {
    lines.push('', `  # ${live ? 'These also' : 'These'} look like they could change the menu. Try them:`);
    for (const u of others.slice(0, 8)) {
      const t = u.tool;
      if (t.annotations?.readOnlyHint !== true) lines.push(`  # (not marked readOnlyHint: needs allow_writes: true)`);
      // Every known value, as with a live unlock: each may bring different tools.
      const values = u.param && required(t).every((p) => p === u.param) ? u.values.slice(0, MAX_UNLOCKS) : [];
      if (values.length) {
        for (const v of values) lines.push(`  # - call: ${t.name}`, `  #   args: { ${u.param}: ${unlockValue(u, v)} }`, '  # - list');
        continue;
      }
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
