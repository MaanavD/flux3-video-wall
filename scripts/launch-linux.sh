#!/bin/bash
set -e
cd "$(dirname "$0")/app"
./node local/run.mjs --production --open "$@"
