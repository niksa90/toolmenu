import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { cacheBreak, canonical, compareMenus, type ToolChange } from './compare.js';
import { listTools, type Connection, type Target } from './connect.js';
import { buildMenu, toolDefinition } from './menu.js';
import { connectPatiently, isContainerWrapper, MAIN_SEED, probeMenu, probeVariance, seeded } from './probe.js';
import { varianceFinding } from './rules/determinism.js';
import { classifyFailure, errorWords, FAILURE_LABELS, httpStatus, patiently, RATE_LIMIT_WAITS_MS, quotedSentence, RATE_LIMITED, serverWords, SETUP_FAILURES, setupFailureAdvice, tooMany, waitedFor, whyNot, type FailureClass } from './failures.js';
import type { Era, Finding, Menu, MenuTool, Severity } from './types.js';
import { SEVERITY_RANK } from './types.js';
import { leadingJson } from './catalog.js';
import { allDifferences, describeToolDifference } from './difference.js';
import { autoNextStep, neededValues, writeSign, type AutoSummary } from './auto.js';
import { LOOKUP_VERBS, singular, VERBS, verbOf, words, WRITE_VERBS } from './words.js';

export type Step =
  | { kind: 'list' }
  | {
      kind: 'call';
      tool: string;
      args: Record<string, unknown>;
      /**
       * --auto only, never from a scenario file: an unlock guessed from its schema
       * alone. If its first such call changes nothing, the rest aren't made.
       */
      tentative?: boolean;
    }
  | { kind: 'wait_for'; event: 'tools_list_changed'; timeoutMs: number };

export interface Scenario {
  allowWrites: boolean;
  steps: Step[];
  /**
   * Tools the user says only read, although the server doesn't mark them
   * readOnlyHint (`assume_read_only`, --assume-read-only). Called without
   * allow_writes; a tool marked destructiveHint or readOnlyHint: false never is.
   */
  assumeReadOnly?: string[];
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
  const doc = data as { allow_writes?: unknown; steps?: unknown; assume_read_only?: unknown };
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.steps) || doc.steps.length === 0) {
    throw new Error(`${where}: expected "steps:" with at least one step`);
  }
  if (doc.allow_writes !== undefined && typeof doc.allow_writes !== 'boolean') {
    throw new Error(`${where}: allow_writes must be true or false`);
  }
  const assumed = doc.assume_read_only;
  if (assumed !== undefined && (!Array.isArray(assumed) || !assumed.every((x) => typeof x === 'string' && x && !/[*?[\]]/.test(x)))) {
    throw new Error(`${where}: assume_read_only must be a list of exact tool names (no patterns)`);
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
  return { allowWrites: doc.allow_writes === true, steps, ...(Array.isArray(assumed) && assumed.length ? { assumeReadOnly: assumed as string[] } : {}) };
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
  /**
   * What a call step's call did: the tool answered, answered with an error
   * (isError), the request failed, or it wasn't sent (refused, not in the menu).
   */
  outcome?: 'answered' | 'tool-error' | 'failed' | 'not-sent';
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
  auto?: AutoSummary;
}

export interface SessionOptions {
  timeoutMs?: number;
  /**
   * --auto: steps for tools that appear mid-session, run right after the step
   * that brought them. Called once per change, with only the new tools.
   */
  replan?: (added: MenuTool[]) => Step[];
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
  auto?: AutoSummary;
  /** Waits before retrying a request refused for being too many (default 2, 4, 8, 16, 32 s: a per-minute limit clears within them). */
  rateLimitWaitsMs?: number[];
}

/** `each`: this step's line when findings of one rule are said once for several steps. */
/** `each`: this step's line when repeats merge. `cause`: what makes two edits one cause. Neither is reported. */
export type Raw = Omit<Finding, 'severity'> & { severity: Severity; each?: string; cause?: string };

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
        ...(tool ? { tool } : {}),
        message: tool
          ? `Rate-limited at step ${index}: ${tool} said ${quotedSentence(said)} Not called again: it isn't marked readOnlyHint, so it may have done part of the work. ${unchecked}`
          : `Rate-limited at step ${index}, and still after waiting ${waitedFor(waitedMs)}: ${quotedSentence(said)} ${unchecked} The limit counts every request from this address, toolmenu's included.`,
        fix: tool
          ? "If the limit is the server's, give the run its own server instance or raise the limit; if it's an upstream API's, run later or with a higher quota."
          : 'Give the run its own server instance, or raise the limit for it.',
      });
    };
    let current = await listPatiently();
    // Map keeps first-insertion order; set() on a known name updates it in place.
    const seen = new Map<string, MenuTool>();
    const see = (menu: Menu) => menu.tools.forEach((t) => seen.set(t.name, t));
    see(current);
    const baseline = current;

    // Values that differ from one tools/list to the next on their own (a default
    // computed from the clock: PayPal's list_transactions.end_date), by tool and
    // path, with the finding that reported them first. A later change only there
    // has the same cause and points to it (SPEC §25: one root cause, one finding).
    const varying = new Map<string, { rule: string; step: number }>();
    const learn = (before: MenuTool[], after: MenuTool[], changes: ToolChange[], source: { rule: string; step: number }) => {
      for (const [key] of variedPaths(before, after, changes)) if (!varying.has(key)) varying.set(key, source);
    };

    // Fresh processes or connections, same credentials, must see the same menu.
    let connectionCheck: SessionResult['connectionCheck'];
    for (const probe of await probeVariance(target, current.tools, options.processes ?? 2, timeoutMs, waits)) {
      if (probe.error) {
        raw.push({
          rule: target.kind === 'stdio' ? 'menu/process-variance' : 'menu/connection-variance',
          severity: 'info',
          step: 0,
          message: `Couldn't ${target.kind === 'stdio' ? 'start a second server process' : 'open a second connection'} to compare menus, so this wasn't checked: ${serverWords(probe.error, 200)}`,
          fix: `If the server can only run ${target.kind === 'stdio' ? 'once at a time' : 'one connection at a time'}, rerun with --processes 1: the check is then skipped on purpose.`,
        });
        continue;
      }
      const f = varianceFinding(current.tools, probe.tools ?? [], { transport: target.kind, modern, wrapper: isContainerWrapper(target) });
      connectionCheck = f ? 'different' : connectionCheck ?? 'same';
      if (f) {
        const changes = compareMenus(current.tools, probe.tools ?? []);
        raw.push({ ...f, step: 0, ...(f.fix ? {} : varianceFix(current.tools, probe.tools ?? [], changes)) });
        learn(current.tools, probe.tools ?? [], changes, { rule: f.rule, step: 0 });
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
        confidence: 'unsure',
        message: `The server ended this session at step ${index} (“${said}”), after toolmenu opened a second ${target.kind === 'stdio' ? 'process' : 'connection'} with the same credentials${probedAfter ? ` to check step ${probedAfter}'s scope` : ' to compare menus'}. A server that keeps one session per client does that; the rest of the scenario didn't run.`,
        fix: 'Rerun with --processes 1: toolmenu then opens no second one.',
      });
      return true;
    };
    const callWaited = { ms: 0 };
    const listWaited = { ms: 0 };
    // Read live: --auto vouches for tools that appear mid-session too.
    const assumed = { has: (tool: string) => (scenario.assumeReadOnly ?? []).includes(tool) };
    // Called on the user's word (assume_read_only), by step.
    const onWord: { tool: string; step: number }[] = [];
    // The same failure from the same tool at several steps is one finding that lists them.
    const failures = new Map<string, Failure>();
    const fail = (rule: string, severity: Severity, index: number, step: { tool: string; args: Record<string, unknown> }, text: string, failure: FailureClass, timedOutMs?: number) => {
      const key = `${rule}\0${step.tool}\0${text}`;
      const before = failures.get(key);
      if (before) before.steps.push(index);
      else {
        const params = Object.keys(current.tools.find((t) => t.name === step.tool)?.inputSchema?.properties ?? {});
        failures.set(key, { rule, severity, tool: step.tool, text, steps: [index], args: step.args, failure, takesParams: params.length > 0, ...(timedOutMs ? { timedOutMs } : {}) });
      }
    };
    // Steps whose change touched only values already known to vary on their own.
    const explained: Explained[] = [];
    // --auto's guessed unlocks: tried once, and those whose first call changed nothing.
    const tried = new Set<string>();
    const quiet = new Set<string>();
    const stopped = new Map<string, number>();
    for (const [i, step] of scenario.steps.entries()) {
      const index = i + 1;
      if (step.kind === 'call' && step.tentative) {
        if (quiet.has(step.tool)) {
          stopped.set(step.tool, (stopped.get(step.tool) ?? 0) + 1);
          continue;
        }
      }
      const firstTry = step.kind === 'call' && step.tentative === true && !tried.has(step.tool);
      if (firstTry) tried.add(step.tool);
      const label = stepLabel(step);
      const record: StepRecord = { index, label, status: 'ok', changed: false, listChanged: 0, tools: current.tools.length, tokens: current.totalTokens };
      const mark = conn.wire.notifications.length;
      let word = false;
      const done = () => {
        if (word) record.note = record.note ? `on your word (not marked readOnlyHint); ${record.note}` : 'on your word (not marked readOnlyHint)';
        steps.push(record);
      };

      if (step.kind === 'call') {
        const tool = current.tools.find((t) => t.name === step.tool);
        const write = tool ? writeSign(tool) : undefined;
        word = !!tool && tool.annotations?.readOnlyHint !== true && assumed.has(step.tool) && !write && !scenario.allowWrites;
        if (!tool) {
          record.status = 'failed';
          record.reason = 'missing';
          record.outcome = 'not-sent';
          record.note = `${step.tool} isn't in the menu at this point`;
          const squash = (n: string) => n.toLowerCase().replace(/[-_.\s]/g, '');
          const close = current.tools.find((t) => squash(t.name) === squash(step.tool));
          raw.push({
            rule: 'session/step-failed',
            severity: 'error',
            step: index,
            tool: step.tool,
            message: `${step.tool} isn't in the menu at step ${index}, so it wasn't called.`,
            fix: close ? `Did you mean ${close.name}? Fix the name in the scenario.` : `Check the name, or move the call after the step that adds ${step.tool}.`,
          });
        } else if (!scenario.allowWrites && tool.annotations?.readOnlyHint !== true && !word) {
          record.status = 'refused';
          record.reason = 'refused';
          record.outcome = 'not-sent';
          record.note = 'not marked readOnlyHint';
          raw.push({
            rule: 'session/refused',
            severity: 'error',
            step: index,
            tool: step.tool,
            message:
              assumed.has(step.tool) && write
                ? `Refused to call ${step.tool}: ${write}, and assume_read_only doesn't override the server's own marking. Session calls tools for real.`
                : `Refused to call ${step.tool}: it isn't marked readOnlyHint, and session calls tools for real.`,
            fix:
              write || tool.annotations?.readOnlyHint === false
                ? 'Set "allow_writes: true" in the scenario if calling it is intended.'
                : `If it only reads, list it under assume_read_only in the scenario; if it writes and that's intended, set "allow_writes: true".`,
          });
        }
        if (word) onWord.push({ tool: step.tool, step: index });
        if (record.status === 'ok') try {
          // Sent again after a refusal only when that repeats nothing: the transport's
          // 429 means the server never ran it; a tool that says it was rate-limited,
          // thrown or as its result, may have done part of the work first, so only a
          // read-only one is asked again. On the server's word, not the user's.
          const readOnly = tool?.annotations?.readOnlyHint === true;
          callWaited.ms = 0;
          const result = await patiently(() => conn.client.callTool({ name: step.tool, arguments: step.args }, { timeout: timeoutMs }), {
            waits,
            waited: callWaited,
            error: (e) => httpStatus(e) === 429 || (readOnly && tooMany(e)),
            result: (r) => readOnly && r.isError === true && RATE_LIMITED.test(errorText(r)),
          });
          record.outcome = result.isError ? 'tool-error' : 'answered';
          if (result.isError) {
            const text = errorText(result);
            if (RATE_LIMITED.test(text)) {
              limited(index, text, callWaited.ms, readOnly ? undefined : step.tool);
              record.status = 'failed';
              record.note = 'rate-limited';
              done();
              break;
            }
            const short = clip(text, 120);
            record.note = text ? `the tool returned an error: ${short}` : 'the tool returned an error';
            record.failure = classifyFailure(text, { hadArguments: Object.keys(step.args).length > 0 });
            // A setup failure is reported once, for the whole run (session/untested).
            if (!SETUP_FAILURES.has(record.failure)) fail('session/tool-error', 'warn', index, step, text, record.failure);
          }
        } catch (error) {
          record.status = 'failed';
          record.outcome = 'failed';
          record.note = serverWords(error, 200);
          if (lost(record.note, index)) {
            done();
            break;
          }
          if (tooMany(error)) {
            limited(index, record.note, callWaited.ms, httpStatus(error) === 429 || tool?.annotations?.readOnlyHint === true ? undefined : step.tool);
            record.note = 'rate-limited';
            done();
            break;
          }
          const code = (error as { code?: unknown }).code;
          record.failure = classifyFailure(record.note, { code: typeof code === 'number' ? code : undefined, hadArguments: Object.keys(step.args).length > 0 });
          // The SDK's own request timeout: toolmenu stopped waiting, the server didn't refuse anything.
          const timedOutMs = code === 'REQUEST_TIMEOUT' ? timeoutMs : undefined;
          if (!SETUP_FAILURES.has(record.failure)) fail('session/step-failed', 'error', index, step, record.note, record.failure, timedOutMs);
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
          done();
          break;
        }
        if (tooMany(error)) {
          limited(index, why, listWaited.ms);
          record.note = record.note?.startsWith('listing the menu failed') ? 'rate-limited listing the menu' : 'rate-limited listing the menu after the call';
          done();
          break;
        }
        raw.push({
          rule: 'session/step-failed',
          severity: 'error',
          step: index,
          message: `After step ${index} (${label}), listing the menu failed: ${why}. The menu after this step wasn't checked.`,
          fix: "Check whether the step crashed or disconnected the server (its stderr), then rerun.",
        });
        done();
        continue;
      }
      const changes = compareMenus(current.tools, next.tools);
      if (changes.length) {
        record.changed = true;
        const paths = variedPaths(current.tools, next.tools, changes);
        const onItsOwn = paths.size > 0 && changes.every((c) => EDIT_KINDS.has(c.kind)) && [...paths.keys()].every((k) => varying.has(k));
        if (onItsOwn) {
          // Same cause as a finding already made: said once, after the steps.
          explained.push({ step: index, source: varying.get([...paths.keys()][0])!, seen: [...paths].map(([k, d]) => `${k.replace('\0', ': ')}: ${show(d.before)} vs ${show(d.after)}`) });
          const cause = `only where it varies on its own, see ${explained[explained.length - 1].source.rule}`;
          record.note = record.note ? `${record.note}; ${cause}` : cause;
        } else {
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
          // With no call in between, whatever changed varies on its own: a later
          // change only there has the same cause.
          if (step.kind === 'list' || record.reason !== undefined) learn(current.tools, next.tools, changes, { rule: 'session/edit', step: index });

          if (declared && listening && conn.wire.notificationsSince(mark, LIST_CHANGED) === 0) {
            raw.push({
              rule: 'session/unannounced',
              severity: 'warn',
              step: index,
              message: `The menu changed without a notifications/tools/list_changed, although the server declared listChanged. Clients that cache the list won't know to fetch it again; the spec says servers SHOULD send it.`,
              fix: 'Send notifications/tools/list_changed whenever the tool list changes.',
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
        }
        // --auto: the tools this step brought get their calls now, while they're listed.
        const added = new Set(changes.filter((c) => c.kind === 'added').map((c) => c.tool));
        if (options.replan && added.size) scenario.steps.splice(i + 1, 0, ...options.replan(next.tools.filter((t) => added.has(t.name))));
        current = next;
        see(next);
      }
      record.listChanged = conn.wire.notificationsSince(mark, LIST_CHANGED);
      record.tools = current.tools.length;
      record.tokens = current.totalTokens;
      if (firstTry && !record.changed && record.status === 'ok' && !record.failure) quiet.add((step as { tool: string }).tool);
      done();
    }

    raw.push(...failureFindings(sameError([...failures.values()]), options.auto));
    if (explained.length) raw.push(knownVariance(explained));
    if (onWord.length) raw.push(onTheirWord(onWord, options.auto !== undefined));
    raw.push(...untested(steps, target));
    // --auto means "find what you can": an unlock it skipped is a gap too.
    const leftOut = [...stopped].map(([tool, calls]) => ({ tool, calls }));
    // An unlock --auto stopped trying isn't charged for the values it then left out.
    const covered = baseline.tools.filter((t) => !stopped.has(t.name));
    raw.push(...unlockCoverage(covered, scenario, steps, options.unionOut === true || options.auto !== undefined, options.auto?.skipped, limitedAt));
    if (options.auto && !scenario.steps.some((s) => s.kind === 'call')) raw.push(nothingCalled(options.auto));
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
      findings: settle(mergeRepeats(raw), options),
      ...(options.auto ? { auto: { ...options.auto, ...(leftOut.length ? { stopped: leftOut } : {}) } } : {}),
      // Marked: its order is the order tools were first seen (unlock order), so diff doesn't compare it.
      union: { ...buildMenu([...seen.values()].map(toolDefinition), baseline.server), from: 'session' },
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
  // One step per class seen, not just the first: a run can fail on credentials and a missing browser at once.
  const { fix } = setupFailureAdvice(byClass.keys(), target.kind);
  return [
    {
      rule: 'session/untested',
      severity: all ? 'error' : 'warn',
      // Classified from the error's words: a guess, if a good one.
      confidence: 'unsure',
      message: `${all ? `All ${calls.length}` : `${setup.length} of ${calls.length}`} tool calls failed before reaching the tool: ${[...byClass].map(([c, list]) => `${list.length} on ${FAILURE_LABELS[c]}`).join(', ')}. Those steps only tested whether a failed call changes the menu.`,
      detail: [...byClass].map(([c, list]) => `${c}: steps ${list.map((s) => s.index).join(', ')} (“${(list[0].note ?? '').replace(/^the tool returned an error: /, '').slice(0, 100)}”)`),
      fix,
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
          : skip === 'unmarked'
            ? ` --auto skipped it: the server doesn't mark it readOnlyHint.`
            : '';
    out.push({
      rule: 'session/unlock-coverage',
      severity: 'warn',
      tool: u.tool.name,
      // "Looks like it unlocks": from its name, parameter and description.
      confidence: 'unsure',
      ...(last !== undefined ? { step: last } : {}),
      message: `${u.tool.name} looks like it unlocks tools, and the run got through ${got} of its ${u.values.length} ${u.param} values. The tools behind the other ${missing.length} were never seen: this session didn't check them, and a baseline from it (--union-out, baseline-from: session) misses them, so diff can't either.${why}`,
      detail: [`not unlocked: ${missing.slice(0, 12).map((v) => JSON.stringify(v)).join(', ')}${missing.length > 12 ? `, and ${missing.length - 12} more` : ''}`],
      fix:
        skip === 'open world'
          ? 'Rerun with --open-world.'
          : skip === 'unmarked'
            ? `If it only changes which tools are listed, rerun with --assume-read-only ${u.tool.name}.`
            : skip === 'not read-only'
              ? `Write a scenario that unlocks every value (session --init puts each one in the starter) and set allow_writes: true.`
              : 'Unlock every value: session --init puts each one in the starter.',
    });
  }
  return out;
}

/**
 * --auto that called nothing: the run only listed the menu, so a clean result
 * says nothing about what the tools do to it. Why each tool was left out, and the
 * flag that reaches the most of them.
 */
function nothingCalled(auto: AutoSummary): Raw {
  const by = (reason: string) => auto.skipped.filter((s) => s.reason === reason).map((s) => s.tool);
  const parts: string[] = [];
  const openWorld = by('open world');
  const needs = by('needs values');
  const unmarked = by('unmarked');
  const writes = by('not read-only');
  if (needs.length) parts.push(`${needs.length} ${needs.length === 1 ? 'needs' : 'need'} values the schema doesn't give`);
  if (unmarked.length) parts.push(`${unmarked.length} ${unmarked.length === 1 ? "isn't" : "aren't"} marked readOnlyHint`);
  if (openWorld.length) parts.push(`${openWorld.length} marked openWorldHint (${openWorld.length === 1 ? 'it' : 'they'} may cost API credits)`);
  if (writes.length) parts.push(`${writes.length} marked or named as writes`);
  const list = (names: string[]) => names.slice(0, 8).join(', ') + (names.length > 8 ? `, and ${names.length - 8} more` : '');
  const params = neededValues(auto.skipped);
  const fix = autoNextStep(auto);
  return {
    rule: 'session/nothing-called',
    severity: 'warn',
    message: `--auto called no tools${parts.length ? `: ${parts.join('; ')}` : ''}. The run only listed the menu, so a clean result says nothing about what calls do to it.`,
    detail: [
      ...(needs.length ? [`need values: ${params.slice(0, 6).map((p) => `${p.param} (${list(p.tools)})`).join('; ')}${params.length > 6 ? `; and ${params.length - 6} more` : ''}`] : []),
      ...(unmarked.length ? [`not marked readOnlyHint: ${list(unmarked)}`] : []),
      ...(openWorld.length ? [`open world: ${list(openWorld)}`] : []),
    ],
    ...(fix ? { fix } : {}),
  };
}

/** A tool error or failed call, and every step it happened at. */
interface Failure {
  rule: string;
  severity: Severity;
  tool: string;
  text: string;
  steps: number[];
  args: Record<string, unknown>;
  failure: FailureClass;
  /** The tool has parameters in its schema. */
  takesParams: boolean;
  /** toolmenu's own request timeout ran out (ms): the server didn't answer in time, which isn't an argument or server error. */
  timedOutMs?: number;
  /** The same error in the same words from other tools too, with their calls. */
  others?: { tool: string; args: Record<string, unknown>; takesParams: boolean }[];
}

/**
 * The same error text from different tools is one finding (two tools of a feature
 * that "isn't set up on this deployment"). An empty text says nothing in common.
 */
function sameError(failures: Failure[]): Failure[] {
  const out: Failure[] = [];
  const byText = new Map<string, Failure>();
  for (const f of failures) {
    const key = `${f.rule}\0${f.text}`;
    const first = f.text ? byText.get(key) : undefined;
    if (!first) {
      out.push({ ...f, steps: [...f.steps] });
      if (f.text) byText.set(key, out[out.length - 1]);
      continue;
    }
    first.steps = [...first.steps, ...f.steps].sort((a, b) => a - b);
    first.others = [...(first.others ?? []), { tool: f.tool, args: f.args, takesParams: f.takesParams }];
  }
  return out;
}

// The server says the feature isn't there, or isn't for this account: no argument
// fixes that. A guess from its words.
// Only definite statements: a hedge in the server's own advice ("the account may lack
// permission") says nothing about this call, and a bare "permission" or "role" turns up in
// ordinary validation messages.
const UNAVAILABLE = /\b(?:isn't|is not|not|aren't|are not)\s+(?:set up|enabled|configured|available|activated|licensed|provisioned)\b|\bdisabled\b|\b(?:permission|access)s? denied\b|\binsufficient (?:permissions?|privileges?)\b|\b(?:don't|doesn't|do not|does not) have (?:the )?(?:required |necessary )?(?:permissions?|access)\b|\bforbidden\b|\bnot allowed\b/i;

/** A step whose change was only in values known to vary on their own. */
interface Explained {
  step: number;
  source: { rule: string; step: number };
  seen: string[];
}

/** "step 2", "steps 2 and 3", "steps 2, 3 and 5", "steps 1–7 and 9". */
export function stepsText(steps: number[]): string {
  if (steps.length === 1) return `step ${steps[0]}`;
  const runs: string[] = [];
  for (let i = 0; i < steps.length; ) {
    let j = i;
    while (j + 1 < steps.length && steps[j + 1] === steps[j] + 1) j++;
    if (j - i >= 2) runs.push(`${steps[i]}–${steps[j]}`);
    else for (let k = i; k <= j; k++) runs.push(String(steps[k]));
    i = j + 1;
  }
  return runs.length === 1 ? `steps ${runs[0]}` : `steps ${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}`;
}

/**
 * The same error from the same tool is one finding that names every step it
 * happened at (Exa: one bad argument, steps 2 and 3). The error in the server's
 * words, the call that got it, and what to try.
 */
function failureFindings(failures: Failure[], auto: AutoSummary | undefined): Raw[] {
  return failures.map((f) => {
    const many = f.steps.length > 1;
    const calls = [f, ...(f.others ?? [])];
    const tools = [...new Set(calls.map((c) => c.tool))];
    const who = tools.length === 1 ? f.tool : `${tools.slice(0, -1).join(', ')} and ${tools[tools.length - 1]}`;
    const words = errorWords(f.text);
    const shown = clip(words, 160);
    const said = f.text ? quotedSentence(shown) : 'no error text.';
    const firstArg = Object.keys(f.args)[0];
    const argsCan = f.failure === 'invalid-arguments' || f.failure === 'other';
    // No argument can fix a call to a tool that takes none, or a feature the server
    // says isn't there. From the server's words: a guess.
    const unavailable = argsCan && f.failure !== 'invalid-arguments' && UNAVAILABLE.test(f.text);
    const them = tools.length === 1 ? 'its' : 'their';
    const leaveOut = auto ? `save the steps with --save-scenario, drop ${them} calls and run that with --scenario` : `drop ${them} calls from the scenario`;
    const noParams = calls.every((c) => !c.takesParams && Object.keys(c.args).length === 0);
    const secs = f.timedOutMs ? `${Math.round(f.timedOutMs / 1000)} s` : '';
    const fix = f.timedOutMs
      ? `${who} didn't answer within toolmenu's ${secs} request timeout: the call may just be slow (fetching or searching a lot). Rerun with a longer --timeout (e.g. --timeout ${f.timedOutMs * 4}); if it still times out, the server hangs on this call.`
      : !argsCan
      ? undefined
      : unavailable
        ? `The server says this feature isn't available here: nothing to change in the call. Test ${tools.length === 1 ? 'it' : 'them'} on a deployment that has it, or leave ${tools.length === 1 ? 'it' : 'them'} out: ${leaveOut}.`
        : noParams
          ? `${tools.length === 1 ? `${f.tool} takes` : 'These tools take'} no arguments, so nothing in the call can fix this: the error is the server's. Check it on the server side, or leave ${tools.length === 1 ? 'it' : 'them'} out: ${leaveOut}.`
          : auto?.withValues?.includes(f.tool)
            ? `Check the values you gave ${f.tool} (--value) against what the server says above.`
            : auto
              ? `If the arguments are what it refused, give it real ones: --value ${f.tool}.${firstArg ?? '<param>'}=…${firstArg ? ' (--auto made these up from the schema).' : ''}`
              : `Check the arguments of the call at ${stepsText([f.steps[0]])} in the scenario against what ${f.tool} expects.`;
    const lead = many ? `${stepsText(f.steps).replace(/^s/, 'S')}: ` : '';
    const detail = calls.slice(0, 8).map((c) => {
      const call = `${c.tool} ${JSON.stringify(c.args)}`;
      return `call: ${call.length > 200 ? call.slice(0, 199) + '…' : call}`;
    });
    return {
      rule: f.rule,
      severity: f.severity,
      step: f.steps[0],
      ...(many ? { steps: f.steps } : {}),
      tool: f.tool,
      // The server's whole text, when the message above shows less of it.
      ...(f.text && shown !== f.text ? { serverText: f.text } : {}),
      ...(!f.timedOutMs && (unavailable || (noParams && argsCan)) ? { confidence: 'unsure' as const } : {}),
      message:
        f.rule === 'session/tool-error'
          ? tools.length > 1
            ? `${lead}${who} returned the same error: ${said} A call that fails tests less than it looks: the menu was checked after it, the tool's own work wasn't.`
            : `${lead}${f.tool} returned an error${many ? ', the same one each time' : ''}: ${said} A call that fails tests less than it looks: the menu was checked after it, the tool's own work wasn't.`
          : tools.length > 1
            ? `${lead}Calling ${who} failed the same way: ${said}`
            : `${lead}Calling ${f.tool} failed${many ? ', the same way each time' : ''}: ${said}`,
      detail: [...new Set(detail)],
      ...(fix ? { fix } : {}),
    };
  });
}

/**
 * Changes that touched only values already seen to vary on their own: one info
 * finding for the run, pointing to the one that reported the cause.
 */
function knownVariance(explained: Explained[]): Raw {
  const steps = explained.map((e) => e.step);
  const src = explained[0].source;
  const where = src.step === 0 ? 'before step 1' : `at step ${src.step}`;
  // The values at the first such step; the rest only repeat the pattern.
  const seen = explained[0].seen;
  return {
    rule: 'session/known-variance',
    severity: 'info',
    step: steps[0],
    message: `${steps.length > 1 ? `${stepsText(steps).replace(/^s/, 'S')}: the` : 'The'} menu changed again, only in values that already differ from one tools/list to the next. Same cause as ${src.rule} (${where}), so it isn't counted again.`,
    detail: [...seen.slice(0, 4), ...(seen.length > 4 ? [`…and ${seen.length - 4} more`] : [])],
    fix: `Fix the ${src.rule} finding (${where}); these changes go away with it.`,
  };
}

/** Tools called because the user said they only read: said once, loudly. */
function onTheirWord(calls: { tool: string; step: number }[], auto: boolean): Raw {
  const tools = [...new Set(calls.map((c) => c.tool))];
  return {
    rule: 'session/assumed-read-only',
    severity: 'info',
    step: calls[0].step,
    message: `Called ${tools.length === 1 ? `${tools[0]}, which the server doesn't mark readOnlyHint,` : `${tools.length} tools the server doesn't mark readOnlyHint`} on your word (${auto ? '--assume-read-only' : 'assume_read_only'}). If ${tools.length === 1 ? 'it writes, it wrote' : 'one of them writes, it wrote'}.`,
    detail: [`${stepsText([...new Set(calls.map((c) => c.step))])}: ${tools.join(', ')}`],
    fix: `Ask the server's authors to mark ${tools.length === 1 ? 'it' : 'them'} readOnlyHint: true; then ${auto ? `--auto calls ${tools.length === 1 ? 'it' : 'them'} without --assume-read-only` : 'drop assume_read_only'}.`,
  };
}

/**
 * Every leaf value that differs between the old and new definition of each edited
 * tool, keyed `tool\0path` (`list_transactions\0inputSchema.properties.end_date.default`).
 */
function variedPaths(before: MenuTool[], after: MenuTool[], changes: ToolChange[]): Map<string, { before: unknown; after: unknown }> {
  const out = new Map<string, { before: unknown; after: unknown }>();
  const old = new Map(before.map((t) => [t.name, t]));
  for (const name of new Set(changes.filter((c) => EDIT_KINDS.has(c.kind)).map((c) => c.tool))) {
    const a = old.get(name);
    const b = after.find((t) => t.name === name);
    if (!a || !b) continue;
    for (const [path, d] of leafDiffs(toolDefinition(a), toolDefinition(b))) out.set(`${name}\0${path}`, d);
  }
  return out;
}

function leafDiffs(a: unknown, b: unknown, path = '', out = new Map<string, { before: unknown; after: unknown }>()): Map<string, { before: unknown; after: unknown }> {
  if (canonical(a) === canonical(b)) return out;
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (obj(a) && obj(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) leafDiffs(a[key], b[key], path ? `${path}.${key}` : key, out);
  } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => leafDiffs(x, b[i], `${path}[${i}]`, out));
  } else out.set(path, { before: a, after: b });
  return out;
}

function show(value: unknown): string {
  if (value === undefined) return '(absent)';
  const text = JSON.stringify(value);
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}/;

/** The next step for a menu that differs between processes, from what differs. */
function varianceFix(main: MenuTool[], other: MenuTool[], changes: ToolChange[]): { fix?: string } {
  const diffs = [...variedPaths(main, other, changes)];
  if (diffs.length === 0) return changes.every((c) => c.kind === 'moved') ? { fix: 'Return the tools in a fixed order (sorted, or as registered).' } : {};
  const where = diffs.slice(0, 2).map(([k]) => k.replace('\0', '.')).join(', ');
  if (diffs.every(([, d]) => typeof d.before === 'string' && typeof d.after === 'string' && TIMESTAMP.test(d.before) && TIMESTAMP.test(d.after))) {
    return { fix: `Build ${where}${diffs.length > 2 ? ' and the rest' : ''} from a fixed value, not the current time (or leave the default out and say it in the description).` };
  }
  return { fix: `Make ${where}${diffs.length > 2 ? ' and the rest' : ''} the same on every tools/list: sort what comes from a set or a map, and build nothing from the clock or a random value.` };
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

const APPEND_WHY =
  " The end of the tool list isn't the end of the prompt: most clients send tools first (Claude's Messages API does), so any change to them, an append too, invalidates the cached conversation after them. Appends are cache-safe only if your client adds new tools after the cached content, as tool search (deferred loading) does.";

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
        `cost: the whole tool list (this server's part: ~${total.toLocaleString('en-US')} tokens, estimate) and the conversation after it; the change starts at position ${brk.position}${brk.position >= after.length ? ' (tools removed from the end)' : ''}`,
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
        message: `+${names.length} tool${names.length === 1 ? '' : 's'} appended at the end of the list (${names.join(', ')}).${APPEND_WHY}`,
        detail: [`~${tokens.toLocaleString('en-US')} new tokens (estimate)`, ...why],
        each: `step ${step}: +${names.length} tool${names.length === 1 ? '' : 's'} (~${tokens.toLocaleString('en-US')} tokens): ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}`,
        fix: 'If clients should keep their cache, list these tools from the start, or have clients load them through tool search.',
      });
    } else {
      const first = Math.min(...added.map((a) => a.position));
      out.push({
        rule: 'session/mid-insert',
        severity: 'error',
        step,
        message: `+${names.length} tool${names.length === 1 ? '' : 's'} inserted at position ${first} (${names.join(', ')}). Invalidates the cached prompt: the tool list and the conversation after it are processed again.`,
        detail: [...cost, ...why],
        fix: 'Add new tools at the end of the list, not in the middle; better, list them from the start.',
      });
    }
  }
  const moved = changes.filter((c) => c.kind === 'moved');
  if (moved.length) {
    out.push({
      rule: 'session/reorder',
      severity: 'error',
      step,
      message: `Tool order changed mid-session (${moved.map((m) => m.tool).join(', ')}). Invalidates the cached prompt, although no tool changed.`,
      detail: [...cost, ...why],
      fix: 'Return the tools in one fixed order (sorted, or as registered) on every tools/list.',
    });
  }
  const removed = changes.filter((c) => c.kind === 'removed');
  if (removed.length) {
    out.push({
      rule: 'session/remove',
      severity: 'error',
      step,
      message: `${removed.map((r) => r.tool).join(', ')} disappeared from the menu mid-session. Invalidates the cached prompt, and a model that already saw ${removed.length === 1 ? 'it' : 'them'} may still call ${removed.length === 1 ? 'it' : 'them'}.`,
      detail: [...cost, ...why],
      fix: `Keep ${removed.length === 1 ? 'the tool' : 'the tools'} listed for the whole session; refuse the call with an error that says why instead.`,
    });
  }
  const edits = new Map<string, string[]>();
  for (const c of changes.filter((c) => EDIT_KINDS.has(c.kind))) edits.set(c.tool, [...(edits.get(c.tool) ?? []), c.kind === 'other' ? 'definition' : c.kind === 'serialization' ? 'key order (same content, different bytes)' : c.kind]);
  const old = new Map(before.map((t) => [t.name, t]));
  for (const [tool, fields] of edits) {
    const a = old.get(tool);
    const b = after.find((t) => t.name === tool);
    // What differs, down to the value: `inputSchema.properties.end_date.default: "…21.5Z" vs "…40.2Z"`.
    const seen = a && b ? [describeToolDifference(a, b).replace(/^[^:]*: /, '')] : [];
    // One cause: the same tool, the same changed values and the same origin (a
    // timestamp in a description, rewritten at every call). A change that touches
    // anything more is a change of its own.
    const paths = a && b ? allDifferences(toolDefinition(a), toolDefinition(b)).map((d) => d.path).sort().join(',') : '';
    out.push({
      rule: 'session/edit',
      severity: 'error',
      step,
      tool,
      cause: `${tool}|${fields.join(',')}|${paths}|${origin ?? ''}`,
      each: `step ${step}: position ${brk?.position ?? '?'} · ~${total.toLocaleString('en-US')} tokens (estimate)${seen[0] ? ` · ${seen[0]}` : ''}`,
      message: `${tool}: ${fields.join(', ')} changed mid-session. Invalidates the cached prompt: the tool list and the conversation after it are processed again.`,
      detail: [...seen, ...cost, ...why],
      fix: origin === 'no tool call in between' ? `Make ${tool}'s definition the same on every tools/list: nothing built from the clock, a random value, or a set's order.` : `Keep ${tool}'s definition fixed for the session; if it has to change, change it between conversations.`,
    });
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
        fix: 'Serve every connection the same tool set; to let a conversation reach more tools, list them all and let clients load them through tool search.',
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
        fix: 'List the same tools whatever the calls before; to let a conversation reach more tools, list them all and let clients load them through tool search.',
      },
    ];
  }
  return [];
}

/**
 * Findings that say the same thing at every step are said once, naming the steps:
 * stdio's side-effect warning, and an unlock per domain, where each value appends
 * tools for this connection only (9 steps made 18 near-identical blocks). What
 * differs per step, the tools and their cost, goes in the detail. Mid-inserts
 * and removals stay per step: each is its own change. Edits merge only when the
 * tool, the changed values and their origin are the same: one cause.
 */
const REPEATS = ['session/side-effect', 'session/append', 'session/connection-local'];
export function mergeRepeats(raw: Raw[]): Raw[] {
  let out = raw;
  for (const rule of REPEATS) {
    const same = out.filter((f) => f.rule === rule);
    if (same.length < 2) continue;
    const steps = same.map((f) => f.step!);
    const lead = rule === 'session/side-effect' ? `Steps ${steps.join(', ')}` : stepsText(steps).replace(/^s/, 'S');
    let message = `${lead}: ${same[0].message}`;
    let detail = same[0].detail;
    if (rule === 'session/append') {
      const added = same.reduce((n, f) => n + Number(/^\+(\d+)/.exec(f.message)?.[1] ?? 0), 0);
      message = `${lead}: +${added} tools appended at the end of the list, over ${same.length} steps.${APPEND_WHY}`;
      const each = same.map((f) => f.each!).filter(Boolean);
      const why = [...new Set(same.flatMap((f) => (f.detail ?? []).filter((d) => !d.endsWith('new tokens (estimate)'))))];
      detail = [...each, ...why];
    }
    const merged: Raw = { ...same[0], message, steps, ...(detail ? { detail } : {}) };
    out = out.filter((f) => f.rule !== rule || f === same[0]).map((f) => (f === same[0] ? merged : f));
  }
  // The same edit at several steps is one cause: one finding naming the steps,
  // with each step's position and cost.
  const byCause = new Map<string, Raw[]>();
  for (const f of out) if (f.rule === 'session/edit' && f.cause) byCause.set(f.cause, [...(byCause.get(f.cause) ?? []), f]);
  for (const same of byCause.values()) {
    if (same.length < 2) continue;
    const steps = same.map((f) => f.step!);
    // The per-step value and cost are in each step's line; keep the rest (the origin) once.
    const why = [...new Set(same.flatMap((f) => (f.detail ?? []).filter((d) => !d.startsWith('cost: ') && !f.each!.endsWith(` · ${d}`))))];
    const merged: Raw = { ...same[0], steps, message: `${stepsText(steps).replace(/^s/, 'S')}: ${same[0].message}`, detail: [...same.map((f) => f.each!), ...why] };
    out = out.filter((f) => !same.includes(f) || f === same[0]).map((f) => (f === same[0] ? merged : f));
  }
  return out;
}

function describe(changes: ToolChange[]): string[] {
  return changes.slice(0, 8).map((c) => `${c.kind}: ${c.tool} (position ${c.position})`).concat(changes.length > 8 ? [`…and ${changes.length - 8} more`] : []);
}

function settle(raw: Raw[], options: SessionOptions): Finding[] {
  const ignore = (options.ignore ?? []).map((g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
  return raw
    .filter((f) => options.rules?.[f.rule] !== 'off' && !(f.tool && ignore.some((re) => re.test(f.tool!))))
    .map(({ each: _each, cause: _cause, ...f }) => ({ ...f, severity: (options.rules?.[f.rule] as Severity | undefined) ?? f.severity }))
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
// "exposes"/"adds" aren't: a lookup's text uses them for what it lists.
const UNLOCK_SAYS = /\b(?:unlock|enable|activate|load)s?\b[^.]{0,60}\b(?:tools?|toolsets?|capabilit(?:y|ies))\b/i;

/**
 * Does the tool say that `param` unlocks tools? Its name does, or a sentence of
 * its description that says it unlocks tools and doesn't pin that on another
 * parameter ("A query match also enables the tools…" is about `query`, not the
 * `domain` filter next to it).
 */
function claimsUnlock(tool: MenuTool, param: string | undefined): boolean {
  if (UNLOCK_NAME.test(tool.name)) return true;
  const stem = (p: string) => p.toLowerCase().replace(/_?ids?$/, '').replace(/(?:ies)$/, 'y').replace(/s$/, '');
  const mentions = (sentence: string, p: string) => stem(p).length > 1 && new RegExp(`\\b${stem(p).replace(/[^a-z0-9]/g, '.?')}`, 'i').test(sentence);
  const others = Object.keys(tool.inputSchema?.properties ?? {}).filter((p) => p !== param);
  return (tool.description ?? '')
    .split(/(?<=[.!?])\s+/)
    .filter((s) => UNLOCK_SAYS.test(s))
    .some((s) => (param && mentions(s, param)) || !others.some((p) => mentions(s, p)));
}
const LOOKUPS = new Set([...LOOKUP_VERBS, 'describe']);

interface Unlocker {
  tool: MenuTool;
  score: number;
  /** The parameter that names what to unlock, if there is one. */
  param?: string;
  /** Values to try for it, from the schema's enum. */
  values: unknown[];
  /** Its name or description says it unlocks tools (for this parameter); otherwise a guess from its schema. */
  claims: boolean;
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
    const lookup = verb !== undefined && LOOKUPS.has(verb);
    if (lookup && !UNLOCK_SAYS.test(description)) continue;
    const backed = UNLOCK_NAME.test(tool.name) || UNLOCK_DESC.test(description);
    const required = tool.inputSchema?.required ?? [];
    const param =
      Object.keys(props).find((p) => UNLOCK_PARAM.test(p)) ??
      (backed ? Object.keys(props).find((p) => WEAK_UNLOCK_PARAM.test(p)) : undefined) ??
      // Named like an unlock, one required parameter: that's what it takes
      // (toolception's enable_toolset { name }).
      (UNLOCK_NAME.test(tool.name) && required.length === 1 ? required[0] : undefined);
    const claims = claimsUnlock(tool, param);
    // A lookup that says a *different* parameter unlocks: its enum is a filter.
    if (lookup && !claims) continue;
    let score = 0;
    if (param) score += enumOf(props[param]).length ? 3 : 2;
    if (UNLOCK_NAME.test(tool.name)) score += 2;
    if (UNLOCK_DESC.test(tool.description ?? '')) score += 1;
    if (score >= 2) found.push({ tool, score, param, values: param ? enumOf(props[param]) : [], claims });
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
