#!/bin/sh
# Mounted volumes are often root-owned (Fly volumes are). Give the data
# directory to the unprivileged "node" user, then run the studio as that user.
set -eu
data="${STUDIO_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
	mkdir -p "$data"
	chown node:node "$data"
	exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
