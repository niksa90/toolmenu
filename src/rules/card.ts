import { CARD_MEDIA_TYPE, type CardRead } from '../card.js';
import { resultValidator } from './spec.js';
import { clip, type Rule, type RuleFinding } from './rule.js';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const trim = (u: string) => u.replace(/\/+$/, '');

/**
 * The Server Card at `<url>/server-card`, against the live connection. A server without
 * one is fine (cards are optional) and nothing is said. Name isn't compared: cards use
 * registry names (io.github.upstash/context7), serverInfo a display name (Context7).
 */
export const serverCard: Rule = {
  id: 'spec/server-card',
  severity: 'warn',
  summary: "The Server Card agrees with the live server: schema, version, protocol versions",
  run(ctx) {
    const read = ctx.serverCard;
    if (!read || !isObject(read.card)) return [];
    const card = read.card;
    // Only a card says it is one: its media type, or the Server Card schema in $schema.
    // A server that answers every path with JSON (an error object, a health check) has none.
    const typed = !!read.contentType?.toLowerCase().startsWith(CARD_MEDIA_TYPE);
    if (!typed && !(typeof card.$schema === 'string' && /server-card/i.test(card.$schema))) return [];
    const where = read.url;
    const out: RuleFinding[] = [];
    const validate = resultValidator('server-card', 'ServerCard');
    if (validate && !validate(card)) {
      const errors = (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '(the card)'} ${e.message ?? ''}`.trim());
      out.push({
        message: `The Server Card at ${where} doesn't match the Server Card schema, so clients that read cards before connecting may skip it or misread it: ${errors[0]}.`,
        ...(errors.length > 1 ? { detail: errors } : {}),
        fix: 'Fix the card against schema.json in modelcontextprotocol/ext-server-card.',
      });
    }
    const contradictions: string[] = [];
    const live = ctx.serverInfo?.version;
    if (typeof card.version === 'string' && live && card.version !== live) contradictions.push(`version: the card says ${clip(card.version, 60)}, the server ${clip(live, 60)}`);
    // The remote for the URL this run connected to; its protocol versions against the one negotiated.
    const remotes = Array.isArray(card.remotes) ? card.remotes.filter(isObject) : [];
    const mine = ctx.serverUrl ? remotes.find((r) => typeof r.url === 'string' && trim(r.url) === trim(ctx.serverUrl!)) : undefined;
    const versions = Array.isArray(mine?.supportedProtocolVersions) ? (mine!.supportedProtocolVersions as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
    // Not when this connection fell back to 2025 and a later one got 2026-07-28: the
    // negotiated version then isn't all the server speaks (spec/discover says why).
    if (versions?.length && ctx.protocolVersion && !ctx.laterModern && !versions.includes(ctx.protocolVersion)) {
      contradictions.push(`protocol: the card lists ${versions.join(', ')} for ${mine!.url}, the server negotiated ${ctx.protocolVersion}`);
    }
    if (contradictions.length) {
      out.push({
        message: `The Server Card at ${where} contradicts the live server (${contradictions.join('; ')}). Clients read the card before connecting, so they pick or configure the server by values it doesn't have; ext-server-card says the card SHOULD NOT contradict server/discover and serverInfo.`,
        ...(contradictions.length > 1 ? { detail: contradictions } : {}),
        fix: 'Build the card from the same values the server reports (its package version, the protocol versions the SDK serves), or update it with each release.',
      });
    }
    if (!typed) {
      out.push({
        severity: 'info',
        message: `The Server Card at ${where} is served as ${read.contentType ? clip(read.contentType, 60) : 'no content type'}, not ${CARD_MEDIA_TYPE}, which ext-server-card says servers SHOULD use.`,
        fix: `Serve it with Content-Type: ${CARD_MEDIA_TYPE}.`,
      });
    }
    return out;
  },
};
