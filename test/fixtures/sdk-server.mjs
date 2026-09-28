// A well-behaved server on the official SDK. Serves 2026-07-28 via serveStdio,
// or only the 2025 protocol when LEGACY=1.
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { build } from './forms.mjs';

if (process.env.LEGACY) {
  await build().connect(new StdioServerTransport());
} else {
  serveStdio(build);
}
