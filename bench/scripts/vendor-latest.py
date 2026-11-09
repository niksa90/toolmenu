# usage: python3 -I bench/scripts/vendor-latest.py <list.tsv> > list-latest.tsv
# A vendor list (vendors-npm.tsv, vendors-pypi.tsv) with each package moved to its latest
# release, keeping its id, credentials and arguments. A package whose latest version
# can't be read keeps the pinned one, so a registry outage doesn't drop it from the week.
# Image lists (vendors-images.tsv) pass through: the run pulls :latest and records digests.
import json, re, subprocess, sys, time, urllib.request


def npm_latest(name):
    r = subprocess.run(['npm', 'view', name, 'version'], capture_output=True, text=True, timeout=60)
    return r.stdout.strip() or None


def pypi_latest(name):
    for i in range(4):
        try:
            with urllib.request.urlopen(f'https://pypi.org/pypi/{name}/json', timeout=30) as r:
                return json.load(r)['info']['version']
        except Exception:
            time.sleep(2 ** i)
    return None


for line in open(sys.argv[1]):
    cols = line.rstrip('\n').split('\t')
    spec = cols[1]
    if '==' in spec:
        name, _ = spec.split('==', 1)
        latest = pypi_latest(name)
        if latest:
            cols[1] = f'{name}=={latest}'
    elif re.match(r'^@?[^@]+@[^@]+$', spec) and '/' not in spec.split('@')[-1]:
        name = spec[: spec.rfind('@')]
        latest = npm_latest(name)
        if latest:
            cols[1] = f'{name}@{latest}'
    print('\t'.join(cols))
