#!/bin/sh
set -eu

log() {
  echo "[entrypoint] $*"
}

HOME_DIR="${HOME:-/data}"
DB_DIR="${GROUTER_DB_DIR:-$HOME_DIR/.grouter}"
DB_PATH="$DB_DIR/grouter.db"
SNAPSHOT_DIR="${GROUTER_SNAPSHOT_DIR:-/app/state/grouter-local}"
SNAPSHOT_DB="$SNAPSHOT_DIR/grouter.db"
RESTORE_MODE="${GROUTER_RESTORE_SNAPSHOT:-if-empty}" # off|if-missing|if-empty|always

mkdir -p "$DB_DIR"

db_account_count() {
  if [ ! -f "$1" ]; then
    echo "0"
    return
  fi
  bun -e '
    import { Database } from "bun:sqlite";
    const path = process.argv[2];
    let count = 0;
    try {
      const db = new Database(path, { create: false });
      try {
        const row = db.query("SELECT COUNT(*) AS c FROM accounts").get() as { c?: number } | null;
        count = Number(row?.c ?? 0);
      } finally {
        db.close();
      }
    } catch {
      count = 0;
    }
    console.log(String(Number.isFinite(count) ? count : 0));
  ' _ "$1" 2>/dev/null || echo "0"
}

restore_snapshot() {
  cp -f "$SNAPSHOT_DB" "$DB_PATH"
  if [ -f "$SNAPSHOT_DB-wal" ]; then
    cp -f "$SNAPSHOT_DB-wal" "$DB_PATH-wal"
  else
    rm -f "$DB_PATH-wal"
  fi
  if [ -f "$SNAPSHOT_DB-shm" ]; then
    cp -f "$SNAPSHOT_DB-shm" "$DB_PATH-shm"
  else
    rm -f "$DB_PATH-shm"
  fi
}

should_restore=0
if [ -f "$SNAPSHOT_DB" ]; then
  case "$RESTORE_MODE" in
    off|0|false|FALSE)
      should_restore=0
      ;;
    always)
      should_restore=1
      ;;
    if-missing)
      if [ ! -f "$DB_PATH" ]; then
        should_restore=1
      fi
      ;;
    if-empty)
      if [ ! -f "$DB_PATH" ]; then
        should_restore=1
      else
        count="$(db_account_count "$DB_PATH")"
        if [ "$count" = "0" ]; then
          should_restore=1
        fi
      fi
      ;;
    *)
      log "unknown GROUTER_RESTORE_SNAPSHOT='$RESTORE_MODE' (valid: off|if-missing|if-empty|always); skipping restore"
      ;;
  esac
fi

if [ "$should_restore" = "1" ]; then
  restore_snapshot
  restored_count="$(db_account_count "$DB_PATH")"
  log "snapshot restored from '$SNAPSHOT_DIR' (accounts=$restored_count, mode=$RESTORE_MODE)"
else
  current_count="$(db_account_count "$DB_PATH")"
  log "snapshot restore skipped (accounts=$current_count, mode=$RESTORE_MODE)"
fi

exec /sbin/tini -- grouter "$@"
