#!/bin/bash
# Watches the e2e run: heartbeat + detection of both paths + error counting.
# Every line differs from the previous one (tick + elapsed), so a plateau is
# not indistinguishable from a hang. Server liveness is checked BY PID.
L=server.log
P=progress.log
SPID=$(cat server.pid)
TPID=$(cat tunnel.pid)
START=$(date +%s)
T=0
: > "$P"
while true; do
  T=$((T+1))
  E=$(( $(date +%s) - START ))
  SERV=$([ -d /proc/$SPID ] && echo alive || echo DEAD)
  TUN=$([ -d /proc/$TPID ] && echo alive || echo DEAD)
  # notifications other than the check
  NOTIF=$(grep -c "NOTIFICATION BODY" "$L" 2>/dev/null)
  RETURNS=$(grep -c "BROWSER RETURN" "$L" 2>/dev/null)
  CONF=$(grep -c "confirm-order ->" "$L" 2>/dev/null)
  ERRORS=$(grep -c "ERROR\|EXCEPTION" "$L" 2>/dev/null)
  LAST_ERROR=$(grep "ERROR\|EXCEPTION" "$L" 2>/dev/null | tail -1 | cut -c1-110)
  LAST=$(tail -1 "$L" 2>/dev/null | cut -c1-110)
  printf '%s tick=%d elapsed=%ds server=%s tunnel=%s | notifications=%s returns=%s confirm=%s errors=%s\n' \
    "$(date +%H:%M:%S)" "$T" "$E" "$SERV" "$TUN" "$NOTIF" "$RETURNS" "$CONF" "$ERRORS" >> "$P"
  [ -n "$LAST_ERROR" ] && echo "    last error: $LAST_ERROR" >> "$P"
  echo "    last line: $LAST" >> "$P"
  if [ "$SERV" = "DEAD" ] || [ "$TUN" = "DEAD" ]; then
    echo "$(date +%H:%M:%S) STOP: process died (server=$SERV tunnel=$TUN)" >> "$P"; exit 1
  fi
  if grep -q "Order confirmed\|Order already confirmed" "$L" 2>/dev/null; then
    echo "$(date +%H:%M:%S) ORDER CONFIRMED - watch finished" >> "$P"; exit 0
  fi
  if [ "$E" -gt 1800 ]; then echo "$(date +%H:%M:%S) STOP: 30 minute limit reached with no order" >> "$P"; exit 2; fi
  sleep 5
done
