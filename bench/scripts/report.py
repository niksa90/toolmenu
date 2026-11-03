"""python3 -I report.py <list.tsv> <outdir>: snapshot + session summary."""
import collections, json, os, sys
lst, out = sys.argv[1], sys.argv[2]
rows = [l.rstrip('\n').split('\t') for l in open(lst)]
ok = 0; fail = collections.Counter(); rules = collections.Counter(); srules = collections.Counter(); changed = []; lines = []
def load(p):
    try: return json.load(open(p))
    except Exception: return None
for r in rows:
    sid, spec = r[0], r[1]; repo = r[2] if len(r) > 2 else ''
    d = os.path.join(out, sid); snap = load(os.path.join(d, 'out.json'))
    if not snap or 'findings' not in snap:
        why = 'install-failed' if not os.path.exists(os.path.join(d, 'bin.txt')) else ''
        if not why and os.path.exists(os.path.join(d, 'err.txt')):
            why = next((l.strip() for l in open(os.path.join(d, 'err.txt')) if l.strip()), 'no output')[:100]
        fail[why.split(':')[0][:60] or 'no output'] += 1; lines.append(f'  FAIL {spec:42} {why}'); continue
    ok += 1
    tools = snap['tools'] if isinstance(snap['tools'], int) else len(snap['tools'])
    for f in snap['findings']: rules[(f['severity'], f['rule'])] += 1
    bad = sorted({f"{f['severity'][0].upper()}:{f['rule']}" for f in snap['findings'] if f['severity'] in ('error', 'warn')})
    s = load(os.path.join(d, 'session.json')); stag = ''
    if s and 'steps' in s:
        for f in s.get('findings', []): srules[(f['severity'], f['rule'])] += 1
        if any(x.get('changed') for x in s['steps']) or s['baseline']['tools'] != s['final']['tools']:
            changed.append(spec); stag = ' MENU-CHANGED'
        sb = sorted({f"{f['severity'][0].upper()}:{f['rule']}" for f in s.get('findings', []) if f['severity'] == 'error' or f['rule'].startswith('session/mid') or f['rule'] in ('session/edit', 'session/remove', 'session/reorder')})
        stag += (' ' + ' '.join(sb)) if sb else ''
    lines.append(f"  {spec:42} {tools:4} tools {snap.get('totalTokens', 0):>8,} tok {' '.join(bad)}{stag}  {repo}")
print(f'servers {len(rows)}  snapshot ok {ok}  failed {sum(fail.values())}: {dict(fail.most_common(8))}')
print('snapshot findings:', ', '.join(f'{k[0]} {k[1]} {v}' for k, v in sorted(rules.items(), key=lambda x: -x[1])))
print('session findings:', ', '.join(f'{k[0]} {k[1]} {v}' for k, v in sorted(srules.items(), key=lambda x: -x[1])))
print('menus that changed mid-session:', changed or 'none')
print('\n'.join(lines))
