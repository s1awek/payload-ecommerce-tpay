#!/bin/bash
# Dozor przebiegu e2e: heartbeat + wykrycie obu sciezek + zliczanie bledow.
# Kazda linia rozni sie od poprzedniej (tick + elapsed), zeby plateau nie bylo
# nieodroznialne od zawieszki. Zywotnosc serwera sprawdzana PO PID.
L=serwer.log
P=postep.log
SPID=$(cat serwer.pid)
TPID=$(cat tunel.pid)
START=$(date +%s)
T=0
: > "$P"
while true; do
  T=$((T+1))
  E=$(( $(date +%s) - START ))
  SERW=$([ -d /proc/$SPID ] && echo zywy || echo MARTWY)
  TUN=$([ -d /proc/$TPID ] && echo zywy || echo MARTWY)
  # powiadomienia inne niz kontrolne
  POW=$(grep -c "CIALO POWIADOMIENIA" "$L" 2>/dev/null)
  POWROT=$(grep -c "POWROT PRZEGLADARKI" "$L" 2>/dev/null)
  CONF=$(grep -c "confirm-order ->" "$L" 2>/dev/null)
  BLEDY=$(grep -c "ERROR\|WYJATEK" "$L" 2>/dev/null)
  OSTATNI=$(grep "ERROR\|WYJATEK" "$L" 2>/dev/null | tail -1 | cut -c1-110)
  LAST=$(tail -1 "$L" 2>/dev/null | cut -c1-110)
  printf '%s tick=%d elapsed=%ds serwer=%s tunel=%s | powiadomienia=%s powroty=%s confirm=%s bledy=%s\n' \
    "$(date +%H:%M:%S)" "$T" "$E" "$SERW" "$TUN" "$POW" "$POWROT" "$CONF" "$BLEDY" >> "$P"
  [ -n "$OSTATNI" ] && echo "    ostatni blad: $OSTATNI" >> "$P"
  echo "    ostatnia linia: $LAST" >> "$P"
  if [ "$SERW" = "MARTWY" ] || [ "$TUN" = "MARTWY" ]; then
    echo "$(date +%H:%M:%S) STOP: proces padl (serwer=$SERW tunel=$TUN)" >> "$P"; exit 1
  fi
  if grep -q "Order confirmed\|Order already confirmed" "$L" 2>/dev/null; then
    echo "$(date +%H:%M:%S) ZAMOWIENIE POTWIERDZONE - koniec dozoru" >> "$P"; exit 0
  fi
  if [ "$E" -gt 1800 ]; then echo "$(date +%H:%M:%S) STOP: limit 30 min bez zamowienia" >> "$P"; exit 2; fi
  sleep 5
done
