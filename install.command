#!/bin/bash
# JD Phone Studio – jednorazová inštalácia. Dvojklik (prvýkrát pravý klik → Otvoriť).
cd "$(dirname "$0")"
DIR="$(pwd)"

ok()   { echo "  ✅ $1"; }
step() { echo; echo "▶ $1"; }
fail() { echo; echo "❌ $1"; echo; read -r -p "Stlač Enter na zatvorenie…"; exit 1; }

echo "=============================================="
echo "   JD Phone Studio – inštalácia"
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

# 2) Homebrew + Node + go-ios
step "Kontrolujem Node.js a go-ios"
if ! command -v node >/dev/null; then
  if ! command -v brew >/dev/null; then
    echo "  Inštalujem Homebrew (správca programov)…"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrew sa nenainštaloval."
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
  fi
  brew install node || fail "Node.js sa nenainštaloval."
fi
ok "Node.js $(node -v)"
if ! command -v ios >/dev/null; then
  npm install -g go-ios || sudo npm install -g go-ios || fail "go-ios sa nenainštaloval."
fi
ok "go-ios"
if ! command -v cloudflared >/dev/null; then brew install cloudflared || echo "  (cloudflared sa nenainštaloval – fotky/videá pôjdu len cez Wi-Fi)"; fi
command -v cloudflared >/dev/null && ok "cloudflared (fotky/videá cez mobilné dáta)"

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
  echo "   3. Spusti install.command znova"
  open -a Xcode
  fail "Chýba Apple ID v Xcode."
fi
ok "Tím: $TEAM"

USERSLUG=$(whoami | tr -cd 'a-zA-Z0-9' | tr 'A-Z' 'a-z')
BUNDLE=$(node -e 'try{process.stdout.write(require("./config.json").bundleId||"")}catch(_){}')
[ -z "$BUNDLE" ] && BUNDLE="com.${USERSLUG}.${TEAM}.WebDriverAgentRunner"
node -e '
const fs=require("fs");let c={};try{c=JSON.parse(fs.readFileSync("config.json","utf8"))}catch(_){}
c.teamId=process.argv[1];c.bundleId=process.argv[2];fs.writeFileSync("config.json",JSON.stringify(c,null,2));
' "$TEAM" "$BUNDLE"
ok "Uložené do config.json"

# 5) Telefón
step "Pripoj iPhone káblom, odomkni ho a ťukni „Dôverovať“"
for i in $(seq 1 60); do
  UDID=$(ios list 2>/dev/null | grep -Eo '"[0-9A-Fa-f-]{24,40}"' | head -1 | tr -d '"')
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

chmod +x "$DIR"/*.command 2>/dev/null

echo
echo "=============================================="
echo " ✅ HOTOVO. Teraz:"
echo "   1. Dvojklik na START_STRANKY.command (otvorí sa stránka)"
echo "   2. Na iPhone: Nastavenia → Súkromie a bezpečnosť → Režim pre vývojárov (Developer Mode) → Zapnúť"
echo "   3. Keď server nahrá aplikáciu do iPhonu: Nastavenia → Všeobecné →"
echo "      VPN a správa zariadení → tvoj účet → Dôverovať → Verify App"
echo "   4. Nastavenia → Vývojár → Enable UI Automation → Zapnúť"
echo
echo " Do minúty sa na stránke objaví obraz. Ďalší iPhone = len ho pripoj"
echo " a urob na ňom body 2–4, server ho nahrá sám."
echo "=============================================="
read -r -p "Stlač Enter na zatvorenie…"
