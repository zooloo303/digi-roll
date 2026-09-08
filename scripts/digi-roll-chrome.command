#!/bin/bash
# Dedicated Chrome profile: keeps the workaround independent of normal Chrome.
set -eu
if [ "$(uname -s)" != Darwin ]; then
  echo 'This launcher is for Google Chrome on macOS.' >&2
  exit 1
fi
lab_url="${1:-https://zooloo303.github.io/digi-roll/difflab.html}"
case "$lab_url" in
  http://*|https://*) ;;
  *) echo 'Expected an http:// or https:// URL.' >&2; exit 1 ;;
esac
exec /usr/bin/open -na 'Google Chrome' --args \
  "--user-data-dir=$HOME/Library/Application Support/digi-roll-chrome" \
  --disable-features=MidiMacUmp "$lab_url"
