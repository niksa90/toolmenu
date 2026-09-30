// A stdio "server" that fails the way real ones do. MODE:
//   stray    prints a log line to stdout, never answers (logging to stdout)
//   silent   never answers
//   crash    one stderr line, exit 3
//   longerr  300 lines of noise on stderr, the real error last, exit 1
//   signal   killed by SIGKILL
//   missing  a Node "Cannot find module" crash
//   rpcerror answers initialize with its own error, whose words say "timed out"
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
  for (let i = 1; i <= 300; i++) console.error(`header-${i}: some-long-value`);
  console.error('Error: the real reason, at the end');
  process.exit(1);
} else if (mode === 'signal') {
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'missing') {
  console.error("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/node_modules/left-pad/index.js'");
  process.exit(1);
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
