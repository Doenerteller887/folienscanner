# Folienscanner

Web-App fürs Handy (Android & iPhone): Du richtest die Kamera auf die Projektion im Hörsaal. Die App erkennt die Folie, zieht sie gerade (wie Adobe Scan) und nimmt **jede neue Folie automatisch** auf. Alle Folien landen fortlaufend in einem **PDF**, das du jederzeit teilen oder herunterladen kannst.

- Läuft komplett im Browser, ohne Installation aus dem App Store.
- Funktioniert offline, sobald die App einmal geladen wurde. Das ist praktisch bei schlechtem WLAN.
- Folien bleiben **nur auf deinem Handy** (im Browser-Speicher), bis du das PDF teilst.

**👉 App öffnen: <https://doenerteller887.github.io/folienscanner/>**

---

## 1. Eigene Kopie online stellen (optional, ca. 10 Minuten)

Nur nötig, wenn du eine eigene Version betreiben willst. Zum Benutzen reicht der Link oben.

Die Kamera funktioniert im Browser nur über eine sichere `https://`-Adresse. Am einfachsten und kostenlos geht das mit **GitHub Pages**:

1. Auf <https://github.com> ein kostenloses Konto anlegen.
2. Oben rechts **+ → New repository**:
   - Name: `folienscanner`
   - **Public** auswählen (GitHub Pages ist im kostenlosen Tarif nur für öffentliche Repositories verfügbar. Öffentlich ist nur der Programmcode, nicht deine Folien.)
   - **Create repository** klicken.
3. Auf der neuen Seite den Link **„uploading an existing file“** anklicken.
4. Den **Inhalt** dieses Ordners (also `index.html`, `css`, `js`, `lib`, `icons`, `test`, `sw.js`, `manifest.webmanifest`, `README.md`) ins Browserfenster ziehen. `index.html` muss dabei ganz oben liegen, nicht in einem Unterordner.
5. Unten **Commit changes** klicken.
6. Im Repository auf **Settings → Pages** gehen und unter *Build and deployment* einstellen:
   - Source: **Deploy from a branch**
   - Branch: **main**, Ordner **/ (root)**
   - Dann **Save** klicken.
7. Nach 1–2 Minuten erscheint dort die Adresse, z. B. `https://DEIN-NAME.github.io/folienscanner/`.

**Auf dem Handy:**
1. Die Adresse in **Chrome** (Android) oder **Safari** (iPhone) öffnen.
2. Zum Startbildschirm hinzufügen:
   - Android (Chrome): Menü **⋮ → „App installieren“** bzw. „Zum Startbildschirm hinzufügen“.
   - iPhone (Safari): **Teilen → „Zum Home-Bildschirm“**.

Danach startet der Folienscanner wie eine normale App.

> **Updates:** Wenn du später geänderte Dateien hochlädst, lädt die App sie beim nächsten Öffnen mit Internet automatisch.

---

## 2. Benutzung im Hörsaal

1. Namen der Vorlesung eingeben und **Scan starten** tippen. Die Kamera beim ersten Mal erlauben.
   - Auf Android wechselt die App dabei ins **Vollbild im Querformat**, auch wenn die Bildschirmdrehung gesperrt ist.
   - Das lässt sich in den Einstellungen abschalten.
2. Das **Handy quer** halten und auf die Projektion richten:
   - Ein blauer Rahmen zeigt die erkannte Folie.
   - Orange heißt „neue Folie, kurz ruhig halten“.
   - Danach blitzt es kurz, das Handy vibriert und unten erscheint „✓ Folie 12 gespeichert“.
3. Unten in der Leiste:

**Gesten im Kamerabild:**
- **Zwei Finger auseinanderziehen = zoomen.** Das ist wichtig, wenn du weiter hinten sitzt: Je größer die Folie im Bild, desto schärfer die Aufnahme. Alternativ den Knopf **1× / 2× / 3× …** über dem Auslöser antippen. Der Zoom wird für das nächste Mal gemerkt.
- **Folie antippen** = genau diese Folie verfolgen. Das hilft, wenn mehrere helle Flächen im Bild sind (Tafel, Fenster, Laptop).
- **Ecke ziehen** = Rahmen von Hand anpassen. Der Rahmen wird dabei fixiert.

| Knopf | Funktion |
|---|---|
| Vorschaubild mit Zahl | gespeicherte Folien ansehen (beendet den Scan) |
| ⏸ | Pause, z. B. während einer Tafelpause |
| ⚪ großer Auslöser | Folie **sofort** aufnehmen (geht immer) |
| 🔒 Schloss | Rahmen **fixieren**: Die Erkennung bleibt stabil, auch wenn jemand vor der Leinwand steht. Die Ecken kannst du mit dem Finger verschieben. |
| PDF | PDF über das Teilen-Menü schicken (Drive, OneNote-App, Mail …) |

4. Nach der Vorlesung: In der Galerie auf **PDF teilen** oder **Herunterladen** tippen.

### Tipps für gute Ergebnisse
- **Handy-Ständer oder kleines Stativ** benutzen bzw. das Handy an etwas anlehnen. Dann den Rahmen mit dem 🔒 fixieren. Das ist die zuverlässigste Variante.
- **Heranzoomen**, bis die Folie gut ein Drittel bis die Hälfte des Bildes füllt. Sie muss aber **komplett im Bild** bleiben, Folien am Bildrand werden absichtlich ignoriert.
- Möglichst **mittig** sitzen. Schräg geht auch, die App rechnet die Perspektive heraus.
- Ist die Folie **überstrahlt** (weiß ohne Details)? Dann in den Einstellungen die **Belichtung** nach links schieben (nicht jedes Handy bietet das an).
- Die App muss **im Vordergrund** bleiben. Der Bildschirm bleibt automatisch an. Für 90 Minuten lohnt sich eine Powerbank.
- Wird die Folie nicht gefunden: erst **antippen**, sonst auf 🔒 tippen und die vier Ecken auf die Folie ziehen.

### Einstellungen (⚙)
| Einstellung | Bedeutung |
|---|---|
| Automatisch aufnehmen | aus = nur noch der Auslöser nimmt auf |
| Empfindlichkeit | höher = reagiert schon auf einzelne neue Zeilen. Niedriger, wenn zu viel aufgenommen wird. |
| Wartezeit | so lange muss eine neue Folie ruhig stehen, bevor sie gespeichert wird |
| Aufbau-Animationen zusammenführen | Erscheinen Stichpunkte nacheinander, wird die Seite ergänzt statt neu angelegt. Am Ende steht die vollständige Folie im PDF. |
| Doppelte überspringen | Blättert der Dozent zurück, wird die Folie nicht noch einmal gespeichert. |
| Filter | *Verbessert* (Weißabgleich, Kontrast, Schärfe), *Original*, *Graustufen* |
| Seitenverhältnis | *Automatisch* erkennt 16:9 / 16:10 / 4:3 selbst |
| Ganzes Bild verwenden | für Bildschirmaufnahmen oder wenn die Folie das ganze Kamerabild füllt |

### Video importieren
Auf der Startseite **„Aufgezeichnetes Video importieren“** antippen. Die App spielt das Video durch und macht daraus ebenfalls ein PDF. Das funktioniert z. B. mit einer Handyaufnahme der Vorlesung oder einer Bildschirmaufnahme (dann in den Einstellungen **Ganzes Bild verwenden** wählen).

---

## 3. OneNote

**Jetzt schon möglich:** PDF teilen → **OneNote** auswählen. Alternativ am PC in OneNote **Einfügen → Dateiausdruck** mit dem heruntergeladenen PDF.

**Später (live):** Der Code ist dafür vorbereitet (`js/outputs.js`). Eine OneNote-Ausgabe würde sich per Microsoft-Konto anmelden, zu Beginn eine Seite „Vorlesung …“ anlegen und jede neue Folie über die Microsoft-Graph-Schnittstelle sofort anhängen (`PATCH …/onenote/pages/{id}/content`, Aktion `append`). Dafür muss die App einmalig bei Microsoft Entra registriert werden.

---

## 4. Wie es funktioniert (kurz)

1. **Erkennen** (`js/detector.js`): Etwa 4× pro Sekunde wird das Kamerabild verkleinert analysiert und nach hellen bzw. farbigen Vierecken mit klarer Kante gesucht (OpenCV). Jeder Kandidat wird bewertet:
   - Ist innen am Rand ein Hell-Dunkel-Sprung zu sehen? (Der Beamer kann nur Licht hinzufügen.)
   - Hat er Inhalt, also Kanten im Inneren? Leeres Papier, weiße Wände und leere Tafeln fallen raus.
   - Sind die Gegenseiten annähernd parallel?
   - Liegt er komplett im Bild?

   Die Lage des Handys kommt aus dem Bewegungssensor, damit die Folie auch bei gesperrter Bildschirmdrehung richtig herum gespeichert wird. Ein Glättungsfilter verhindert, dass der Rahmen zittert. Verdeckt jemand eine Ecke, bleibt der alte Rahmen erhalten.
2. **Entzerren** (`js/rectify.js`): Perspektivkorrektur. Das echte Seitenverhältnis wird aus der Verzerrung berechnet (Methode von Zhang & He), danach folgt die Bildverbesserung.
3. **Neue Folie?** (`js/change.js`): Ein kleiner „Fingerabdruck“ der Folie (96×60 Pixel, 16×10 Zellen) wird mit der letzten gespeicherten Folie verglichen. Bei genug geänderten Zellen muss das neue Bild etwa 1,2 s stabil bleiben, dann wird das schärfste Bild gespeichert. Zusätzlich:
   - Dunkle Flächen, die vom Rand hereinragen, gelten als Person vor der Leinwand und werden ignoriert.
   - Kommen nur neue Inhalte auf leerem Hintergrund dazu, ist das eine Aufbau-Animation und die Seite wird ergänzt.
   - Leere oder schwarze Bilder werden übersprungen.
4. **Speichern & PDF** (`js/storage.js`, `js/pdf.js`, `js/outputs.js`): Die Folien landen als JPEG in IndexedDB. Das PDF wird nach jeder neuen Folie im Hintergrund neu erstellt, damit „Teilen“ sofort klappt.

### Test
`test/synthetic.html` erzeugt eine künstliche Vorlesung mit diesen Elementen:
- schräg projizierte Folien, Rauschen und Helligkeitsflackern,
- ein heller Hörsaal mit kleiner, weit entfernter Folie, Handy quer bei gesperrter Drehung, leerer Tafel daneben und Papier vorne am Bildrand,
- Stichpunkte, die nacheinander erscheinen,
- eine Person, die vorbeiläuft, und eine, die vor der Folie stehen bleibt,
- Zurückblättern und eine schwarze Folie.

Die Seite schickt alles durch dieselbe Pipeline wie die App und prüft das Ergebnis.

Lokal starten:

```bash
python -m http.server 8765 --directory folienscanner
```

Dann <http://localhost:8765/test/synthetic.html> öffnen.

Außerdem gibt es `test/photos.html?src=<Ordner-URL>`: Die Seite schickt echte Fotos (Liste in `liste.json` im angegebenen Ordner, Server mit CORS) als stillstehendes Kamerabild durch die Pipeline und baut daraus ein PDF. Die Testfotos selbst gehören nicht in diesen Ordner. Die App selbst läuft lokal unter <http://localhost:8765/> (mit Webcam).

### Verwendete Bibliotheken (liegen in `lib/`)
- [OpenCV.js](https://opencv.org/) 4.10 (Apache 2.0) – Bildverarbeitung
- [jsPDF](https://github.com/parallax/jsPDF) 2.5.2 (MIT) – PDF-Erstellung
