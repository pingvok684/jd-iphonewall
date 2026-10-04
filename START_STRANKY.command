#!/bin/bash
# JD - IphoneWall – toto spúšťaj vždy. Dvojklik (prvýkrát pravý klik → Otvoriť).
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "=============================================="
echo "   JD - IphoneWall – spúšťam stránku"
echo "=============================================="

# ešte nie je nainštalované → najprv inštalácia
if ! command -v node >/dev/null || ! command -v ios >/dev/null || [ ! -d WebDriverAgent ]; then
  echo "  Chýba inštalácia – spúšťam install.command…"
  ./install.command || exit 1
fi
# cloudflared = posielanie fotiek/videí do iPhonov aj na mobilných dátach
if ! command -v cloudflared >/dev/null && command -v brew >/dev/null; then echo "  Inštalujem cloudflared…"; brew install cloudflared; fi

cleanup_old() {
  OLD=$(lsof -ti tcp:3000 2>/dev/null)
  if [ -n "$OLD" ]; then
    echo "  Zastavujem starý server…"
    kill $OLD 2>/dev/null; sleep 2
    kill -9 $(lsof -ti tcp:3000 2>/dev/null) 2>/dev/null
  fi
  pkill -f "cloudflared.*3001" 2>/dev/null
  pkill -f "JD-IphoneWall/build" 2>/dev/null   # staré xcodebuild procesy (WDA)
}
cleanup_old

# Bez Xcode režimu (bez teamId) potrebuje go-ios na iOS 17+ tunel na pozadí
if ! grep -q teamId config.json 2>/dev/null; then
  ios tunnel start --userspace >/tmp/iphone-wall-tunnel.log 2>&1 &
  TUNNEL=$!
fi
trap 'kill $TUNNEL 2>/dev/null' EXIT

# Mac nezaspí, kým beží stránka
caffeinate -dimsu -w $$ &

echo "  ✅ Pripoj iPhony káblom a odomkni ich. Stránka sa otvorí sama."
echo "  Toto okno NECHAJ otvorené – zatvorením sa stránka vypne."
echo
(sleep 2; open "http://localhost:3000") &

# server; kód 75 = po aktualizácii sa spustí znova sám
while true; do
  node server.js
  [ $? -eq 75 ] || break
  echo
  echo "  🔄 Stránka sa aktualizovala – spúšťam novú verziu…"
  sleep 1; cleanup_old
done
