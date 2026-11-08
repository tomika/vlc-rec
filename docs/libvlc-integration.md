# Beágyazott VLC-lejátszó: működés és visszatesztelés

Ez a dokumentum azoknak szól (embernek vagy MI-modellnek), akik ellenőrizni vagy tovább fejleszteni szeretnék a libVLC-integrációt. A parancsokat a repó gyökeréből kell futtatni. Mindegyik lépésnél szerepel a várt eredmény. Ha az eredmény eltér, állj meg, és nézd meg a [Hibakeresés](#hibakeresés) részt.

## Működés

A videó és a felvétel nem külső VLC-ablakban fut, hanem a `vlc-rec-player` segédprogramban, ami libVLC 3-at használ, és az alkalmazás ablakába rajzol.

```text
Neutralino ablak (app.js)
   │  spawnProcess: egy folyamat szegmensenként
   │  stdin:  RECT x,y,w,h | HIDE | SHOW | STOP
   │  stdout: JSON sorok (started, stats, error, stopped)
   ▼
vlc-rec-player (native/vlc-rec-player.c)
   ├─ megkeresi az ablakot a NL_PID alapján, és gyerekablakot nyit benne
   └─ libVLC 3: lejátszás és felvétel (sout: duplicate{file, display})
```

| Fájl | Szerepe |
|---|---|
| [native/vlc-rec-player.c](../native/vlc-rec-player.c) | A lejátszó. A fejléc-megjegyzése a protokoll pontos leírása. |
| [native/build.sh](../native/build.sh), [native/Containerfile](../native/Containerfile), [scripts/build-player.js](../scripts/build-player.js) | Konténeres fordítás Linuxra és Windowsra, VLC SDK nélkül. |
| [src/frontend/app.js](../src/frontend/app.js) | `findPlayerBinary`, `buildPlayerCommand`, `sendPlayerCommand`, `handlePlayerOutput`. |
| [tests/reconnect.test.js](../tests/reconnect.test.js) | Unit tesztek. |
| [tests/e2e/](../tests/e2e/) | Végponttól végpontig tartó (E2E) tesztek a valódi ablakban. |
| [tests/fixtures/libvlc-stub.c](../tests/fixtures/libvlc-stub.c) | libVLC-csonk, amivel VLC nélkül is tesztelhető a lejátszó. |

Fontos viselkedések:

- **Választás futásidőben:** ha a `player/vlc-rec-player-<os>_<arch>` fájl létezik, az app ezt használja. Ha nem (macOS, ARM Linux), a korábbi módon külső VLC-t indít, és a videópanel rejtve marad.
- **Linux:** a beágyazás X11 ablakot igényel, ezért a `run-vlc-rec.sh` beállítja a `GDK_BACKEND=x11,wayland` változót. Wayland-munkameneten így XWaylanden fut az app. A libVLC 3-nak nincs natív Wayland-beágyazása.
- **A stream elvesztése:** a libVLC ilyenkor is `Playing` állapotot jelez. A kiesést ezért a fájl növekedése (felvétel) és a `readBytes` számláló (preview) figyelésével kell észlelni.
- **`readBytes`:** 32 bites számláló, ami túlcsordulhat, ezért csak egyenlőségre szabad vizsgálni.
- **A lejátszó nem élheti túl az appot:** a stdin lezárása vagy a szülőfolyamat eltűnése leállítja, és a leállítás lezárja a fájlt.

## Előfeltételek

| Eszköz | Mihez kell |
|---|---|
| Node.js 18+ és `npm install` | Minden lépéshez |
| podman vagy docker | Fordítás, Linuxos tesztek |
| VLC 3 és ffmpeg SRT-támogatással | Csak a Windowsos `test:e2e:real` futáshoz |

Az E2E tesztek néhány percig felül lebegő ablakot nyitnak. Közben ne használd az egeret az ablak fölött.

## Visszatesztelés

### 1. Fordítás

```bash
npm run build:player
```

Várt eredmény: létrejön a `player/vlc-rec-player-linux_x64`, a `player/vlc-rec-player-win_x64.exe` és a `tests/fixtures/stub/` mappa.

### 2. Unit tesztek

```bash
npm test
```

Várt eredmény: `pass 41`, `fail 0`.

### 3. Linux, podmanben

```bash
npm run test:e2e:linux
```

Ez három futás: `stub`, `x11` és `sway`, az utóbbi kettő valódi libVLC-vel és valódi SRT-adóval. Egy futás külön is indítható: `node tests/e2e/run-linux.js x11`.

Várt eredmény: `Linux e2e: all runs PASSED`, a képernyőképek az `e2e-output/x11/` és az `e2e-output/sway/` mappában.

### 4. Windows, csonkkal

```bash
npm run test:e2e
```

Várt eredmény: `E2E PASSED`. Ez a valódi ablakot, a gyerekablakot, a parancsokat, a leállítást és az összeomlás utáni újraindítást ellenőrzi, valódi videó nélkül.

### 5. Windows, valódi VLC-vel

**Ez a lépés még egyszer sem futott**, ez a legfontosabb hátralévő ellenőrzés.

```powershell
winget install VideoLAN.VLC
winget install Gyan.FFmpeg
# Nyiss új terminált, hogy az ffmpeg a PATH-ban legyen, és némítsd le a hangot:
# a tesztjel 1 kHz-es hang, amit a VLC a hangszórón is lejátszik.
npm run test:e2e:real
```

Várt eredmény: `E2E PASSED`. Ha az ffmpeg nincs a PATH-ban, az `E2E_FFMPEG` és az `E2E_FFPROBE` környezeti változóval megadható az útvonala.

Külön figyeld ezeket, mert a csonk nem tudja ellenőrizni:

- A VLC valóban a panelbe rajzol-e, és nem nyit külön ablakot.
- Az ékezetes, szóközös és zárójeles mappába készült felvétel ép-e (`rec.mkv` ellenőrzései).
- A lejátszó megtalálja-e a libVLC-t a registryből, mert ez az útvonal még nem futott.

### 6. AppImage, több disztribúción

```bash
npm run package:appimage
npm run test:e2e:appimage
```

Az eredmény a `dist/vlc-rec-x86_64.AppImage`. A teszt podmant igényel, tiszta konténerekben futtatja a csomagot: ezekben nincs VLC, WebKit vagy GTK. Egy gép külön is indítható: `node tests/e2e/run-appimage.js fedora`.

Várt eredmény: minden sor `PASSED`, a képernyőképek az `e2e-output/appimage/` mappában. Az `ubuntu22` akkor `PASSED`, ha az app érthető hibaüzenettel megtagadja az indulást. A `nofuse` gépen `NOTE` sor jelzi a kicsomagolós módot, ez nem hiba.

### 7. Kézi ellenőrzés a valódi eszközzel

Ezek konténerben nem vizsgálhatók, Linuxon és Windowson is el kell végezni:

- [ ] A valódi SRT-eszköz streamje megjelenik, a hang megszólal, a kép nem akadozik.
- [ ] A felvétel kb. 10 perc után is lejátszható MKV-ban és MP4-ben is.
- [ ] A videó fölött és mellett kattintva a gombok működnek, a mezőkbe lehet gépelni.
- [ ] Az ablak mozgatásakor, átméretezésekor, teljes méretre nagyításakor a videó a panelben marad.
- [ ] Nem 100%-os Windows-méretezésnél (pl. 150%) a videó pontosan fedi a panelt.
- [ ] A Windowson nem villan fel konzolablak a lejátszó indulásakor.
- [ ] Linuxon GNOME és KDE alatt is megjelenik a kép, NVIDIA kártyával is, ha van ilyen gép. Ha az ablak üres, nézd meg a Hibakeresés részt.
- [ ] Az eszköz kikapcsolásakor új számozott fájl indul, visszakapcsoláskor folytatódik a felvétel.
- [ ] Az AppImage valódi asztali gépen is elindul Ubuntu 24.04 alatt, ahol az AppArmor korlátozza a névtereket, és Fedorán vagy Archon PipeWire-rel is szól a hang.

## Tesztelési állapot (2026-11-02)

| Ellenőrzés | Eredmény |
|---|---|
| Unit tesztek | 41/41 zöld |
| Linux E2E: csonk, X11 és Sway valódi libVLC-vel | 225 ellenőrzés, 0 hiba |
| Windows E2E csonkkal | 69 ellenőrzés, 0 hiba. A `closewhile` eset 18 futásból egyszer nem fejeződött be 240 másodperc alatt, az ok ismeretlen, a napló nem maradt meg |
| AppImage FUSE-szal: Debian 12 és 13, Ubuntu 24.04, Fedora 44, Arch | Gépenként 95 ellenőrzés, 0 hiba |
| AppImage FUSE nélkül, kicsomagolós módban (Ubuntu 24.04) | 94 ellenőrzés, 0 hiba |
| AppImage Sway alatt, XWaylanden, a rendszerben is meglévő VLC-vel és WebKittel | 94 ellenőrzés, 0 hiba, a csomagolt könyvtárak töltődnek be |
| AppImage Ubuntu 22.04-en (glibc 2.35) | Érthető hibaüzenettel nem indul, ez a várt viselkedés |
| Hang a csomagolt libVLC-ből PulseAudio-szerverre, egyszeri kézi próba | A jel megérkezik, a csúcsérték a tesztjelnek felel meg |
| Csomagolt app más munkakönyvtárból, Linux és Windows | A videópanel megjelenik |
| Windows E2E valódi VLC-vel | **Nem futott** |
| GitHub Actions módosítás | **Nem futott** |
| Valódi SRT-eszköz, valódi GPU, GNOME/KDE, nem 100%-os méretezés, PipeWire | **Nem futott** |

## Hibakeresés

| Tünet | Teendő |
|---|---|
| Egy E2E forgatókönyvet kell újrafuttatni | `E2E_ONLY=main` (`main`, `closewhile`, `hardkill`, `wrongversion`, `novlc`) |
| Nem világos, mi történt | Képernyőképek és naplók: `e2e-output/`. A `*-app.log` a lejátszó hibáit is tartalmazza. |
| `libVLC was not found` | Telepítsd a VLC 3-at. Windowson a `VLC_REC_LIBVLC_DIR` megadhatja a mappát, Linuxon kell a `libvlc5` csomag. |
| Linuxon `No X11 window found` vagy `no-x11-display` | Az app nem X11-en fut. Indítsd `run-vlc-rec.sh`-val, fejlesztéskor `GDK_BACKEND=x11 npm start`. |
| Linuxon a lejátszó elindul, de nincs kép és a számláló nem nő | Lehet, hogy hiányzik az SRT-modul. Debian/Ubuntu: `sudo apt install vlc-plugin-access-extra`. A Snap és a Flatpak VLC nem használható. |
| Linuxon üres vagy fekete az app ablaka | A launcher már beállítja a `WEBKIT_DISABLE_DMABUF_RENDERER=1` változót. Próbáld a `WEBKIT_DISABLE_COMPOSITING_MODE=1` változót is. |
| Windowson az első indítás 20 másodperc körüli | Új `.exe` első futásakor kétszer mértük ezt, a későbbi indítások kb. 1 másodpercesek. Valószínűleg víruskereső-ellenőrzés, ezt nem igazoltuk. |
| `Neutralino.*` hívás jogosultsági hibát ad | A `nativeAllowList` szándékosan szűk. Az E2E csak a saját másolatában engedi a `window.*` hívásokat. |
| Az AppImage `Cannot mount AppImage` hibát ír | Nincs FUSE a gépen. Telepítsd a `fuse3` csomagot, vagy indítsd `--appimage-extract-and-run` kapcsolóval. |
| Az AppImage azt írja, hogy `needs glibc` | A rendszer régebbi, mint a Debian 12. Ott a `vlc-rec-linux-x64.tar.gz` és a disztribúció VLC-je használható. |
| Az AppImage hiányzó könyvtárra panaszkodik | A `build-appimage.sh` `is_host_library` listája a hostra bízott könyvtárakat sorolja fel. Ha egy asztali rendszeren is hiányzik egy ilyen, vedd ki a listából. |
| Az AppImage azonnal szegmentációs hibával leáll | Kövesd a betöltőt: `LD_DEBUG=files` a kicsomagolt `usr` mappából. Ne változtass hosszt a WebKit bináris cseréjénél, ezért ellenőrzi a build a fájlméretet. |

Két csapda E2E-fejlesztéshez:

- A `--path` kapcsolónak Windowson is perjeles útvonal kell, különben a `NL_PATH` hibás lesz.
- Windows-mappára csatolt konténerkötetben a `fs.copyFileSync` `EPERM` hibát ad, ezért ott írás-olvasással kell másolni.

## Ismert korlátok

- A videó natív ablak, ezért HTML nem kerülhet fölé. Ezért rejti el az app, amíg a Scan dialógus nyitva van.
- Natív Wayland-beágyazás a libVLC 4 stabil kiadásáig nem lehetséges, addig az XWayland kell.
- Lejátszó csak x64-re készül. ARM Linuxon és macOS-en marad a külső VLC-ablak.
- A kiadási zip nem őrzi meg a futtatási jogot, ezért Linuxra a `vlc-rec-linux-x64.tar.gz` a javasolt csomag.
- A felvétel indításakor 1-3 `could not write frame` üzenetet láttunk a libVLC-től. A fájlok ennek ellenére dekódolhatók, az első képkockák kieshetnek.

## AppImage

A [packaging/appimage/](../packaging/appimage/) mappa Debian 12-es konténerben építi a csomagot. Tartalma az app, a lejátszó, a libVLC a pluginekkel és az SRT-vel, a WebKitGTK 4.0, a GTK, valamint a `vlc` és a `zenity`.

Miért így működik:

- **Debian 12 az alap:** a csomag ezért glibc 2.36-ot igényel, az Ubuntu 22.04 és a Linux Mint 21 kimarad. Az Ubuntu 22.04-es alappal a kör bővülne, de annak a tárolójában csak a régi VLC 3.0.16 van.
- **RUNPATH, nem `LD_LIBRARY_PATH`:** az app host-programokat is hív (`bash`, `ip`, `ffprobe`), és ezek nem kaphatnak idegen könyvtárakat.
- **A host adja:** a glibc-t, a libstdc++-t, a GL-stacket, az X11 alapkönyvtárait, a fontconfigot, a freetype-ot, a harfbuzzt, az ALSA-t, a zlibet és az expatot. A GPU-driverek és a host konfigurációja ezekhez kötődnek.
- **WebKit 4.0, nem 4.1:** a Neutralino először a 4.0-t keresi. Ha a csomagban 4.1 lenne, a 4.0-val rendelkező gépen a rendszer példánya töltődne be.
- **Bináris csere a WebKitben:** a segédfolyamatok útvonala fix, csak fejlesztői builden állítható. Ezért lesz belőle munkakönyvtárhoz képest relatív útvonal, és ezért lép az AppRun a `usr` mappába. Ettől látszik a mappaválasztó oldalsávjában egy `usr` könyvjelző.
- **`vlc` a csomagban:** a Scan enélkül minden portot nem SRT-nek jelölne egy VLC és ffmpeg nélküli gépen.
- **`zenity` és `which` a csomagban:** a Neutralino dialógusai ezeket hívják. Fedorán és Archon a `which` sem biztos, hogy telepítve van.
- **Beállítások:** a képfájl csak olvasható, ezért az AppRun a `~/.config/vlc-rec` mappát adja át `--path` kapcsolóként, a lejátszót pedig a `VLC_REC_PLAYER_DIR` változó jelöli ki.
- **Az AppRun megvárja a lejátszót:** ha az app összeomlik, a lejátszó még lezárja a fájlt, és ehhez kell a csatolás.

Korlátok:

- A hardveres videódekódolás a csomagolt libVLC-vel nem volt tesztelve.
- Ha valaki egyszerre, `SIGKILL`-lel öli meg az appot és az AppRun-t, a csatolás eltűnik a lejátszó alól, és a fájl vége elveszhet.
- Csak x86-64-re készül.
- A CI nem építi, mert a mérete miatt túl sok tárhelyet foglalna, ezért helyben kell elkészíteni. A lépés ki van kommentezve a `ci-release.yml`-ben, így a visszakapcsolása sem futott még.
- A csomag GPL és LGPL alatti programokat tartalmaz, ezek listája és licence a `usr/share/doc/third-party` mappában van. Aki terjeszti a fájlt, annak a forráskódra vonatkozó kötelezettségeket is teljesítenie kell, és a H.264/HEVC kodekek szabadalmi kérdését is mérlegelnie kell.
