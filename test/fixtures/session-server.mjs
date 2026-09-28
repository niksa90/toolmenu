// A server whose menu changes mid-session, the way an "unlock" pattern does.
// unlock_toolset: audits → reveals two hidden tools in the middle of the list
//                 reports → registers a new tool at the end
// touch_descriptions → rewrites get_form's description
// Serves 2026-07-28 via serveStdio, or only the 2025 protocol when LEGACY=1.
// build(shared) keeps the unlock state in `shared` instead of the instance, so
// every connection (and every stateless HTTP request) sees it: a global change.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const ro = { readOnlyHint: true };

export function build(shared) {
  const state = shared ?? {};
  const server = new McpServer({ name: 'session-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  server.registerTool('search_forms', { description: 'Search forms by title. Returns form_id for each.', inputSchema: { query: z.string() }, annotations: ro }, async () => text('[]'));
  const audits = [
    server.registerTool('list_team_audits', { description: 'List the audits a team has done.', inputSchema: { team: z.string() }, annotations: ro }, async () => text('[]')),
    server.registerTool('get_team_audit', { description: 'Get one team audit.', inputSchema: { team_audit_id: z.string() }, annotations: ro }, async () => text('{}')),
  ];
  if (!state.audits) for (const t of audits) t.disable();
  const getForm = server.registerTool('get_form', { description: state.touched ? `Get one form by form_id. Updated at ${state.touched}.` : 'Get one form by form_id.', inputSchema: { form_id: z.string() }, annotations: ro }, async ({ form_id }) =>
    form_id === 'expired' ? { isError: true, content: [{ type: 'text', text: '401 Unauthorized: token expired' }] } : text('{}'));
  const addReports = () => server.registerTool('export_report', { description: 'Export a report as CSV.', inputSchema: { report_id: z.string() }, annotations: ro }, async () => text(''));
  server.registerTool(
    'unlock_toolset',
    { description: 'Unlock more tools: "audits" or "reports".', inputSchema: { toolset: z.enum(['audits', 'reports']) }, annotations: ro },
    async ({ toolset }) => {
      if (toolset === 'audits') {
        state.audits = true;
        for (const t of audits) t.enable();
      } else if (!state.reports) {
        state.reports = true;
        addReports();
      }
      return text(`unlocked ${toolset}`);
    },
  );
  server.registerTool('touch_descriptions', { description: 'Rewrites a description (a test hook).', inputSchema: {}, annotations: ro }, async () => {
    state.touched = Date.now();
    getForm.update({ description: `Get one form by form_id. Updated at ${state.touched}.` });
    return text('ok');
  });
  server.registerTool('delete_form', { description: 'Delete a form.', inputSchema: { form_id: z.string(), dry_run: z.boolean().optional() }, annotations: { destructiveHint: true } }, async () => text('ok'));
  if (shared?.reports) addReports();
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.env.LEGACY) await build().connect(new StdioServerTransport());
  else serveStdio(build);
}
