// A stdio "server" that fails the way real ones do. MODE:
//   stray    prints a log line to stdout, never answers (logging to stdout)
//   silent   never answers
//   crash    one stderr line, exit 3
//   longerr  300 lines of noise on stderr, the real error last, exit 1
//   signal   killed by SIGKILL
//   missing  a Node "Cannot find module" crash
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
}
