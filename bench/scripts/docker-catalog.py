# usage: python3 -I bench/scripts/docker-catalog.py <catalog.yaml> > list.tsv
# Docker's MCP catalog (https://desktop.docker.com/mcp/catalog/v3/catalog.yaml, what the
# Docker MCP Toolkit installs from) as a batch-image.sh list: every local server ("type:
# server"; remotes and POCIs aside), its image pinned to the catalog's digest, each secret
# and setting it declares given a dummy value, and the catalog's own arguments. Sorted by
# pulls, most first. Columns: id, image@digest, source repo, KEY=value pairs, arguments,
# pulls.
import re, sys
import yaml

cat = yaml.safe_load(open(sys.argv[1]))['registry']


def dummy(name):
    n = name.upper()
    if re.search(r'URL|URI|ENDPOINT|HOST|BASE|SERVER|ADDR', n):
        return 'http://localhost:9'
    if re.search(r'PORT', n):
        return '9'
    if re.search(r'PATH|DIR|FOLDER|ROOT', n):
        return '/tmp'
    return 'toolmenu'


def fill(text):
    # {{server.property}} templates: a dummy that fits the property's name.
    return re.sub(r'\{\{([^}|]+)(\|[^}]*)?\}\}', lambda m: dummy(m.group(1).split('.')[-1]), str(text))


rows = []
for name, s in cat.items():
    if s.get('type') != 'server' or not s.get('image'):
        continue
    env = {}
    for sec in s.get('secrets') or []:
        if sec.get('env'):
            env[sec['env']] = dummy(sec['env'])
    for e in s.get('env') or []:
        if e.get('name'):
            env[e['name']] = fill(e.get('value')) if e.get('value') not in (None, '') else dummy(e['name'])
    args = ' '.join(fill(a) for a in s.get('command') or [])
    if any(re.search(r'\s', v) for v in env.values()):
        env = {k: re.sub(r'\s+', '_', v) for k, v in env.items()}
    pulls = (s.get('metadata') or {}).get('pulls', 0)
    rows.append((pulls, f'dc_{re.sub(r"[^A-Za-z0-9._-]", "_", name)}', s['image'], s.get('upstream') or s.get('source') or '', ' '.join(f'{k}={v}' for k, v in env.items()), args))
for pulls, *cols in sorted(rows, key=lambda r: -r[0]):
    print('\t'.join(cols + [str(pulls)]))
