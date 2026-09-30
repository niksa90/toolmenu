// A stdio "server" that fails the way real ones do. MODE:
//   stray    prints a log line to stdout, never answers (logging to stdout)
//   silent   never answers
//   crash    one stderr line, exit 3
//   longerr  300 lines of noise on stderr, the real error last, exit 1
//   signal   killed by SIGKILL
//   missing  a Node "Cannot find module" crash
//   badkey   logs a rejected API key (401) on stderr, never answers
//   badkeyexit logs a rejected API key on stderr, exit 1
//   listcrash answers initialize, then on tools/list logs 300 lines, the reason last, and exits 1
//   rpcerror answers initialize with its own error, whose words say "timed out"
import { writeSync } from 'node:fs';

// Long stderr goes out in one synchronous write: console.error to a pipe can still be
// queued when process.exit() runs, and a loaded machine then loses the last lines.
const mode = process.env.MODE;
if (mode === 'stray') {
  process.stdout.write('hello I am not json\nServer listening on stdio\n');
  setInterval(() => {}, 1000);
} else if (mode === 'silent') {
  setInterval(() => {}, 1000);
} else if (mode === 'crash') {
  console.error('boom: missing config');
  process.exit(3);
} else if (mode === 'longerr') {
  const lines = Array.from({ length: 300 }, (_, i) => `header-${i + 1}: some-long-value`);
  writeSync(2, `${lines.join('\n')}\nError: the real reason, at the end\n`);
  process.exit(1);
} else if (mode === 'badkey') {
  console.error('Error: Request failed with status 401 Unauthorized: {"error":{"type":"invalid_request_error","code":"invalid_api_key"}}');
  setInterval(() => {}, 1000);
} else if (mode === 'badkeyexit') {
  console.error('Starting server...');
  console.error('Error: status: 401, message: The supplied credentials do not pass authentication');
  process.exit(1);
} else if (mode === 'signal') {
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'missing') {
  console.error("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/node_modules/left-pad/index.js'");
  process.exit(1);
} else if (mode === 'listcrash') {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id === undefined) continue;
      if (message.method === 'initialize') {
        const result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'listcrash', version: '1.0.0' } };
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      } else if (message.method === 'tools/list') {
        const lines = Array.from({ length: 300 }, (_, i) => `trace-${i + 1}: some-long-value`);
        writeSync(2, `${lines.join('\n')}\nError: the tool registry failed to load\n`);
        process.exit(1);
      } else {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`);
      }
    }
  });
} else if (mode === 'rpcerror') {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id === undefined) continue;
      const error = message.method === 'initialize' ? { code: -32603, message: 'upstream API request timed out' } : { code: -32601, message: 'Method not found' };
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error })}\n`);
    }
  });
}
