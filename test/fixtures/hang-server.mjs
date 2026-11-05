// A stdio server that never answers and ignores SIGTERM, for stopping toolmenu mcp's
// runs. Writes its pid and its parent's argv (the toolmenu CLI's) to PID_FILE.
import { readFileSync, writeFileSync } from 'node:fs';

let parentArgs = [];
try {
  parentArgs = readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0');
} catch {
  // Not Linux.
}
writeFileSync(process.env.PID_FILE, JSON.stringify({ pid: process.pid, parentArgs, secret: process.env.SECRET }));
process.on('SIGTERM', () => {});
process.stdin.resume();
setInterval(() => {}, 1 << 30);
