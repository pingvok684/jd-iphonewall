// Šablóny AI príkazov (rozbaľovacie menu na stránke). Uložené v templates.json.
// Text v [hranatých zátvorkách] stránka pri výbere vypýta.

const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'templates.json');

const MUSIC = 'Hudba: „[Pesnička (prázdne = prvá v ponuke, nie = bez hudby)]“. Ak je v úvodzovkách pri Hudba slovo nie, hudbu nepridávaj. Inak v editore ťukni na ikonu hudby (♫ / Add audio / Pridať hudbu / Music). Ak sú úvodzovky prázdne, nič nevyhľadávaj a vyber úplne PRVÚ pesničku v zozname, ktorý sa otvorí (záložka For you / Pre teba alebo Trending). Ak je tam názov pesničky, napíš ho do vyhľadávania a vyber výsledok so správnym interpretom; ak sa nedá nájsť, vyber prvú pesničku v ponuke. Ponechaj predvolený úsek a ťukni Done / Hotovo.';

const DEFAULTS = [
  { name: '🎬 Postni reel', text: 'Otvor Instagram. Ťukni na + (nový príspevok) a vyber REEL. V galérii hore ťukni na názov albumu (Recents / Nedávne) a vyber album Videos / Videá, aby sa zobrazili len videá. Potom vyber prvé (najnovšie) video vľavo hore. Ak album Videos v zozname nie je, scrolluj galériou nadol, kým nenájdeš video (spoznáš ho podľa dĺžky v rohu, napr. 0:12), a vyber to najnovšie. Nekonči, kým video nenájdeš – fotku namiesto videa nevyberaj. Ťukni Next. ' + MUSIC + ' Potom ťukni Next. Do popisu napíš presne tento text: [Popis + #hashtagy]. Ak je v nastaveniach príspevku možnosť „AI label“ / „Pridať označenie AI“, zapni ju. Potom ťukni Share. Počkaj, kým sa reel nahrá, a skontroluj, že sa objavil na profile. Potom skonči.' },
  { name: '🖼️ Postni carousel', text: 'Otvor Instagram. Ťukni na + a vyber POST (príspevok). V galérii ťukni na ikonu pre výber viacerých (dva prekrývajúce sa štvorčeky). Postupne vyber [Počet fotiek] najnovšie fotky v poradí zľava doprava, začni prvou vľavo hore. Ťukni Next. ' + MUSIC + ' Potom ťukni Next (bez filtrov). Do popisu napíš presne: [Popis + #hashtagy]. Ak je v nastaveniach možnosť „AI label“, zapni ju. Ťukni Share, počkaj na nahratie a skonči.' },
  { name: '⭕ Pridaj story', text: 'Otvor Instagram. Ťukni na svoju profilovú fotku vľavo hore (pridať do Story). Vyber najnovšie video/fotku v galérii. ' + MUSIC + ' (V story je hudba pod ikonou ♫ hore alebo v nálepkách – ikona so smajlíkom – položka MUSIC; nálepku s pesničkou nechaj tam, kde sa objaví.) Potom ťukni na „Your story“ / „Tvoj príbeh“. Počkaj, kým sa nahrá, a skonči.' },
  { name: '🗓️ Naplánuj reel', text: 'Otvor aplikáciu Meta Business Suite. Ťukni na „+“ / „Create“ / „Vytvoriť“ a vyber Reel. Pri výbere účtov / umiestnení (Placements / Post to) nastav: [Kam zverejniť|Len Instagram|Instagram aj Facebook]. V galérii prepni album na Videos / Videá (alebo scrolluj, kým nenájdeš video – spoznáš ho podľa dĺžky v rohu, napr. 0:12) a vyber najnovšie video. Fotku namiesto videa nevyberaj. Ťukni Next / Ďalej. Ak editor ponúka hudbu (Audio / Music), postupuj takto: ' + MUSIC + ' Ak hudbu neponúka, pokračuj bez nej. Do popisu napíš presne: [Popis + #hashtagy]. Ak je možnosť označiť obsah ako vytvorený AI (AI info / AI label), zapni ju. Potom otvor „Scheduling options“ / „Možnosti plánovania“, vyber „Schedule for later“ / „Naplánovať na neskôr“ a nastav dátum a čas: [Dátum a čas (napr. 15. 10. o 18:30)]. Potvrď a ťukni „Schedule“ / „Naplánovať“ – NIE „Publish now“ / „Zverejniť teraz“. Na konci otvor v Meta Business Suite plánovač (Planner / Content → Scheduled) a over, že príspevok je naplánovaný na správny čas. Potom skonči. Ak sa niečo nedá nájsť, nič nezverejňuj a skonči so správou, kde si sa zasekol.' },
  { name: '🗓️ Naplánuj carousel', text: 'Otvor aplikáciu Meta Business Suite. Ťukni na „+“ / „Create“ / „Vytvoriť“ a vyber Post / Príspevok. Pri výbere účtov / umiestnení (Placements / Post to) nastav: [Kam zverejniť|Len Instagram|Instagram aj Facebook]. Ťukni na pridanie fotiek (Add photo/video) a vyber [Počet fotiek|2|3|4|5|6|7|8|9|10] najnovšie fotky v poradí – začni prvou vľavo hore. Potvrď výber. Ak editor ponúka hudbu (Audio / Music), postupuj takto: ' + MUSIC + ' Ak hudbu neponúka, pokračuj bez nej. Do textu príspevku napíš presne: [Popis + #hashtagy]. Ak je možnosť označiť obsah ako vytvorený AI, zapni ju. Potom otvor „Scheduling options“ / „Možnosti plánovania“, vyber „Schedule for later“ / „Naplánovať na neskôr“ a nastav dátum a čas: [Dátum a čas (napr. 15. 10. o 18:30)]. Potvrď a ťukni „Schedule“ / „Naplánovať“ – NIE „Publish now“ / „Zverejniť teraz“. Na konci otvor v Meta Business Suite plánovač (Planner / Content → Scheduled) a over, že príspevok je naplánovaný na správny čas. Potom skonči. Ak sa niečo nedá nájsť, nič nezverejňuj a skonči so správou, kde si sa zasekol.' },
  { name: '🗓️ Naplánuj viac reelov', multi: 'reel', desc: 'V jednom kroku naplánuje 2 až 10 reelov v Meta Business Suite – každý s vlastným popisom, hudbou a časom', text: '' },
  { name: '🗓️ Naplánuj viac carouselov', multi: 'carousel', desc: 'V jednom kroku naplánuje 2 až 10 carouselov v Meta Business Suite – každý s vlastnými fotkami, popisom a časom', text: '' },
  { name: '🔎 Prieskum reels', text: 'Otvor Instagram. Profil na prieskum: „[Profil (napr. @sophieraiin alebo Donald Trump; prázdne = bežný Reels feed)]“. Ak je profil v úvodzovkách prázdny, prejdi do záložky Reels. Ak je vyplnený, ťukni na Hľadať (lupa), napíš ho do vyhľadávania a otvor správny účet (pri mene osobnosti vyber overený účet s modrou fajkou alebo ten s najviac sledovateľmi), na jeho profile otvor záložku Reels a ťukni na prvý reel. Postupne si pozri [Počet reelov|5|10|15|20|25] reelov: pri každom počkaj pár sekúnd (wait), potom potiahni nahor na ďalší. Reklamy preskakuj: ak má reel označenie Sponsored / Sponzorované / Reklama / Ad alebo tlačidlo typu Shop now / Learn more / Install / Nakupovať, nečakaj a hneď použi nástroj skip_ad – reklama sa nepočíta medzi prezreté reely a do prehľadu ju nezaraď. NIČ nelajkuj, nesleduj, nekomentuj, nezdieľaj ani neukladaj – iba pozeraj. Pri každom si všimni hook (prvý text na obrazovke alebo prvá veta), formát videa, prostredie/outfit, pesničku a ak je vidieť, počet zhliadnutí. Na konci mi napíš prehľad: čí profil (alebo feed) si pozeral, očíslovaný zoznam reelov s hookom, formátom a zhliadnutiami a potom 3 opakujúce sa trendy, ktoré by sa dali použiť pre náš obsah. Potom choď na plochu a skonči.' },
  { name: '📊 Skontroluj posledný post', text: 'Otvor Instagram, choď na svoj profil a otvor posledný príspevok. Zisti, koľko má zhliadnutí (pri reeli počet prehratí pod videom alebo v štatistikách; pri príspevku „Zobraziť štatistiky“ / „View insights“ – ak nie sú, použi počet lajkov a napíš to). Nič nemeň, nelajkuj, nekomentuj ani nezdieľaj. Na konci zavolaj done a v zhrnutí uveď presne v tomto tvare: ZHLIADNUTIA: <číslo>; DÁTUM: <dátum príspevku>; TYP: reel alebo post. Potom choď na plochu.' },
];

function load() {
  try { const t = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (Array.isArray(t)) return t; } catch (_) {}
  return DEFAULTS.slice();
}
function save(list) { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); }

function upsert(name, text) {
  name = String(name || '').trim().slice(0, 60); text = String(text || '').trim().slice(0, 4000);
  if (!name || !text) throw new Error('Chýba názov alebo text šablóny');
  const list = load();
  const i = list.findIndex((t) => t.name === name);
  if (i >= 0) list[i].text = text; else list.push({ name, text });
  save(list);
  return list;
}
function remove(name) { const list = load().filter((t) => t.name !== name); save(list); return list; }
function reset() { save(DEFAULTS.slice()); return load(); }

module.exports = { load, upsert, remove, reset, DEFAULTS };
