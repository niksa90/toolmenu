import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../dist/failures.js';

// Real error texts from servers run with dummy credentials (FINDINGS F12).
test('classifyFailure on real servers\' errors', () => {
  const cases = [
    ['auth', 'failed to get user: GET https://api.github.com/user: 401 Bad credentials []'],
    ['auth', '**Authorization Expired** Sentry rejected the stored access token for this session. Please re-authorize to continue.'],
    ['auth', "Tool 'firecrawl_monitor_list' execution failed: Unauthorized: Invalid token"],
    ['auth', 'Error calling tool "search-actors": User was not found or authentication token is not valid'],
    ['auth', '{"error":{"name":"Error","message":"Unauthorized. Please provide a valid access token to the MCP server'],
    ['environment', "Could not find Google Chrome executable for channel 'stable' at: - /opt/google/chrome/chrome."],
    ['environment', "Error: async initializeServer: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome"],
    ['invalid-arguments', "Error calling tool 'get_page': Either 'page_id' OR both 'title' and 'space_key' must be provided."],
    ['invalid-arguments', '**Input Error** It looks like there was a problem with the input you provided.'],
    ['network', 'fetch failed: connect ECONNREFUSED 127.0.0.1:443'],
    ['other', "Error calling tool 'get_link_types': HTTPError"],
    ['other', 'The token field must be a string'],
  ];
  for (const [want, text] of cases) assert.equal(classifyFailure(text), want, text);
  assert.equal(classifyFailure('anything', { code: -32602 }), 'invalid-arguments');
  // A 404 on a call that named nothing is the account behind the key (HubSpot); with an ID, it's the ID.
  const hubspot = 'Error retrieving token, owner, and account information. HubSpot API Error: 404 Not Found - {}';
  assert.equal(classifyFailure(hubspot, { hadArguments: false }), 'not-found');
  assert.equal(classifyFailure('Issue 404 Not Found', { hadArguments: true }), 'other');
});
