/**
 * The environment variable toolmenu mcp passes credential arguments in (header and env
 * values), shared with the CLI. Its own module so the CLI doesn't load the server SDK.
 */
export const SECRET_ARGS_ENV = 'TOOLMENU_MCP_ARGS';
