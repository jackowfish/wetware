#!/bin/sh
set -e

# Use bundled redis only when REDIS_URL is unset or points at localhost.
# When deploying with an external Redis, set REDIS_URL to a non-localhost host
# (e.g. redis://my-redis.svc:6379) and the bundled server stays off.
USE_BUNDLED=1
if [ -n "$REDIS_URL" ]; then
  case "$REDIS_URL" in
    *127.0.0.1*|*localhost*) USE_BUNDLED=1 ;;
    *) USE_BUNDLED=0 ;;
  esac
fi

if [ "$USE_BUNDLED" = "1" ]; then
  if command -v redis-server >/dev/null 2>&1; then
    echo "starting bundled redis (no persistence)"
    redis-server --daemonize yes --save "" --appendonly no --bind 127.0.0.1 --port 6379
    for i in $(seq 1 20); do
      if redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
      sleep 0.1
    done
  else
    echo "bundled redis requested but redis-server not installed; relying on REDIS_URL=$REDIS_URL"
  fi
else
  echo "using external redis at $REDIS_URL"
fi

exec node server.js
