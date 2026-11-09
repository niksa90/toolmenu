# usage: python3 -I bench/scripts/compare-weeks.py <previous week's dir> <this week's dir> [toolmenu cli]
# What changed on the hosted panel since the previous weekly run, as markdown on stdout:
# servers that went up, down or behind a login; menus that changed (tools added and
# removed by name; for the vendors, toolmenu review of last week's menu against this
# week's); findings that appeared or went away. Each week's dir holds http/ (build-http.py)
# and, when stdio servers were rechecked, stdio/ (build-results.py).
import json, os, subprocess, sys, collections

PREV, CUR = sys.argv[1], sys.argv[2]
CLI = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), '..', '..', 'dist', 'cli.js')


def servers(d):
    path = os.path.join(d, 'http', 'servers.tsv')
    if not os.path.exists(path):
        return {}
    lines = open(path).read().splitlines()
    cols = lines[0].split('\t')
    return {r['url']: r for r in (dict(zip(cols, l.split('\t'))) for l in lines[1:])}


def findings(d):
    path = os.path.join(d, 'http', 'findings.jsonl')
    out = collections.defaultdict(set)
    if os.path.exists(path):
        for line in open(path):
            f = json.loads(line)
            if f['severity'] != 'info' and f['kind'] != 'run':
                out[f['url']].add((f['rule'], f['severity']))
    return out


def folder(url):
    return ''.join(c if c.isalnum() or c in '._-' else '_' for c in url.removeprefix('https://'))


a, b = servers(PREV), servers(CUR)
fa, fb = findings(PREV), findings(CUR)
lines = [f'## What changed: {os.path.basename(PREV.rstrip("/"))} → {os.path.basename(CUR.rstrip("/"))}', '']
moved = [(u, a[u]['mode'], b[u]['mode']) for u in b if u in a and a[u]['mode'] != b[u]['mode']]
changed = [u for u in b if u in a and a[u]['menu_hash'] and b[u]['menu_hash'] and a[u]['menu_hash'] != b[u]['menu_hash']]
lines.append(f'{len(b)} hosted servers this week, {len(a)} last week. {len(changed)} menus changed, {len(moved)} servers changed how they answer.')
lines.append('')
if moved:
    lines += ['### Up, down or behind a login', '', '| Server | Last week | This week |', '|---|---|---|']
    lines += [f'| {b[u]["name"]} (`{u}`) | {m1} | {m2} |' for u, m1, m2 in sorted(moved)] + ['']
if changed:
    lines += ['### Menus that changed', '']
    for u in sorted(changed):
        before = set(filter(None, a[u]['tool_names'].split(','))), set(filter(None, b[u]['tool_names'].split(',')))
        added, removed = sorted(before[1] - before[0]), sorted(before[0] - before[1])
        what = []
        if added: what.append(f'added {", ".join(added[:8])}{" …" if len(added) > 8 else ""}')
        if removed: what.append(f'removed {", ".join(removed[:8])}{" …" if len(removed) > 8 else ""}')
        if not what: what.append('same tools, definitions changed')
        verdict = ''
        old, new = os.path.join(PREV, 'http', 'menus', folder(u) + '.json'), os.path.join(CUR, 'http', 'menus', folder(u) + '.json')
        if os.path.exists(old) and os.path.exists(new):
            r = subprocess.run(['node', CLI, 'review', '--json', old, new], capture_output=True, text=True)
            try:
                j = json.loads(r.stdout)
                verdict = f' · review: **{j["verdict"]}**, {j["summary"]}'
            except Exception:
                pass
        lines.append(f'- **{b[u]["name"]}** (`{u}`): {"; ".join(what)} ({a[u]["tools"]} → {b[u]["tools"]} tools, ~{a[u]["tokens"]} → ~{b[u]["tokens"]} tokens){verdict}')
    lines.append('')
new_f = {u: fb[u] - fa.get(u, set()) for u in fb if u in a}
gone_f = {u: fa[u] - fb.get(u, set()) for u in fa if u in b}
new_f = {u: v for u, v in new_f.items() if v}
gone_f = {u: v for u, v in gone_f.items() if v}
if new_f or gone_f:
    lines += ['### Findings (warn and error, run notes aside)', '']
    lines += [f'- new on {b[u]["name"]}: ' + ', '.join(f'`{r}` ({s})' for r, s in sorted(v)) for u, v in sorted(new_f.items())]
    lines += [f'- gone from {b[u]["name"]}: ' + ', '.join(f'`{r}` ({s})' for r, s in sorted(v)) for u, v in sorted(gone_f.items())]
    lines.append('')
# stdio: each package rechecked this week against its last check in an earlier week.
WEEKS = os.path.dirname(os.path.abspath(CUR))


def pkg_name(spec):
    i = spec.rfind('@')
    return spec[:i] if i > 0 else spec


def stdio_findings(d):
    path = os.path.join(d, 'stdio', 'findings.jsonl')
    out = collections.defaultdict(set)
    if os.path.exists(path):
        for line in open(path):
            f = json.loads(line)
            if f['severity'] != 'info' and f['kind'] in ('spec', 'client'):
                out[f['pkg']].add((f['rule'], f['severity']))
    return out


def stdio_versions(d):
    path = os.path.join(d, 'stdio', 'servers.tsv')
    return {pkg_name(l.split('\t')[0]): l.split('\t')[0] for l in open(path).read().splitlines()[1:]} if os.path.exists(path) else {}


cur_versions = stdio_versions(CUR)
if cur_versions:
    cur_f = stdio_findings(CUR)
    earlier = sorted(d for d in (os.path.join(WEEKS, x) for x in os.listdir(WEEKS)) if os.path.isdir(d) and os.path.basename(d) < os.path.basename(CUR.rstrip('/')))
    fixed, broke, new_pkgs = [], [], []
    for name, spec in sorted(cur_versions.items()):
        prev = next((d for d in reversed(earlier) if name in stdio_versions(d)), None)
        if not prev:
            new_pkgs.append(spec)
            continue
        old_spec = stdio_versions(prev)[name]
        before, after = stdio_findings(prev).get(old_spec, set()), cur_f.get(spec, set())
        if before - after: fixed.append((old_spec, spec, sorted(before - after)))
        if after - before: broke.append((old_spec, spec, sorted(after - before)))
    lines += ['### stdio: new releases and new servers', '', f'{len(cur_versions)} rechecked: {len(cur_versions) - len(new_pkgs)} new releases of servers checked before, {len(new_pkgs)} servers new to the bench. Spec and client findings: {len(fixed)} releases fixed some, {len(broke)} brought new ones.', '']
    lines += [f'- fixed in `{b}` (was `{a_}`): ' + ', '.join(f'`{r}`' for r, _ in v) for a_, b, v in fixed[:30]]
    lines += [f'- new in `{b}` (was `{a_}`): ' + ', '.join(f'`{r}` ({sev})' for r, sev in v) for a_, b, v in broke[:30]]
    lines.append('')


# The running trend: one line per week, the same measures every week.
CLIENT_FAILS = {'spec/schema', 'menu/duplicate-name', 'session/result-type', 'session/output-schema'}


def breaking(findings_by_server, rules=None):
    return sum(1 for v in findings_by_server.values() if any((rules is None or r in rules) and sev == 'error' for r, sev in v))


trend = os.path.join(WEEKS, 'trend.tsv')
http_f = findings(CUR)
row = [os.path.basename(CUR.rstrip('/')), str(len(b)), str(sum(1 for r in b.values() if r['mode'] == 'open')), str(len(changed)),
       str(breaking(http_f, CLIENT_FAILS)), str(sum(1 for v in http_f.values() if v)),
       str(len(cur_versions)), str(breaking(stdio_findings(CUR), CLIENT_FAILS)) if cur_versions else '0']
header = 'week\thosted\thosted_open\thosted_menus_changed\thosted_client_fails\thosted_with_findings\tstdio_rechecked\tstdio_client_fails\n'
existing = open(trend).read().splitlines() if os.path.exists(trend) else []
kept = [l for l in existing[1:] if not l.startswith(row[0] + '\t')]
with open(trend, 'w') as h:
    h.write(header + ''.join(l + '\n' for l in sorted(kept + ['\t'.join(row)])))
lines += ['### Trend', '', '| Week | Hosted | Open | Menus changed | Hosted that fail in a client | stdio rechecked | stdio that fail in a client |', '|---|---|---|---|---|---|---|']
for l in sorted(kept + ['\t'.join(row)])[-8:]:
    c = l.split('\t')
    lines.append(f'| {c[0]} | {c[1]} | {c[2]} | {c[3]} | {c[4]} | {c[6]} | {c[7]} |')
lines.append('')
print('\n'.join(lines))
