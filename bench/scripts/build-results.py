# Build the report's data and the committed dataset from one bench run directory.
# usage: python3 -I build.py <run dir with try.tsv and out/> <dataset dir> <page data.json>
import json, sys, os, collections

RUN, DATASET, PAGE = sys.argv[1:4]
KIND = {
    'spec/schema': 'spec', 'lists/schema': 'spec', 'lists/resource-read-schema': 'spec', 'apps/app-only-listed': 'spec', 'apps/resource': 'spec', 'apps/visibility': 'spec', 'apps/legacy-key': 'spec', 'spec/extension-id': 'spec', 'session/result-type': 'spec',
    'menu/duplicate-name': 'client', 'naming/client-name': 'client', 'description/cut': 'client', 'description/buried': 'client',
    'lists/resource-unreadable': 'behaviour', 'menu/network-dependent': 'behaviour', 'menu/process-variance': 'behaviour', 'menu/nondeterministic': 'behaviour',
    'menu/connection-variance': 'behaviour', 'menu/capability-dependent': 'behaviour', 'session/known-variance': 'behaviour',
    'session/step-failed': 'behaviour', 'session/tool-error': 'behaviour', 'session/server-unresponsive': 'behaviour', 'session/output-schema': 'spec',
    'session/mid-insert': 'behaviour', 'session/append': 'behaviour', 'session/edit': 'behaviour', 'session/remove': 'behaviour',
    'session/reorder': 'behaviour', 'session/side-effect': 'behaviour', 'session/unannounced': 'behaviour',
    'session/error-not-flagged': 'behaviour', 'session/handle-error': 'behaviour', 'session/input-unanswered': 'behaviour',
    'write/unannotated': 'heuristic', 'naming/vague-id': 'heuristic', 'naming/shared-word': 'heuristic', 'ids/authored': 'heuristic',
    'ids/handle-lifetime': 'heuristic', 'write/no-dry-run': 'heuristic', 'search/findable': 'heuristic', 'write/read-only-mismatch': 'heuristic',
    'spec/cache-hints': 'heuristic', 'menu/gated': 'heuristic', 'description/late-instruction': 'heuristic', 'menu/host-specific': 'heuristic',
    'session/unlock-coverage': 'heuristic',
    'spec/discover': 'run', 'session/nothing-called': 'run', 'session/untested': 'run', 'session/rate-limited': 'run',
    'session/scope-unchecked': 'run', 'session/assumed-read-only': 'run', 'session/refused': 'run', 'spec/deprecated': 'run',
    'lists/resource-unread': 'run',
}
import re
# The run used toolmenu acaa34c. Rules changed after it (c021a3f) are applied here,
# and each finding changed is marked with `regraded`.
MODEL_FIELDS = {'name', 'description', 'inputSchema'}
SETUP = re.compile(r"\bneeds? (?:an? )?(?:[\w-]+ )?(?:credentials?|api[ _-]?key|access token)\b|\b[a-z0-9_]*(?:api_?key|token|secret)\b (?:is |was )?not (?:set|configured|provided)\b|\bno (?:browser|chrome|chromium) (?:was )?found\b|\bnot a git repository\b|\b(?:extension|app|application|plugin|bridge) is not (?:connected|running)\b", re.I)
def regrade(f):
    if f['rule'] == 'session/edit' and f['severity'] == 'error':
        fields = {m.group(1) for d in f.get('detail') or [] for m in [re.match(r'^([A-Za-z_$]+)(?:[.\[][^:]*)?: ', d)] if m}
        fields -= {'cost', 'call'}
        if fields and not fields & MODEL_FIELDS:
            return {**f, 'severity': 'warn', 'regraded': 'edit outside the model (c021a3f)'}
    if f['rule'] in ('session/step-failed', 'session/tool-error') and SETUP.search(f['message']):
        return {**f, 'rule': 'session/untested', 'severity': 'warn', 'regraded': 'setup failure (c021a3f and after)'}
    return f

def load(path):
    try:
        with open(path) as h:
            return json.load(h)
    except Exception:
        return None

order = [(line.rstrip('\n').split('\t') + [''])[:3] for line in open(os.path.join(RUN, 'try.tsv'))]
status = {}
for line in open(os.path.join(RUN, 'out', 'status.txt')):
    p = line.split()
    if len(p) >= 2:
        status[p[1]] = (p[0], dict(x.split('=', 1) for x in p[2:] if '=' in x))
tried = collections.Counter(status.get(i, ('not-run',))[0] for i, _, _ in order)

def publisher(pkg):
    return pkg.split('/')[0] if pkg.startswith('@') else pkg.split('@')[0]

servers, findings = [], []
for id, spec, repo in order:
    if status.get(id, ('',))[0] != 'ok':
        continue
    d = os.path.join(RUN, 'out', id)
    snap, sess, rev = load(f'{d}/snapshot.json'), load(f'{d}/session.json'), load(f'{d}/review.json')
    # SEALED=1: every tool called once, in a container with no network (everything.json).
    sealed = load(f'{d}/everything.json')
    if not snap:
        continue
    fs = [(regrade(f), 'snapshot') for f in snap['findings']] + [(regrade(f), 'session') for f in (sess['findings'] if sess else [])]
    # The sealed pass: its own findings, except those the read-only session already made.
    seen = {(f['rule'], f.get('tool')) for f, _ in fs}
    # Made-up values, no network: a failed call or an untested run is info there (as the
    # current toolmenu says it); what a result breaks whatever the input keeps its level.
    def sealed_grade(f):
        f = regrade(f)
        if f['rule'] in ('session/step-failed', 'session/untested', 'session/rate-limited') and f['severity'] != 'info':
            return {**f, 'severity': 'info', 'regraded': f.get('regraded') or 'sealed pass: made-up values, no network'}
        if f['rule'] == 'session/server-unresponsive' and f['severity'] == 'error':
            return {**f, 'severity': 'warn', 'regraded': f.get('regraded') or 'sealed pass: made-up values, no network'}
        return f
    fs += [(sealed_grade(f), 'sealed') for f in (sealed['findings'] if sealed else []) if (f['rule'], f.get('tool')) not in seen]
    for f, cmd in fs:
        findings.append({'pkg': spec, 'command': cmd, 'rule': f['rule'], 'kind': KIND.get(f['rule'], 'other'), 'severity': f['severity'],
                         **({'confidence': f['confidence']} if f.get('confidence') else {}), **({'tool': f['tool']} if f.get('tool') else {}),
                         'message': f['message'], **({'detail': f['detail'][:5]} if f.get('detail') else {}), **({'regraded': f['regraded']} if f.get('regraded') else {})})
    steps = [x for x in (sess['steps'] if sess else []) if x['label'].startswith('call')]
    # Per tool, in the sealed pass: what each call came back with.
    sealed_steps = [x for x in (sealed['steps'] if sealed else []) if x['label'].startswith('call ')]
    outcome = collections.Counter(('timeout' if 'timed out' in (x.get('note') or '').lower() else x.get('outcome') or 'failed') for x in sealed_steps)
    c = collections.Counter(f['severity'] for f, _ in fs)
    servers.append({'pkg': spec, 'repo': repo, 'publisher': publisher(spec), 'protocol': snap['server'].get('protocolVersion', '?'),
                    'tools': snap.get('tools', 0), 'tokens': snap.get('totalTokens', 0), 'calls': len(steps),
                    'answered': sum(x.get('outcome') == 'answered' for x in steps), 'error': c['error'], 'warn': c['warn'], 'info': c['info'],
                    'review': rev['verdict'] if rev else ('no session' if not sess else '—'),
                    'sealed_called': len((sealed or {}).get('auto', {}).get('called', [])) if sealed else 0, 'sealed': dict(outcome) if sealed else None})

# The two biggest publishers, reported apart.
pubs = collections.Counter(s['publisher'] for s in servers)
(top, top_n), (second, second_n) = pubs.most_common(2)
big = {top, second}

os.makedirs(DATASET, exist_ok=True)
cols = ['pkg', 'repo', 'protocol', 'tools', 'tokens', 'calls', 'answered', 'error', 'warn', 'info', 'review', 'sealed_called', 'sealed_answered', 'sealed_tool_error', 'sealed_failed', 'sealed_timeout']
for s_ in servers:
    o = s_['sealed'] or {}
    s_['sealed_answered'], s_['sealed_tool_error'], s_['sealed_failed'], s_['sealed_timeout'] = o.get('answered', 0), o.get('tool-error', 0), o.get('failed', 0) + o.get('needs-input', 0), o.get('timeout', 0)
with open(os.path.join(DATASET, 'servers.tsv'), 'w') as h:
    h.write('\t'.join(cols) + '\n')
    for s in servers:
        h.write('\t'.join(str(s[c]) for c in cols) + '\n')
with open(os.path.join(DATASET, 'findings.jsonl'), 'w') as h:
    for f in findings:
        h.write(json.dumps(f, ensure_ascii=False) + '\n')
json.dump({'tried': dict(tried)}, open(os.path.join(DATASET, 'tried.json'), 'w'))

by_pkg = collections.defaultdict(list)
for f in findings:
    by_pkg[f['pkg']].append(f)

def agg(sel):
    S = [s for s in servers if sel(s)]
    F = [f for s in S for f in by_pkg[s['pkg']]]
    sev = collections.Counter(f['severity'] for f in F)
    real = lambda s: any(f['severity'] != 'info' and f['kind'] != 'run' for f in by_pkg[s['pkg']])
    kinds = {k: len({f['pkg'] for f in F if f['kind'] == k and f['severity'] != 'info'}) for k in ['spec', 'client', 'behaviour', 'heuristic', 'run']}
    return {'servers': len(S), 'publishers': len({s['publisher'] for s in S}), 'tools': sum(s['tools'] for s in S), 'tokens': sum(s['tokens'] for s in S),
            'withError': sum(1 for s in S if s['error']), 'real': sum(1 for s in S if real(s)), 'error': sev['error'], 'warn': sev['warn'], 'info': sev['info'],
            'calledServers': sum(1 for s in S if s['calls']), 'answeredServers': sum(1 for s in S if s['answered']),
            'calls': sum(s['calls'] for s in S), 'answered': sum(s['answered'] for s in S), 'kinds': kinds,
            'sealedServers': sum(1 for s in S if s['sealed'] is not None), 'sealedCalled': sum(s['sealed_called'] for s in S),
            'sealedOutcomes': dict(sum((collections.Counter(s['sealed'] or {}) for s in S), collections.Counter()))}

rules = collections.defaultdict(lambda: {'sev': collections.Counter(), 'servers': set(), 'top': set()})
for f in findings:
    r = rules[f['rule']]
    r['sev'][f['severity']] += 1
    r['servers'].add(f['pkg'])
    if publisher(f['pkg']) in big:
        r['top'].add(f['pkg'])

page = {
    'tried': dict(tried), 'big': [{'publisher': top, 'servers': top_n}, {'publisher': second, 'servers': second_n}],
    'all': agg(lambda s: True), 'rest': agg(lambda s: s['publisher'] not in big),
    'protocols': dict(collections.Counter(s['protocol'] for s in servers).most_common()),
    'publishers': pubs.most_common(10),
    'reviews': dict(collections.Counter(s['review'] for s in servers)),
    'rules': sorted([{'rule': k, 'kind': KIND.get(k, 'other'), 'error': v['sev']['error'], 'warn': v['sev']['warn'], 'info': v['sev']['info'],
                      'servers': len(v['servers']), 'top': len(v['top'])} for k, v in rules.items()], key=lambda r: (-r['servers'], r['rule'])),
    'servers': [{**{k: s[k] for k in ('pkg', 'repo', 'protocol', 'tools', 'tokens', 'calls', 'answered', 'error', 'warn', 'info', 'review', 'sealed_called', 'sealed')},
                 'findings': sorted([[f['rule'], f['severity'], f.get('tool', ''), f['message'][:400]] for f in by_pkg[s['pkg']]],
                                    key=lambda x: {'error': 0, 'warn': 1, 'info': 2}[x[1]])} for s in servers],
}
json.dump(page, open(PAGE, 'w'), separators=(',', ':'))
unknown = sorted({f['rule'] for f in findings if f['kind'] == 'other'})
print(json.dumps({k: page[k] for k in ('tried', 'big', 'reviews')}))
print('all', json.dumps(page['all']))
print('rest', json.dumps(page['rest']))
print('rules without a kind:', unknown)
print('regraded:', dict(collections.Counter(f['regraded'] for f in findings if f.get('regraded'))))
