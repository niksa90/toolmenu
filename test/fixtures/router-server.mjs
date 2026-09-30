// A stdio server whose operations sit behind command routers, like Azure's
// namespace mode: each router takes { intent, command, parameters, learn } and
// lists its commands (prose, then JSON) when called with learn: true.
//
// ROUTER_VERSION=2 makes a breaking change to one command and drops another.
// CALL_LOG=<file>: every tools/call is appended as a JSON line, and any call that
// would run a command is logged with "executed": true, so tests can prove none did.
// PLAIN_WORDS=1: the descriptions don't say "router", so detection misses them.
// AUTH_FAIL=1: the "vault" router wants credentials before it lists anything.
// ANSWER=<router>:<how>,…: how a router answers learn: true. how is error (a plain
//   error), garbled (prose, no command list), empty (an empty list) or shared (its
//   commands plus a "list" the other router also has).
// ODD=1: two tools shaped oddly: "odd" (a required string args, a help flag) and
//   "twin" (a router that also requires a subcommand).
// DUPES=1: "vault" lists two commands with the same name, one command twice, and
//   one command twice with different schemas.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const v2 = process.env.ROUTER_VERSION === '2';
const str = (description) => ({ type: 'string', description });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

const routerSchema = (extraRequired = []) => ({
  type: 'object',
  properties: {
    intent: str('The intent of the operation to perform.'),
    command: str('The command to execute against the specified tool.'),
    parameters: { type: 'object', description: 'The parameters to pass to the tool command.' },
    learn: { type: 'boolean', description: process.env.PLAIN_WORDS ? 'Show help.' : 'To learn about the tool and its supported child tools and parameters.', default: false },
  },
  required: ['intent', ...extraRequired],
  additionalProperties: false,
});
const words = process.env.PLAIN_WORDS
  ? 'Work with them.'
  : 'This tool is a hierarchical MCP command router.\nSub commands are routed to MCP servers that require specific fields inside the "parameters" object.\nSet "learn=true" to discover available sub commands.';

const answers = Object.fromEntries((process.env.ANSWER ?? '').split(',').filter(Boolean).map((a) => a.split(':')));
const TOOLS = [
  { name: 'files', description: `Manage files. ${words}`, inputSchema: routerSchema(), annotations: { title: 'Files' } },
  { name: 'vault', description: `Manage secrets. ${words}`, inputSchema: routerSchema(), annotations: { title: 'Vault' } },
  // Looks like a router, but its command is required: never called.
  { name: 'locked', description: `Locked area. ${words}`, inputSchema: routerSchema(['command']) },
  ...(process.env.ODD
    ? [
        { name: 'odd', description: 'Odd area.', inputSchema: { type: 'object', properties: { command: str('The command.'), args: str('Its arguments, as text.'), help: { type: 'boolean' } }, required: ['args'] } },
        { name: 'twin', description: `Twin area. ${words}`, inputSchema: { ...routerSchema(['subcommand']), properties: { ...routerSchema().properties, subcommand: str('The subcommand.') } } },
      ]
    : []),
  ...(answers.empty ? [{ name: 'empty', description: `Nothing yet. ${words}`, inputSchema: routerSchema() }] : []),
  { name: 'ping', description: 'Check the server is up.', inputSchema: obj({}), annotations: { readOnlyHint: true } },
];

const COMMANDS = {
  files: [
    { command: 'files_list', description: 'List files in a folder.', inputSchema: obj({ folder: str('The folder.') }) },
    { command: 'files_delete', description: 'Delete a file.', inputSchema: obj(v2 ? { path: str('The file.'), force: { type: 'boolean' } } : { path: str('The file.') }) },
    ...(v2 ? [] : [{ command: 'files_copy', description: 'Copy a file.', inputSchema: obj({ from: str('Source.'), to: str('Target.') }) }]),
  ],
  vault: [
    { command: 'vault_secret_get', description: 'Get a secret.', inputSchema: obj({ name: str('The secret.') }) },
    { command: 'vault_secret_set', description: 'Set a secret.', inputSchema: obj({ name: str('The secret.'), value: str('The value.') }) },
  ],
};

const listing = { name: 'list', description: 'List things.', inputSchema: obj({}) };
if (process.env.DUPES) {
  COMMANDS.vault.push(
    { name: 'list', command: 'vault secret list', description: 'List secrets.', inputSchema: obj({}) },
    { name: 'list', command: 'vault key list', description: 'List keys.', inputSchema: obj({}) },
    { command: 'vault_purge', description: 'Purge.', inputSchema: obj({ name: str('The secret.') }) },
    { command: 'vault_purge', description: 'Purge.', inputSchema: obj({ name: str('The secret.') }) },
    { command: 'vault_rotate', description: 'Rotate a secret.', inputSchema: obj({ name: str('The secret.') }) },
    { command: 'vault_rotate', description: 'Rotate a key.', inputSchema: obj({ key: str('The key.') }) },
  );
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function call(name, args = {}) {
  const runs = args.learn !== true && (args.command !== undefined || args.parameters !== undefined);
  if (process.env.CALL_LOG) appendFileSync(process.env.CALL_LOG, JSON.stringify({ name, arguments: args, executed: runs }) + '\n');
  if (name === 'ping') return text('pong');
  if (!(name in COMMANDS) && name !== 'locked' && !(name in answers) && name !== 'odd' && name !== 'twin') return text(`Unknown tool ${name}`, true);
  if (name === 'vault' && process.env.AUTH_FAIL) return text("Failed to create MCP client for registry server 'vault': The ChainedTokenCredential failed to retrieve a token from the included credentials.", true);
  if (answers[name] === 'error' && args.learn === true) return text('Something broke on our side.', true);
  if (answers[name] === 'garbled' && args.learn === true) return text('Commands: see the docs.');
  if (args.learn === true) {
    const list = answers[name] === 'empty' ? [] : [...(COMMANDS[name] ?? []), ...(answers[name] === 'shared' ? [listing] : [])];
    return text(`Here are the available commands and their input schema for '${name}' tool.\nIdentify the command you want to execute and run again with the "command" and "parameters" arguments.\n\n${JSON.stringify(list)}`);
  }
  if (runs) return text(`Ran ${args.command}.`);
  return text('Set learn=true to discover available sub commands.', true);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'router-fixture', version: v2 ? '2.0.0' : '1.0.0' } } });
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools: TOOLS } });
  else if (msg.method === 'tools/call') send({ id: msg.id, result: call(msg.params?.name, msg.params?.arguments) });
  else send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
