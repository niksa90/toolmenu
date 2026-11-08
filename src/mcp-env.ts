/**
 * The environment variable toolmenu mcp passes credential arguments in (header and env
 * values), shared with the CLI. Its own module so the CLI doesn't load the server SDK.
 */
export const SECRET_ARGS_ENV = 'TOOLMENU_MCP_ARGS';

/**
 * The same, for anyone: a JSON array of arguments the CLI adds before "--", so
 * --header, --env and --client-secret values stay off the command line (which other
 * local users can read with ps). The Action passes its headers and env this way.
 */
export const ARGS_ENV = 'TOOLMENU_ARGS';
