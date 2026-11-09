# usage: python3 -I bench/scripts/registry-stdio.py <exclude-file> > list.tsv
# npm stdio servers from the MCP registry: latest version, no required arguments, none
# whose package@ appears in <exclude-file> (earlier corpora; /dev/null for none), in a
# seeded random order. Writes id<TAB>pkg@ver<TAB>repo<TAB>KEY=value pairs: each env var the
# registry marks required gets a dummy value that fits its name (batch-full.sh sets them),
# so servers that need a key start and say how they meet a key that opens nothing.
import json, sys, urllib.request, urllib.parse, re, random
corpus = open(sys.argv[1]).read()


def dummy(name):
    """A dummy value that fits a setting's name, so a server that checks the format starts."""
    n = name.upper()
    if re.search(r'TRANSPORT', n): return 'stdio'
    if re.search(r'(^|_)PORT($|_)', n): return '9'
    if re.search(r'REGION', n): return 'us-east-1'
    if re.search(r'(^|_)(ALLOW|ENABLE|ENABLED|USE|READ_?ONLY|DEBUG|VERBOSE)($|_)', n): return 'true'
    if re.search(r'TIMEOUT|LIMIT|SIZE|COUNT|(^|_)MAX($|_)|SECONDS|(^|_)MS($|_)', n): return '30'
    if re.search(r'PATH|DIR|FOLDER|ROOT', n): return '/tmp'
    if re.search(r'URL|URI|ENDPOINT|HOST|(^|_)BASE($|_)|SERVER|ADDR', n): return 'http://localhost:9'
    return 'toolmenu'


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
            if any(a.get('isRequired') for a in (p.get('packageArguments') or []) + (p.get('runtimeArguments') or [])): continue
            name, ver = p.get('identifier'), p.get('version')
            if not name or not ver or name in seen or re.search(r'(^|[\s@/])' + re.escape(name) + r'@', corpus): continue
            seen.add(name)
            repo = (s.get('repository') or {}).get('url', '')
            env = ' '.join(f"{e['name']}={dummy(e['name'])}" for e in p.get('environmentVariables') or [] if e.get('isRequired') and e.get('name') and re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', e['name']))
            rows.append((re.sub(r'[^A-Za-z0-9._-]', '_', name), f'{name}@{ver}', repo, env))
    cursor = d.get('metadata', {}).get('nextCursor')
    if not cursor: break
print(len(rows), file=sys.stderr)
random.Random(20261109).shuffle(rows)
for r in rows: print('\t'.join(r).rstrip('\t'))
