# JD - IphoneWall – inštalácia pre Windows
# Spúšťa sa cez install-windows.bat (dvojklik)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$Dir = $PSScriptRoot

function Ok($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Step($t) { Write-Host ""; Write-Host "> $t" -ForegroundColor Cyan }
function Fail($t) { Write-Host ""; Write-Host "[CHYBA] $t" -ForegroundColor Red; Read-Host "Stlac Enter na zatvorenie"; exit 1 }

Write-Host "=============================================="
Write-Host "   JD - IphoneWall - instalacia (Windows)"
Write-Host "=============================================="

# 1) Ovládače Apple (bez nich Windows iPhone neuvidí)
Step "Kontrolujem ovladace Apple"
$svc = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'Apple Mobile Device' -or $_.DisplayName -match 'Apple Mobile Device' }
if (-not $svc) {
  Write-Host "  Chyba aplikacia 'Apple Devices' (alebo iTunes). Otvaram Microsoft Store..."
  Start-Process "ms-windows-store://pdp/?productid=9NP83LWLPZ9K"
  Fail "Nainstaluj 'Apple Devices' z Microsoft Store, pripoj iPhone, tukni Dôverovať a spusti instalaciu znova."
}
Ok "Apple ovladace"

# 2) Node.js
Step "Kontrolujem Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $nodeDir = Join-Path $env:ProgramFiles 'nodejs'
    if (Test-Path (Join-Path $nodeDir 'node.exe')) { $env:Path = "$nodeDir;$env:Path" }
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Start-Process "https://nodejs.org/"
    Fail "Nainstaluj Node.js (LTS) z nodejs.org a spusti instalaciu znova."
  }
}
Ok "Node.js $(node -v)"

# 3) go-ios
Step "Stahujem go-ios"
$bin = Join-Path $Dir 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
if (-not (Test-Path (Join-Path $bin 'ios.exe'))) {
  $zip = Join-Path $env:TEMP 'go-ios-win.zip'
  $tmp = Join-Path $env:TEMP 'go-ios-win'
  Invoke-WebRequest 'https://github.com/danielpaulus/go-ios/releases/latest/download/go-ios-win.zip' -OutFile $zip -UseBasicParsing
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp -Force
  $exe = Get-ChildItem $tmp -Recurse -Filter 'ios.exe' | Select-Object -First 1
  if (-not $exe) { Fail "V go-ios balicku som nenasiel ios.exe." }
  Copy-Item $exe.FullName (Join-Path $bin 'ios.exe') -Force
  Get-ChildItem $exe.DirectoryName -Filter '*.dll' | Copy-Item -Destination $bin -Force
}
Ok "go-ios"

# cloudflared – fotky/videá do iPhonov na mobilných dátach
Step "Stahujem cloudflared"
if (-not (Test-Path (Join-Path $bin 'cloudflared.exe'))) {
  Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile (Join-Path $bin 'cloudflared.exe') -UseBasicParsing
}
Ok "cloudflared"

# 4) WebDriverAgent (hotová verzia od Appium, nepodpísaná)
Step "Stahujem WebDriverAgent"
$ipa = Join-Path $Dir 'WebDriverAgent.ipa'
if (-not (Test-Path $ipa)) {
  $zip = Join-Path $env:TEMP 'wda-runner.zip'
  $tmp = Join-Path $env:TEMP 'wda-runner'
  Invoke-WebRequest 'https://github.com/appium/WebDriverAgent/releases/latest/download/WebDriverAgentRunner-Runner.zip' -OutFile $zip -UseBasicParsing
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp -Force
  $app = Get-ChildItem $tmp -Recurse -Directory -Filter '*.app' | Select-Object -First 1
  if (-not $app) { Fail "V balicku WebDriverAgenta som nenasiel .app." }
  $pkg = Join-Path $env:TEMP 'wda-ipa'
  if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Join-Path $pkg 'Payload') | Out-Null
  Copy-Item $app.FullName (Join-Path $pkg 'Payload') -Recurse
  $tmpZip = Join-Path $env:TEMP 'WebDriverAgent.zip'
  if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force }
  Compress-Archive -Path (Join-Path $pkg 'Payload') -DestinationPath $tmpZip
  Move-Item $tmpZip $ipa -Force
}
Ok "WebDriverAgent.ipa je v priecinku"

# 5) Sideloadly – podpíše WDA tvojím Apple ID a nahrá ho do iPhonu
Step "Podpisanie a nahratie do iPhonu"
Write-Host "  Otvaram stranku Sideloadly (zadarmo). Stiahni verziu pre Windows, nainstaluj ju a potom:"
Write-Host "   1. Pripoj iPhone, odomkni, tukni Dôverovať"
Write-Host "   2. V Sideloadly pretiahni subor WebDriverAgent.ipa z tohto priecinka"
Write-Host "   3. Zadaj svoje Apple ID -> Start (moze pytat heslo / overovaci kod)"
Start-Process "https://sideloadly.io/"
Start-Process explorer.exe $Dir

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host " Potom na iPhone:" -ForegroundColor Green
Write-Host "   1. Nastavenia -> Sukromie a bezpecnost -> Rezim pre vyvojarov -> Zapnut (restart)"
Write-Host "   2. Nastavenia -> Vseobecne -> VPN a sprava zariadeni -> tvoj ucet -> Dôverovať"
Write-Host "   3. Nastavenia -> Vyvojar -> Enable UI Automation -> Zapnut"
Write-Host ""
Write-Host " A nakoniec dvojklik na START_STRANKY.bat"
Write-Host "==============================================" -ForegroundColor Green
Read-Host "Stlac Enter na zatvorenie"
