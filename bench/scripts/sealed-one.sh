#!/bin/bash
# Inside a container with no network (batch-full.sh, SEALED=1): every tool of one server
# called once, writes included (session --auto --call-everything). No credentials, no
# network, a throwaway filesystem: nothing a write does can reach anything real.
# Then the install is deleted. One line per server in /out/status-sealed.txt.
id=$1; d=/out/$id
[ -f "$d/bin.txt" ] || exit 0
cd "$d" || exit
bin=$(cat bin.txt)
timeout 1200 node /toolmenu/dist/cli.js session --auto --call-everything --json --timeout 10000 --processes 1 -- "$bin" > everything.json 2> everything-err.txt
echo "$? $id" >> /out/status-sealed.txt
rm -rf pkg bin.txt
