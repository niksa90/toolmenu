// A server that does everything toolmenu checks for right: test/clean.test.mjs runs
// every command and option it can against it and expects no finding at any level.
// A rule that starts firing here is a false positive until shown otherwise.
//
// What it exercises, done right: reads, an additive write, an idempotent move and a
// destructive delete with a dry run, all annotated; IDs every tool that takes one can
// get from another tool; specific parameter names; short descriptions with the
// instruction first; a stable menu with cache hints; prompts, resources and a
// resource template. Serves 2026-07-28 via serveStdio, or only 2025 when LEGACY=1.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const NOTES = [{ note_id: 'n_1', folder_id: 'f_1', title: 'Welcome' }];
const FOLDERS = [{ folder_id: 'f_1', name: 'Inbox' }];

export function build() {
  const server = new McpServer(
    { name: 'clean-fixture', version: '1.0.0' },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      cacheHints: {
        'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
        'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
        'prompts/list': { ttlMs: 3_600_000, cacheScope: 'public' },
        'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
        'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
      },
    },
  );
  const read = { readOnlyHint: true, openWorldHint: false };
  server.registerTool('list_folders', { description: 'List folders. Returns folder_id and name for each.', inputSchema: {}, annotations: read }, async () => text(JSON.stringify(FOLDERS)));
  server.registerTool(
    'search_notes',
    { description: 'Search notes by title. Returns note_id, folder_id and title for each match.', inputSchema: { query: z.string().describe('Words to find in note titles') }, annotations: read },
    async () => text(JSON.stringify(NOTES)),
  );
  server.registerTool(
    'get_note',
    { description: 'Get one note by note_id (from search_notes).', inputSchema: { note_id: z.string().describe('The note_id search_notes returned') }, annotations: read },
    async () => text(JSON.stringify(NOTES[0])),
  );
  server.registerTool(
    'create_note',
    {
      description: 'Create a note in a folder. Returns the new note_id.',
      inputSchema: { folder_id: z.string().describe('The folder_id list_folders returned'), title: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => text(JSON.stringify({ note_id: 'n_2' })),
  );
  server.registerTool(
    'move_note',
    {
      description: 'Move a note to another folder. Moving it to the folder it is in changes nothing.',
      inputSchema: { note_id: z.string(), folder_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => text('moved'),
  );
  server.registerTool(
    'delete_note',
    {
      description: 'Delete a note for good. Call with dry_run: true first to see what would be deleted.',
      inputSchema: { note_id: z.string(), dry_run: z.boolean().optional().describe('Only say what would be deleted') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => text('deleted'),
  );
  server.registerPrompt('summarize_folder', { description: 'Summarize the notes in one folder.', argsSchema: { folder_id: z.string() } }, ({ folder_id }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Summarize the notes in folder ${folder_id}.` } }],
  }));
  server.registerResource('readme', 'notes://readme', { description: 'How notes are organised.', mimeType: 'text/plain' }, async (uri) => ({ contents: [{ uri: uri.href, text: 'Notes live in folders.' }] }));
  server.registerResource(
    'note',
    new ResourceTemplate('notes://note/{note_id}', { list: undefined }),
    { description: 'One note, by note_id.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, text: JSON.stringify(NOTES[0]) }] }),
  );
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.env.LEGACY) await build().connect(new StdioServerTransport());
  else serveStdio(build);
}
