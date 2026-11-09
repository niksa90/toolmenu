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
stdio = os.path.join(CUR, 'stdio', 'servers.tsv')
if os.path.exists(stdio):
    rows = open(stdio).read().splitlines()[1:]
    errs = [r.split('\t') for r in rows if r.split('\t')[7] != '0']
    lines += ['### stdio servers rechecked (new releases and new servers)', '', f'{len(rows)} rechecked; {len(errs)} with an error-level finding.', '']
    lines += [f'- `{r[0]}`: {r[7]} error(s)' for r in errs[:30]]
    lines.append('')
if len(lines) <= 4:
    lines.append('Nothing changed.')
print('\n'.join(lines))
