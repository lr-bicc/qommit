# Runbook: Spike gegen den Qlik-Testserver

Wegwerf-Extension „Qommit Spike“. Sie blendet auf App-Seiten von `https://qlik.example.com` unten links den Button **„Run spike probes“** und daneben zwei Checkboxen ein:

- **„Include DoSave probe (P7)“** – standardmäßig **nicht** angehakt. Ohne Haken wird P7 als „skipped: DoSave probe not selected“ berichtet.
- **„Include new-app probe (P9)“** – standardmäßig **angehakt**. Ohne Haken wird P9 als „skipped: new-app probe not selected“ berichtet.

Ein Klick führt die Probes P11, P1, P4, P6, P9 (nur mit Haken), P10, P8, P2, P5, P3 und P7 (nur mit Haken) nacheinander aus (Fortschritt steht im Button) und lädt danach `spike-report-<Zeitstempel>.json` herunter. Die Felder `includeDoSave` und `includeNewApp` im Bericht zeigen, wie gelaufen wurde.

**Dauer:** Normalerweise Sekunden bis wenige Minuten. Jede Probe hat ein eigenes Zeitlimit und der Bericht kommt in jedem Fall; im ungünstigsten Fall (alle Probes laufen in ihr Zeitlimit) dauert ein Lauf aber bis zu **ca. 33 Minuten** mit beiden Haken, ca. 29 Minuten ohne DoSave-Haken bzw. ca. 23 Minuten ohne beide Haken. **Solange der Button einen Fortschritt („Running P… (x/11)…“) zeigt, die Seite nicht neu laden, nicht wegnavigieren und den Tab nicht schließen** – sonst gibt es keinen Bericht, angelegte `spike-…`-Objekte bleiben eventuell liegen und die von P9 angelegte App wird eventuell nicht gelöscht. Erst wenn der Button „Done: …“ zeigt, ist der Lauf fertig.

**Wichtig – die Probes verändern die geöffnete App.** Deshalb nur auf Kopien bzw. der Wegwerf-App ausführen, nie auf einer produktiv genutzten App:

- P2 legt `spike-dimension`, `spike-measure`, `spike-masterobject`, `spike-sheet`, `spike-story` und die Variable `spike-variable` (Name `spike_variable`) an und löscht sie wieder.
- P9 legt im eigenen Arbeitsbereich („Meine Arbeit“) eine neue App `spike-probe-<Zeitstempel>` an, legt darin dieselben `spike-…`-Objekte an, kopiert die erste Story der geöffneten App hinein und löscht die neue App am Ende wieder. Die geöffnete App ändert P9 nicht.
- P5 lädt `spike-probe.txt` in die App-Inhaltsbibliothek hoch und löscht sie wieder.
- P3 legt das Objekt `spike-qommit-link` an und lässt es **absichtlich** in der App (die Berichte A2 und B prüfen, ob es erhalten bleibt und mitkopiert wird).
- P7 speichert die App (`DoSave`) – nur wenn die Checkbox angehakt ist.

P1, P4, P6, P8, P10 und P11 lesen nur.

**Was im Bericht steht:** die Qlik-Benutzer-ID und das Benutzerverzeichnis (aus der Anmeldung der Engine-Sitzung), Server, App-ID und App-Titel, die Prüfsummen (Git-Blob-SHA) und Größen der Dateien, die das Tool aus der App ins Repository schreiben würde, je Objektgruppe ein Beispielobjekt sowie die App-Eigenschaften im vollen Wortlaut, außerdem Fehlermeldungen und Zählwerte der einzelnen Probes. Der CSRF-Token steht nicht im Bericht (nur, ob und wo er gefunden wurde, und seine Länge), ebenso keine Daten aus den Tabellen der App (ein Bookmark-Beispiel enthält allerdings die darin gespeicherten Auswahlwerte).

## 1. Extension bauen und laden

1. Im Repo-Wurzelverzeichnis: `npm install` (falls noch nicht geschehen), dann `node spike/build.mjs`. Danach muss `spike/dist/content.js` existieren.
2. In Chrome `chrome://extensions` öffnen → oben rechts **Entwicklermodus** einschalten → **„Entpackte Erweiterung laden“** → den Ordner `spike/` wählen (den Ordner, in dem `manifest.json` liegt).
3. Die Extension braucht keine Berechtigungen. Sie läuft nur auf `https://qlik.example.com/*`.

## 2. Bericht A: Kopie 1 einer versionierten App

1. Im Hub eine veröffentlichte, mit gitoqlok versionierte App duplizieren (z. B. „Sales Overview“). Das ist **Kopie 1**.
2. Kopie 1 öffnen (App-Übersicht oder ein Sheet). Unten links erscheint „Run spike probes“. Falls nicht: Seite neu laden.
3. **Checkbox „Include DoSave probe (P7)“ NICHT anhaken** (Standard). „Include new-app probe (P9)“ angehakt lassen (Standard).
4. Auf „Run spike probes“ klicken und warten, bis der Button „Done: …“ zeigt. Im Bericht muss `"includeDoSave": false` stehen.
5. Die heruntergeladene Datei als **Bericht A** ablegen (z. B. in `spike-report-A.json` umbenennen).
6. In Kopie 1 jetzt **nichts bearbeiten** und die Seite nicht neu laden: Die Qlik-Oberfläche speichert Bearbeitungen selbsttätig und würde dabei auch das Link-Objekt speichern.

## 3. Bericht A2: Bleibt das Link-Objekt ohne `DoSave` erhalten?

Die Kopie wird hier dupliziert statt neu geladen: Beim Neuladen derselben App kann die Engine das Objekt noch im Speicher haben, obwohl es nie gespeichert wurde.

1. **Direkt nach Bericht A** Kopie 1 im Hub duplizieren. Das ist **Kopie 2**.
2. Kopie 2 öffnen, **Checkbox „Include DoSave probe (P7)“ NICHT anhaken** und die Probes ausführen. Datei als **Bericht A2** ablegen (`"includeDoSave": false`).
   - `existedBefore: true` in P3 heißt: Das Link-Objekt `spike-qommit-link` aus Lauf A blieb **ohne `DoSave`** erhalten und wurde mitkopiert.

## 4. Bericht B1 und Bericht B: Wird das Link-Objekt nach dem Speichern mitkopiert?

1. **Bericht B1:** Kopie 1 öffnen bzw. ihre Seite neu laden (F5), dann **Checkbox „Include DoSave probe (P7)“ ANHAKEN** und die Probes ausführen. Datei als **Bericht B1** ablegen (`"includeDoSave": true`).
   - P7 beantwortet die Frage „`DoSave` und Daten“ (Frage 7) und speichert dabei das Link-Objekt dauerhaft in Kopie 1.
   - Hinweis: In Lauf A wurden die P2-Objekte zwar gelöscht, aber nicht gespeichert. Das `DoSave` in Lauf B1 speichert diese Bereinigung (und das Link-Objekt) dauerhaft in die App.
2. **Bericht B:** Kopie 1 im Hub erneut duplizieren. Das ist **Kopie 3**. Kopie 3 öffnen, **Checkbox NICHT anhaken** und die Probes ausführen. Datei als **Bericht B** ablegen.
   - `existedBefore` in P3 zeigt, ob das gespeicherte Link-Objekt beim Duplizieren mitkopiert wird. Zusammen mit Bericht A2 trennt das „ohne `DoSave` nicht erhalten“ von „wird nicht mitkopiert“.

## 5. Bericht C: „Publish and replace“

1. Eine Wegwerf-App (z. B. eine leere neue App) in einen Test-Stream veröffentlichen.
2. In der QMC **Kopie 1** auswählen → „Publish“ → „Publish and replace“ → die eben veröffentlichte Wegwerf-App als Ziel wählen.
3. Die veröffentlichte App im Stream öffnen, **Checkbox „Include DoSave probe (P7)“ ANHAKEN** und die Probes ausführen. Datei als **Bericht C** ablegen.
   - `existedBefore` in P3 beantwortet Frage 9 (Link-Objekt nach „Publish and replace“).
   - P8 beantwortet Frage 8 (Skript einer veröffentlichten App lesbar).
   - Dass in einer veröffentlichten App einzelne Anlege- oder Speicheraufrufe (P2, P3, P5, P7) mit Fehler enden, ist möglich und selbst ein Ergebnis – einfach den Bericht abgeben.

## 6. Sichtbarkeit des Link-Objekts prüfen

In einer der Kopien (oder der veröffentlichten App) in der Oberfläche nachsehen, ob `spike-qommit-link` irgendwo auftaucht: Sheet-Liste, Master Items (Dimensionen, Kennzahlen, Visualisierungen), Bookmarks, Stories. Ergebnis kurz notieren (z. B. „nirgends sichtbar“ oder „erscheint unter …“, gern mit Screenshot).

## 7. Aufräumen und übergeben

1. Kopie 1, Kopie 2, Kopie 3 und die Wegwerf-App (im Stream, ggf. über die QMC) löschen.
2. Im Hub unter „Meine Arbeit“ nach Apps suchen, deren Name mit `spike-probe-` beginnt, und sie löschen, falls noch welche da sind (siehe „Wenn etwas nicht klappt“).
3. In `chrome://extensions` die Extension „Qommit Spike“ entfernen.
4. Die Berichte **A, A2, B1, B und C** sowie die Notiz aus Schritt 6 übergeben.

## Wenn etwas nicht klappt

- **Kein Button:** Er erscheint nur auf App-Seiten (URL enthält `/sense/app/<App-ID>`). Seite neu laden; prüfen, ob die Extension in `chrome://extensions` aktiv ist und nach einem Neubau dort auf „Neu laden“ geklickt wurde.
- **Kein Download:** Der Bericht steht zusätzlich in der DevTools-Konsole (F12 → Console) unter `[qommit-spike] report`. Den JSON-Text kopieren und als Datei speichern.
- **P7 „skipped: DoSave probe not selected“:** Die Checkbox war nicht angehakt. In A, A2 und B ist das richtig; in B1 und C den Lauf mit Haken wiederholen.
- **P9 „skipped: new-app probe not selected“:** Die Checkbox „Include new-app probe (P9)“ war nicht angehakt. Den Bericht trotzdem abgeben; P9 muss nur in mindestens einem Bericht gelaufen sein.
- **P9 meldet `"deleted": false`:** Die neue App konnte nicht gelöscht werden. Name und ID stehen in P9 unter `newApp` (auch in `detail`). Die App im Hub unter „Meine Arbeit“ (oder in der QMC unter „Apps“) suchen und von Hand löschen. Gelöscht wird ausschließlich diese eine App mit dem Namen `spike-probe-…`, nie eine andere.
- **Viele Probes „skipped“:** Dann ist P1 (WebSocket) fehlgeschlagen; der Grund steht in `detail` von P1 sowie unter `withoutToken` und `withToken`. Den Bericht trotzdem abgeben – das ist die Antwort auf Frage 1 und 11.
