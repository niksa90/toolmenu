# The vendor panels' dataset: official servers from big vendors, as npm packages, PyPI
# packages and container images, each run through snapshot, session --auto and the sealed
# pass that calls every tool (batch-full.sh, PY=1 batch-full.sh, batch-image.sh).
# usage: python3 -I build-vendors.py <dataset dir> <list.tsv> <run dir> [<list.tsv> <run dir> ...]
# Writes servers.tsv (one row per server, the ones that didn't list tools too, with why),
# and findings.jsonl (every finding, every level, with the pass that made it).
import collections, json, os, re, sys

OUT, pairs = sys.argv[1], sys.argv[2:]
KINDS = {'spec': ('spec/', 'lists/schema', 'apps/', 'session/result-type', 'session/output-schema'),
         'client': ('menu/duplicate-name', 'naming/client-name', 'description/cut', 'description/buried'),
         'run': ('spec/discover', 'spec/deprecated', 'session/nothing-called', 'session/untested', 'session/rate-limited',
                 'session/scope-unchecked', 'session/assumed-read-only', 'session/refused')}
BEHAVIOUR = ('menu/', 'session/', 'lists/variance', 'auth/', 'catalog/')


def kind(rule):
    for k, pre in KINDS.items():
        if rule.startswith(pre):
            return k
    return 'behaviour' if rule.startswith(BEHAVIOUR) else 'heuristic'


def load(path):
    try:
        with open(path) as h:
            return json.load(h)
    except (OSError, ValueError):
        return None


def why(d):
    """What went wrong, in the server's words: the last line of a Python traceback, else the
    first line of its stderr, else the installer's error, else toolmenu's own first line."""
    try:
        err = open(os.path.join(d, 'snapshot-err.txt'), errors='replace').read().splitlines()
    except OSError:
        err = []
    stderr = [re.sub(r'^\s*│\s?', '', l).strip() for l in err if '│' in l]
    stderr = [l for l in stderr if l]
    if any(l.startswith('Traceback') for l in stderr):
        exc = [l for l in stderr if re.match(r'^[A-Za-z_.]+(Error|Exception)\b', l)]
        if exc:
            return exc[-1][:240]
    if stderr:
        return stderr[0][:240]
    try:
        inst = [l.strip() for l in open(os.path.join(d, 'install.txt'), errors='replace') if l.strip()]
    except OSError:
        inst = []
    for l in inst:
        if re.search(r'Because|error|ERR!', l):
            return ('install: ' + ' '.join(x.lstrip('╰─▶ ') for x in inst[inst.index(l):inst.index(l) + 3]))[:240]
    return (err[0] if err else '')[:240]


def sealed_grade(f):
    # Made-up values, no network: a failed call or an untested run says how the tool met
    # such input, so info; a server that stops answering, a warning. What a result breaks
    # whatever the input keeps its level.
    if f['rule'] in ('session/step-failed', 'session/untested', 'session/rate-limited') and f['severity'] != 'info':
        return {**f, 'severity': 'info', 'graded': 'sealed pass: made-up values, no network'}
    if f['rule'] == 'session/server-unresponsive' and f['severity'] == 'error':
        return {**f, 'severity': 'warn', 'graded': 'sealed pass: made-up values, no network'}
    return f


servers, findings = [], []
for lst, run in zip(pairs[::2], pairs[1::2]):
    status = {}
    for name in ('status.txt',):
        for line in open(os.path.join(run, name)) if os.path.exists(os.path.join(run, name)) else []:
            p = line.split()
            if len(p) >= 2:
                status[p[1]] = p[0]
    for line in open(lst):
        cols = line.rstrip('\n').split('\t')
        sid, spec = cols[0], cols[1]
        d = os.path.join(run, sid)
        st = status.get(sid, 'not-run')
        row = {'server': spec, 'via': 'image' if lst.endswith('images.tsv') else ('pypi' if 'pypi' in lst else 'npm'),
               'status': st, 'protocol': '', 'tools': 0, 'tokens': 0, 'calls': 0, 'answered': 0,
               'sealed_called': 0, 'sealed_answered': 0, 'sealed_tool_error': 0, 'sealed_failed': 0, 'sealed_timeout': 0,
               'error': 0, 'warn': 0, 'info': 0, 'review': '', 'why': ''}
        snap = load(os.path.join(d, 'snapshot.json')) if st == 'ok' else None
        if not snap:
            row['why'] = 'the package declares no console script (run as python -m?)' if st == 'no-bin' else why(d)
            servers.append(row)
            continue
        sess, rev, sealed = (load(os.path.join(d, f)) for f in ('session.json', 'review.json', 'everything.json'))
        fs = [(f, 'snapshot') for f in snap['findings']] + [(f, 'session') for f in (sess or {}).get('findings', [])]
        seen = {(f['rule'], f.get('tool')) for f, _ in fs}
        fs += [(sealed_grade(f), 'sealed') for f in (sealed or {}).get('findings', []) if (f['rule'], f.get('tool')) not in seen]
        for f, cmd in fs:
            findings.append({'server': spec, 'command': cmd, 'rule': f['rule'], 'kind': kind(f['rule']), 'severity': f['severity'],
                             **({'confidence': f['confidence']} if f.get('confidence') else {}), **({'tool': f['tool']} if f.get('tool') else {}),
                             'message': f['message'], **({'detail': f['detail'][:5]} if f.get('detail') else {}),
                             **({'graded': f['graded']} if f.get('graded') else {})})
        steps = [x for x in (sess or {}).get('steps', []) if x['label'].startswith('call')]
        sealed_steps = [x for x in (sealed or {}).get('steps', []) if x['label'].startswith('call ')]
        out = collections.Counter('timeout' if 'timed out' in (x.get('note') or '').lower() else x.get('outcome') or 'failed' for x in sealed_steps)
        c = collections.Counter(f['severity'] for f, _ in fs)
        row.update(protocol=snap['server'].get('protocolVersion', '?'), tools=snap.get('tools', 0), tokens=snap.get('totalTokens', 0),
                   calls=len(steps), answered=sum(x.get('outcome') == 'answered' for x in steps),
                   sealed_called=len((sealed or {}).get('auto', {}).get('called', [])), sealed_answered=out['answered'],
                   sealed_tool_error=out['tool-error'], sealed_failed=out['failed'] + out['needs-input'], sealed_timeout=out['timeout'],
                   error=c['error'], warn=c['warn'], info=c['info'], review=rev['verdict'] if rev else '',
                   why='' if sealed else 'sealed pass did not run')
        servers.append(row)

os.makedirs(OUT, exist_ok=True)
cols = list(servers[0])
with open(os.path.join(OUT, 'servers.tsv'), 'w') as h:
    h.write('\t'.join(cols) + '\n')
    for s in servers:
        h.write('\t'.join(str(s[k]).replace('\t', ' ') for k in cols) + '\n')
with open(os.path.join(OUT, 'findings.jsonl'), 'w') as h:
    for f in findings:
        h.write(json.dumps(f, ensure_ascii=False) + '\n')
listed = [s for s in servers if s['tools']]
print(f"{len(servers)} servers, {len(listed)} listed tools ({sum(s['tools'] for s in listed)}), "
      f"{sum(s['sealed_called'] for s in listed)} called in the sealed pass; {len(findings)} findings")
