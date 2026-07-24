#!/bin/sh
# emulate scp: args are [ssh opts...] <local> <dest>:<remote> — copy into $FAKE_HOME-rooted path
prev=''; for a; do src="$prev"; dst="$a"; prev="$a"; done
rpath="${dst#*:}"
case "$rpath" in "~/"*) rpath="$FAKE_HOME/${rpath#\~/}";; esac
exec cp "$src" "$rpath"
