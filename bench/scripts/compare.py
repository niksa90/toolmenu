"""Compare two toolmenu runs over a corpus, server by server.

usage: python3 -I compare.py <outdir> <before.json> <after.json> [snapshot|session]

Each server folder in <outdir> holds the --json output of both runs under those
names. Prints every server whose findings (by severity and rule), token total, tool
count or, for session, steps and their outcomes, differ.
"""
import collections, glob, json, os, sys

out, before, after = sys.argv[1], sys.argv[2], sys.argv[3]
mode = sys.argv[4] if len(sys.argv) > 4 else 'snapshot'

def load(p):
    try:
        return json.load(open(p))
    except Exception:
        return None

key = lambda d: collections.Counter((f['severity'], f['rule']) for f in d.get('findings', []))
tools = lambda d: d['tools'] if isinstance(d.get('tools'), int) else len(d.get('tools') or [])
steps = lambda d: [(s['label'][:40], s.get('outcome')) for s in d.get('steps', [])]

n, diff = 0, []
for d in sorted(glob.glob(os.path.join(out, '*'))):
    a, b = load(os.path.join(d, before)), load(os.path.join(d, after))
    if a is None and b is None:
        continue
    if not a or not b:
        diff.append((os.path.basename(d), 'unreadable', bool(a), bool(b)))
        continue
    n += 1
    if mode == 'session':
        if key(a) != key(b) or steps(a) != steps(b):
            diff.append((os.path.basename(d), dict(key(a) - key(b)), dict(key(b) - key(a)), [(x, y) for x, y in zip(steps(a), steps(b)) if x != y][:3]))
    elif key(a) != key(b) or a.get('totalTokens') != b.get('totalTokens') or tools(a) != tools(b):
        diff.append((os.path.basename(d), dict(key(a) - key(b)), dict(key(b) - key(a))))
print(f'{mode} compared {n}')
for x in diff:
    print(' ', x)
