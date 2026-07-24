#!/bin/sh
# emulate ssh against a fake remote rooted at $FAKE_HOME
for last; do :; done
[ -n "$FAKE_PATH_PREFIX" ] && PATH="$FAKE_PATH_PREFIX:$PATH"
HOME="$FAKE_HOME" PATH="$PATH" exec /bin/sh -c "$last"
