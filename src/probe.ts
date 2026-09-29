import { basename } from 'node:path';
import { connect, listTools, type Connection, type Target } from './connect.js';
import { compareMenus } from './compare.js';
import { buildMenu } from './menu.js';
import { patiently, tooMany } from './failures.js';
import type { Probe } from './rules/determinism.js';
import type { Menu, MenuTool } from './types.js';

/**
 * The hash seed of the process whose menu toolmenu saves and compares. Python
 * orders sets of strings by a per-process random seed; pinning it makes a Python
 * server's saved menu the same on every run (FINDINGS F12: mcp-atlassian).
 */
export const MAIN_SEED = '0';
/** The probe's seed: different from the main one, so a set-order bug shows every time. */
export const PROBE_SEED = '1';

/**
 * The target with PYTHONHASHSEED set, unless the user set it (--env) or it isn't
 * a stdio server. Other runtimes ignore it.
 */
export function seeded(target: Target, seed: string): Target {
  if (target.kind !== 'stdio' || target.env?.PYTHONHASHSEED !== undefined) return target;
  return { ...target, env: { ...target.env, PYTHONHASHSEED: seed } };
}

/** A command that starts the server in a container: the seed (and --env) don't reach it unless passed through. */
export function isContainerWrapper(target: Target): boolean {
  return target.kind === 'stdio' && /^(docker|podman|nerdctl)(\.exe)?$/.test(basename(target.command));
}

/**
 * A connection still refused for being too many requests after the waits, said as
 * that and what to do about it, not as the transport's error. Anything else as is.
 */
export function refusedForTooMany(error: unknown, waitedMs: number): unknown {
  if (!tooMany(error)) return error;
  const text = error instanceof Error ? error.message.split('\n')[0].replace(/^.*?endpoint:\s*/i, '') : String(error);
  const said = text.length > 100 ? `${text.slice(0, 99)}…` : text;
  const seconds = waitedMs < 10_000 ? Math.round(waitedMs / 100) / 10 : Math.round(waitedMs / 1000);
  return new Error(`The server refused toolmenu's connection for being too many requests (“${said}”) and still refused after it waited ${seconds} s. A rate limit counts toolmenu's requests together with everything else from this address: give the run its own server instance, or raise the limit for it.`);
}

/** connect, with a refusal for being too many waited out (connecting is read-only). */
export async function connectPatiently(target: Target, options: { timeoutMs?: number; waits?: number[] } = {}): Promise<Connection> {
  const waited = { ms: 0 };
  try {
    return await patiently(() => connect(target, { timeoutMs: options.timeoutMs }), { waits: options.waits, error: tooMany, waited });
  } catch (error) {
    throw refusedForTooMany(error, waited.ms);
  }
}

/** The menu a fresh process (stdio) or connection (HTTP) serves: connect, list once, close. */
export async function probeMenu(target: Target, timeoutMs: number, waits?: number[], waited?: { ms: number }): Promise<Menu> {
  // Read-only: a refusal for being too many is waited out and the probe sent again.
  return patiently(
    async () => {
      const c = await connect(target, { timeoutMs });
      try {
        const list = await listTools(c, { timeoutMs });
        return buildMenu(list.tools, { name: c.server.name, version: c.server.version, protocolVersion: c.protocolVersion, era: c.era });
      } finally {
        await c.close().catch(() => {});
      }
    },
    { waits, error: tooMany, waited },
  );
}

/**
 * Menus from `processes - 1` fresh processes (stdio) or connections (HTTP), to
 * compare with the main one. stdio probes run with a different hash seed each. An
 * HTTP probe that differs is retried once: a rolling deploy can serve two
 * versions for a moment.
 */
export async function probeVariance(target: Target, main: MenuTool[], processes: number, timeoutMs: number, waits?: number[]): Promise<Probe[]> {
  const probes: Probe[] = [];
  for (let i = 0; i < processes - 1; i++) {
    const seed = String(Number(PROBE_SEED) + i);
    try {
      let tools = (await probeMenu(seeded(target, seed), timeoutMs, waits)).tools;
      if (target.kind === 'http' && compareMenus(main, tools).length) tools = (await probeMenu(target, timeoutMs, waits)).tools;
      probes.push({ tools });
    } catch (error) {
      probes.push({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  return probes;
}
