# usage: python3 -I bench/scripts/registry-http.py > remotes.tsv
# Every hosted (streamable-http) remote in the MCP registry, latest version, one per URL.
# Writes id<TAB>url<TAB>needs_headers(yes/no)<TAB>registry name.
import json, urllib.request, urllib.parse, re, sys
seen, rows, cursor = set(), [], None
while True:
    q = {'limit': '100', 'version': 'latest'}
    if cursor: q['cursor'] = cursor
    with urllib.request.urlopen('https://registry.modelcontextprotocol.io/v0/servers?' + urllib.parse.urlencode(q), timeout=60) as r:
        d = json.load(r)
    for item in d['servers']:
        s = item['server']
        for rem in s.get('remotes') or []:
            if rem.get('type') != 'streamable-http': continue
            url = rem.get('url', '')
            if not url.startswith('https://') or '{' in url or url in seen: continue
            seen.add(url)
            needs = any(h.get('isRequired') for h in rem.get('headers') or [])
            rows.append((re.sub(r'[^A-Za-z0-9._-]', '_', s['name'])[:80], url, 'yes' if needs else 'no', s['name']))
    cursor = d.get('metadata', {}).get('nextCursor')
    if not cursor: break
for r in rows: print('\t'.join(r))
print(len(rows), 'remotes,', sum(r[2] == 'no' for r in rows), 'without required headers', file=sys.stderr)
