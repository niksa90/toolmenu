# The console script a PyPI package itself declares (its entry_points.txt), preferring one
# named for the package, then one named for mcp or server. Run with the venv's Python.
# usage: <venv>/bin/python py-entry.py <package name>
import importlib.metadata as m
import re
import sys

want = re.sub(r'[-_.]+', '-', sys.argv[1]).lower()
for dist in m.distributions():
    if re.sub(r'[-_.]+', '-', dist.metadata['Name'] or '').lower() == want:
        names = [e.name for e in dist.entry_points if e.group == 'console_scripts']
        names.sort(key=lambda n: (n.lower() != want, not re.search('mcp|server', n, re.I)))
        print(names[0] if names else '')
        break
