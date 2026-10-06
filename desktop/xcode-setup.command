#!/bin/bash
# JD Phone Studio (aplikácia) – nastavenie WebDriverAgenta cez Xcode. Spúšťa ho aplikácia (Sprievodca nastavením).
cd "$(dirname "$0")"
DIR="$(pwd)"
IOS="$DIR/bin/ios"
ok()   { echo "  ✅ $1"; }
step() { echo; echo "▶ $1"; }
fail() { echo; echo "❌ $1"; echo; read -r -p "Stlač Enter na zatvorenie…"; exit 1; }

echo "=============================================="
echo "   JD Phone Studio – nastavenie cez Xcode"
echo "=============================================="

# 1) Xcode
step "Kontrolujem Xcode"
if [ ! -d /Applications/Xcode.app ]; then
  open "macappstore://apps.apple.com/app/xcode/id497799835"
  fail "Chýba Xcode. Otvoril som App Store – nainštaluj Xcode (zadarmo), raz ho otvor a spusti tento súbor znova."
fi
if ! xcode-select -p 2>/dev/null | grep -q "Xcode.app"; then
  echo "  Nastavujem Xcode ako hlavný nástroj (zadaj heslo k Macu):"
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer || fail "Nepodarilo sa nastaviť Xcode."
fi
sudo -n true 2>/dev/null || echo "  (môže sa pýtať heslo k Macu – je to na prijatie licencie Xcode)"
sudo xcodebuild -license accept >/dev/null 2>&1
xcodebuild -runFirstLaunch >/dev/null 2>&1
ok "Xcode pripravený"

# 3) WebDriverAgent
step "Sťahujem WebDriverAgent"
if [ ! -d "$DIR/WebDriverAgent" ]; then
  git clone --depth 1 https://github.com/appium/WebDriverAgent.git "$DIR/WebDriverAgent" || fail "Stiahnutie WebDriverAgenta zlyhalo (internet?)."
fi
ok "WebDriverAgent"

# 4) Apple ID tím
step "Hľadám tvoj Apple vývojársky tím"
TEAM=$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | grep -Eo 'teamID = "?[A-Z0-9]{10}' | head -1 | grep -Eo '[A-Z0-9]{10}$')
[ -z "$TEAM" ] && TEAM=$(defaults read com.apple.dt.Xcode IDEProvisioningTeams 2>/dev/null | grep -Eo 'teamID = "?[A-Z0-9]{10}' | head -1 | grep -Eo '[A-Z0-9]{10}$')
[ -z "$TEAM" ] && TEAM=$(security find-certificate -a -c "Apple Development" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | grep -Eo 'OU ?= ?[A-Z0-9]{10}' | head -1 | grep -Eo '[A-Z0-9]{10}$')
if [ -z "$TEAM" ]; then
  echo
  echo "  Nenašiel som Apple ID v Xcode. Urob toto:"
  echo "   1. Otvor Xcode → v menu Xcode → Settings… → Accounts"
  echo "   2. Vľavo dole + → Apple ID → prihlás sa (stačí bežné Apple ID, zadarmo)"
  echo "   3. V aplikácii klikni znova „Nastaviť cez Xcode“"
  open -a Xcode
  fail "Chýba Apple ID v Xcode."
fi
ok "Tím: $TEAM"

USERSLUG=$(whoami | tr -cd 'a-zA-Z0-9' | tr 'A-Z' 'a-z')
BUNDLE=$(/usr/bin/python3 -c 'import json;print(json.load(open("config.json")).get("bundleId",""))' 2>/dev/null)
[ -z "$BUNDLE" ] && BUNDLE="com.${USERSLUG}.${TEAM}.WebDriverAgentRunner"
/usr/bin/python3 - "$TEAM" "$BUNDLE" <<'PY' || fail "Nepodarilo sa uložiť nastavenia."
import json, sys
try: c = json.load(open("config.json"))
except Exception: c = {}
c["buildPending"] = True
c["bundleId"] = sys.argv[2]
json.dump(c, open("config.json", "w"), indent=2)
PY
ok "Uložené do config.json"

# 5) Telefón
step "Pripoj iPhone káblom, odomkni ho a ťukni „Dôverovať“"
for i in $(seq 1 60); do
  UDID=$("$IOS" list 2>/dev/null | grep -Eo '"[0-9A-Fa-f-]{24,40}"' | head -1 | tr -d '"')
  [ -n "$UDID" ] && break
  sleep 2
done
[ -z "$UDID" ] && fail "Nevidím žiadny iPhone. Skontroluj kábel a „Dôverovať“ a spusti znova."
ok "iPhone $UDID"

step "Pripravujem a podpisujem WebDriverAgent (prvýkrát 2–5 minút)…"
# build mimo Plochy: iCloud (Plocha a Dokumenty) pridáva skryté atribúty a podpis potom zlyhá
BUILD_ROOT="$HOME/Library/Developer/JD-IphoneWall/build"
mkdir -p "$BUILD_ROOT"
xattr -cr "$DIR/WebDriverAgent" 2>/dev/null
xcodebuild -project "$DIR/WebDriverAgent/WebDriverAgent.xcodeproj" -scheme WebDriverAgentRunner \
  -destination "id=$UDID" -derivedDataPath "$BUILD_ROOT/$UDID" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" CODE_SIGN_STYLE=Automatic \
  build-for-testing > "$DIR/install-build.log" 2>&1
RC=$?
grep -E "error:|BUILD (SUCCEEDED|FAILED)|TEST BUILD" "$DIR/install-build.log" | tail -15
if [ "$RC" != "0" ]; then
  echo
  echo "  Detail chyby (celý záznam je v súbore install-build.log):"
  grep -iE "error|failed|requires|provision|sign|team|device" "$DIR/install-build.log" | grep -v "^\s*$" | tail -12 | sed 's/^/   /'

  echo
  echo "  Najčastejšie príčiny:"
  echo "   • Režim pre vývojárov na iPhone nie je zapnutý (Nastavenia → Súkromie a bezpečnosť → Režim pre vývojárov (Developer Mode))"
  echo "   • iPhone je zamknutý"
  echo "   • Xcode ešte kopíruje súbory z iPhonu – otvor Xcode, počkaj a skús znova"
  fail "Build zlyhal."
fi
ok "WebDriverAgent je pripravený"

# až teraz zapni Xcode režim (aplikácia sa prepne sama)
/usr/bin/python3 - "$TEAM" <<'PY'
import json, sys
c = json.load(open("config.json")); c.pop("buildPending", None); c["teamId"] = sys.argv[1]
json.dump(c, open("config.json", "w"), indent=2)
PY
echo
echo "=============================================="
echo " ✅ HOTOVO. Aplikácia JD Phone Studio sa o chvíľu"
echo "    prepne do Xcode režimu – toto okno môžeš zavrieť."
echo "    Na iPhone zapni: Nastavenia → Súkromie a bezpečnosť"
echo "    → Režim pre vývojárov (Developer Mode)."
echo "=============================================="
read -r -p "Stlač Enter na zatvorenie…"
