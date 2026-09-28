#!/usr/bin/env bash
# Inside the corpus container (see run.sh): for each server in servers.txt,
# snapshot, write a starter scenario, run it. Results land in /out.
# An array, not a function: timeout runs commands, not shell functions.
TM=(node /toolmenu/dist/cli.js)
while IFS='|' read -r name envs cmd; do
  [ -z "$name" ] && continue
  [ -n "$ONLY" ] && [[ " $ONLY " != *" $name "* ]] && continue
  envargs=(); for e in $envs; do envargs+=(--env "$e"); done
  printf '%-18s' "$name"
  timeout 180 "${TM[@]}" snapshot --timeout 30000 --out "$name.menu.json" --format json "${envargs[@]}" -- $cmd > "$name.snapshot.json" 2> "$name.snapshot.err"
  printf ' snapshot=%s' "$?"
  if [ -s "$name.menu.json" ]; then
    rm -f "$name.scenario.yml"
    timeout 180 "${TM[@]}" session --init --scenario "$name.scenario.yml" --timeout 30000 "${envargs[@]}" -- $cmd > /dev/null 2> "$name.init.err"
    timeout 600 "${TM[@]}" session --scenario "$name.scenario.yml" --timeout 30000 --format json "${envargs[@]}" -- $cmd > "$name.session.json" 2> "$name.session.err"
    printf ' session=%s' "$?"
  fi
  echo
done < /toolmenu/bench/servers.txt
