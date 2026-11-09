# usage: python3 -I bench/scripts/registry-stdio.py <exclude-file> > list.tsv
# npm stdio servers from the MCP registry: latest version, no required env vars or
# arguments, none whose package@ appears in <exclude-file> (earlier corpora; /dev/null for
# none), in a seeded random order. Writes id<TAB>pkg@ver<TAB>repo.
import json, sys, urllib.request, urllib.parse, re, random
corpus = open(sys.argv[1]).read()
seen, rows, cursor = set(), [], None
while True:
    q = {'limit': '100', 'version': 'latest'}
    if cursor: q['cursor'] = cursor
    with urllib.request.urlopen('https://registry.modelcontextprotocol.io/v0/servers?' + urllib.parse.urlencode(q), timeout=60) as r:
        d = json.load(r)
    for item in d['servers']:
        s = item['server']
        for p in s.get('packages') or []:
            if p.get('registryType') != 'npm' or (p.get('transport') or {}).get('type') != 'stdio': continue
            if any(e.get('isRequired') for e in p.get('environmentVariables') or []): continue
            if any(a.get('isRequired') for a in (p.get('packageArguments') or []) + (p.get('runtimeArguments') or [])): continue
            name, ver = p.get('identifier'), p.get('version')
            if not name or not ver or name in seen or re.search(r'(^|[\s@/])' + re.escape(name) + r'@', corpus): continue
            seen.add(name)
            repo = (s.get('repository') or {}).get('url', '')
            rows.append((re.sub(r'[^A-Za-z0-9._-]', '_', name), f'{name}@{ver}', repo))
    cursor = d.get('metadata', {}).get('nextCursor')
    if not cursor: break
print(len(rows), file=sys.stderr)
random.Random(20261109).shuffle(rows)
for r in rows: print('\t'.join(r))
