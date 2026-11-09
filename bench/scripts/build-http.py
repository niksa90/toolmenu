# usage: python3 -I bench/scripts/build-http.py <batch-http outdir> <dataset dir> [panel.tsv]
# The results of bench/scripts/batch-http.sh as a dataset:
#   servers.tsv     one row per URL: name, auth (open / oauth / other), tools, tokens,
#                   menu hash, calls and answers, findings by level, review verdict;
#   findings.jsonl  every finding, auth check's included, with a kind;
#   menus/          the menu files of the first <keep> rows of the panel (the vendors),
#                   for next week's review; the rest are compared by hash and tool names.
import hashlib, json, os, sys, collections

OUT, DATASET = sys.argv[1], sys.argv[2]
PANEL = sys.argv[3] if len(sys.argv) > 3 else None
KEEP = int(os.environ.get('KEEP_MENUS', '109'))
KIND = {'auth/discovery': 'spec', 'auth/resource-metadata': 'spec', 'auth/server-metadata': 'spec', 'auth/pkce': 'spec', 'auth/registration': 'heuristic'}
def kinds():
    # The kind map lives in build-results.py; read it without running that script.
    src = open(os.path.join(os.path.dirname(__file__), 'build-results.py')).read()
    start = src.index('KIND = {')
    end = src.index('}\n', start) + 1
    scope = {}
    exec(src[start:end], scope)
    return scope['KIND']


KIND.update(kinds())


def load(path):
    try:
        with open(path) as h:
            return json.load(h)
    except Exception:
        return None


def folder(url):
    return ''.join(c if c.isalnum() or c in '._-' else '_' for c in url.removeprefix('https://'))


order = [line.rstrip('\n').split('\t') for line in open(PANEL)] if PANEL else []
keep = {u for _, u in order[:KEEP]}
os.makedirs(os.path.join(DATASET, 'menus'), exist_ok=True)
rows, findings = [], []
dirs = [os.path.join(OUT, folder(u)) for _, u in order] if order else [os.path.join(OUT, d) for d in sorted(os.listdir(OUT)) if os.path.isdir(os.path.join(OUT, d))]
for d in dirs:
    if not os.path.isdir(d):
        continue
    url = open(os.path.join(d, 'url.txt')).read().strip()
    name = open(os.path.join(d, 'name.txt')).read().strip() if os.path.exists(os.path.join(d, 'name.txt')) else url
    auth, snap, sess, rev = (load(os.path.join(d, f)) for f in ('auth.json', 'snapshot.json', 'session.json', 'review.json'))
    menu = load(os.path.join(d, 'menu.json'))
    status = (auth or {}).get('status')
    mode = 'open' if snap and snap.get('tools') else 'oauth' if status == 401 and (auth or {}).get('metadataUrl') else 'auth' if status == 401 else 'unreachable'
    fs = [(f, 'auth') for f in (auth or {}).get('findings', []) if status == 401]
    fs += [(f, 'snapshot') for f in (snap or {}).get('findings', [])] + [(f, 'session') for f in (sess or {}).get('findings', [])]
    for f, cmd in fs:
        findings.append({'url': url, 'name': name, 'command': cmd, 'rule': f['rule'], 'kind': KIND.get(f['rule'], 'other'), 'severity': f['severity'],
                         **({'tool': f['tool']} if f.get('tool') else {}), 'message': f['message'], **({'detail': f['detail'][:5]} if f.get('detail') else {})})
    tools = sorted(t['name'] for t in (menu or {}).get('tools', []))
    digest = hashlib.sha256(json.dumps((menu or {}).get('tools', []), sort_keys=True).encode()).hexdigest()[:16] if menu else ''
    calls = [x for x in (sess or {}).get('steps', []) if x['label'].startswith('call ')]
    c = collections.Counter(f['severity'] for f, _ in fs)
    rows.append({'url': url, 'name': name, 'mode': mode, 'protocol': ((snap or {}).get('server') or {}).get('protocolVersion', ''), 'tools': len(tools),
                 'tokens': (snap or {}).get('totalTokens', 0), 'menu_hash': digest, 'tool_names': ','.join(tools), 'calls': len(calls),
                 'answered': sum(x.get('outcome') == 'answered' for x in calls), 'error': c['error'], 'warn': c['warn'], 'info': c['info'],
                 'review': (rev or {}).get('verdict', '')})
    if url in keep and menu:
        with open(os.path.join(DATASET, 'menus', folder(url) + '.json'), 'w') as h:
            json.dump(menu, h, indent=1)

cols = ['url', 'name', 'mode', 'protocol', 'tools', 'tokens', 'menu_hash', 'calls', 'answered', 'error', 'warn', 'info', 'review', 'tool_names']
with open(os.path.join(DATASET, 'servers.tsv'), 'w') as h:
    h.write('\t'.join(cols) + '\n')
    for r in rows:
        h.write('\t'.join(str(r[k]) for k in cols) + '\n')
with open(os.path.join(DATASET, 'findings.jsonl'), 'w') as h:
    for f in findings:
        h.write(json.dumps(f, ensure_ascii=False) + '\n')
modes = collections.Counter(r['mode'] for r in rows)
print(json.dumps({'servers': len(rows), 'modes': dict(modes), 'open_tools': sum(r['tools'] for r in rows), 'findings': len(findings)}))
