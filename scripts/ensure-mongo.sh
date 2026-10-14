#!/usr/bin/env bash
# Starts the local single-node replica set (rs0) that MONGODB_URI points at in
# development, if it is not already listening. Runs as `predev`, so a plain
# `npm run dev` after a reboot no longer dies with ECONNREFUSED 127.0.0.1:27018.
set -euo pipefail

PORT="${MONGO_RS_PORT:-27018}"
DBPATH="${MONGO_RS_DBPATH:-$HOME/mongo-rs}"

if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  exit 0
fi

if ! command -v mongod >/dev/null; then
  echo "[ensure-mongo] mongod not found on PATH; start MongoDB on :$PORT yourself" >&2
  exit 0
fi

mkdir -p "$DBPATH"
echo "[ensure-mongo] starting mongod rs0 on :$PORT (dbpath $DBPATH)"
nohup mongod --dbpath "$DBPATH" --port "$PORT" --bind_ip 127.0.0.1 --replSet rs0 \
  --logpath "$DBPATH/mongod.log" --logappend >/dev/null 2>&1 &

for _ in $(seq 1 30); do
  nc -z 127.0.0.1 "$PORT" 2>/dev/null && break
  sleep 1
done

# A fresh dbpath has no replica-set config yet; initiate it once.
if command -v mongosh >/dev/null; then
  mongosh --quiet --port "$PORT" --eval "
    try { rs.status() } catch (e) {
      rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:$PORT' }] })
    }" >/dev/null
fi
