#!/bin/sh
# usage: preflight.sh /path/Junction.app  -- exit 0 only if every bundled library reference resolves and kicad-cli starts
app="$1"; bad=0
find "$app/Contents" -type f -perm -u+x | while read f; do
  otool -L "$f" 2>/dev/null | awk 'NR>1{print $1}' | grep '^@executable_path/' | while read dep; do
    [ -e "$app/Contents/MacOS/${dep#@executable_path/}" ] || echo "MISSING $dep (from ${f#$app/})"
  done
done > /tmp/preflight.$$ 2>&1
if [ -s /tmp/preflight.$$ ]; then sort -u /tmp/preflight.$$ | head -10; rm -f /tmp/preflight.$$; exit 1; fi
rm -f /tmp/preflight.$$
"$app/Contents/MacOS/kicad-cli" version >/dev/null 2>&1 || { echo "kicad-cli does not start"; exit 1; }
echo "preflight ok: $app"
