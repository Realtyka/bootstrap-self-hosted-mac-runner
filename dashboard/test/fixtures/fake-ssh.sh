#!/bin/sh
# emulate ssh: execute the last argument as a shell command locally
for last; do :; done
exec /bin/sh -c "$last"
