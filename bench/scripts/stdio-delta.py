# The stdio servers to recheck this week: registry packages whose latest version isn't
# the one last checked, and packages not checked before, in the registry list's (seeded)
# order, at most <max>.
#   python3 -I bench/scripts/stdio-delta.py pick <versions.tsv> <registry.tsv> <max> > try.tsv
#   python3 -I bench/scripts/stdio-delta.py record <versions.tsv> <try.tsv> <date>
# versions.tsv: package<TAB>version<TAB>date checked. Every package tried is recorded,
# started or not: a version that didn't start won't start next week either.
import sys

mode, versions = sys.argv[1], sys.argv[2]


def split(spec):
    i = spec.rfind('@')
    return (spec[:i], spec[i + 1:]) if i > 0 else (spec, '')


known = {}
try:
    for line in open(versions):
        p = line.rstrip('\n').split('\t')
        if len(p) >= 2:
            known[p[0]] = p[1]
except FileNotFoundError:
    pass

if mode == 'pick':
    registry, cap = sys.argv[3], int(sys.argv[4])
    picked = 0
    for line in open(registry):
        cols = line.rstrip('\n').split('\t')
        if len(cols) < 2:
            continue
        pkg, ver = split(cols[1])
        if known.get(pkg) == ver:
            continue
        print(line.rstrip('\n'))
        picked += 1
        if picked >= cap:
            break
    print(f'{picked} to recheck', file=sys.stderr)
elif mode == 'record':
    tried, date = sys.argv[3], sys.argv[4]
    for line in open(tried):
        cols = line.rstrip('\n').split('\t')
        if len(cols) >= 2:
            pkg, ver = split(cols[1])
            known[pkg] = f'{ver}\t{date}'
    with open(versions, 'w') as h:
        for pkg in sorted(known):
            v = known[pkg]
            h.write(f'{pkg}\t{v}\n' if '\t' in v else f'{pkg}\t{v}\t\n')
