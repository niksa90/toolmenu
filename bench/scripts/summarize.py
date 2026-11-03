"""Summarize toolmenu snapshot results: python3 -I summarize.py <list.tsv> <outdir>"""
import collections, json, os, sys

lst, out = sys.argv[1], sys.argv[2]
repos = {}
for line in open(lst):
    a, b, c = line.rstrip('\n').split('\t')
    repos[a] = (b, c)

status = {}
for line in open(os.path.join(out, 'status-snapshot.txt')):
    code, sid = line.split()
    status[sid] = code

ok, broken = [], collections.Counter()
rules = collections.Counter()
rows = []
for sid, (spec, repo) in repos.items():
    code = status.get(sid, 'not-run')
    p = os.path.join(out, sid, 'out.json')
    data = None
    if os.path.exists(p):
        try:
            data = json.load(open(p))
        except Exception:
            data = None
    if not data or 'tools' not in data:
        reason = code
        err = os.path.join(out, sid, 'err.txt')
        if os.path.exists(err):
            first = next((l.strip() for l in open(err) if l.strip()), '')
            reason = f'{code}: {first[:110]}'
        broken[code] += 1
        rows.append((sid, spec, repo, None, None, [], reason))
        continue
    fs = data.get('findings', [])
    for f in fs:
        rules[(f.get('severity'), f.get('rule'))] += 1
    rows.append((sid, spec, repo, (data['tools'] if isinstance(data['tools'], int) else len(data['tools'])), data.get('totalTokens'), fs, ''))
    ok.append(sid)

print(f'servers: {len(repos)}  snapshotted: {len(ok)}  failed: {dict(broken)}')
print('\nfindings by rule (count of servers):')
for (sev, rule), n in sorted(rules.items(), key=lambda x: (-{'error': 3, 'warn': 2, 'info': 1}.get(x[0][0], 0), -x[1])):
    print(f'  {sev:5} {rule:40} {n}')
print('\nservers with errors or warnings:')
for sid, spec, repo, tools, tokens, fs, _ in sorted(rows, key=lambda r: -(r[4] or 0)):
    if tools is None:
        continue
    bad = [f for f in fs if f.get('severity') in ('error', 'warn')]
    if not bad:
        continue
    tags = ', '.join(sorted({f"{f['severity'][0].upper()}:{f['rule']}" for f in bad}))
    print(f'  {spec:45} {tools:4} tools {tokens or 0:>8,} tok  {repo}\n      {tags}')
print('\nfailed to snapshot:')
for sid, spec, repo, tools, tokens, fs, reason in rows:
    if tools is None:
        print(f'  {spec:45} {reason}')
