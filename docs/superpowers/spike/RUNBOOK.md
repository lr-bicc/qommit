# Runbook: Spike gegen den Qlik-Testserver

Wegwerf-Extension „Qlik Git Spike“. Sie blendet auf App-Seiten von `https://lr-analytics-test.lrworld.com` unten links den Button **„Run spike probes“** ein. Ein Klick führt die Probes P11, P1, P4, P6, P10, P8, P2, P5, P3, P7 nacheinander aus (Fortschritt steht im Button) und lädt danach `spike-report-<Zeitstempel>.json` herunter. Ein kompletter Lauf dauert je nach App-Größe Sekunden bis wenige Minuten; jede Probe hat ein eigenes Zeitlimit, der Bericht kommt in jedem Fall.

**Wichtig – die Probes verändern die geöffnete App.** Deshalb nur auf Kopien bzw. der Wegwerf-App ausführen, nie auf einer produktiv genutzten App:

- P2 legt `spike-dimension`, `spike-measure`, `spike-masterobject` und `spike-sheet` an und löscht sie wieder.
- P5 lädt `spike-probe.txt` in die App-Inhaltsbibliothek hoch und löscht sie wieder.
- P3 legt das Objekt `spike-git-link` an und lässt es **absichtlich** in der App (die Schritte 3 und 4 prüfen, ob es erhalten bleibt).
- P7 speichert die App (`DoSave`).

## 1. Extension bauen und laden

1. Im Repo-Wurzelverzeichnis: `npm install` (falls noch nicht geschehen), dann `node spike/build.mjs`. Danach muss `spike/dist/content.js` existieren.
2. In Chrome `chrome://extensions` öffnen → oben rechts **Entwicklermodus** einschalten → **„Entpackte Erweiterung laden“** → den Ordner `spike/` wählen (den Ordner, in dem `manifest.json` liegt).
3. Die Extension braucht keine Berechtigungen. Sie läuft nur auf `https://lr-analytics-test.lrworld.com/*`.

## 2. Bericht A: Kopie einer versionierten App

1. Im Hub eine veröffentlichte, mit gitoqlok versionierte App duplizieren (z. B. „Supply Chain Performance“).
2. Die Kopie öffnen (App-Übersicht oder ein Sheet). Unten links erscheint „Run spike probes“. Falls nicht: Seite neu laden.
3. Auf „Run spike probes“ klicken und warten, bis der Button „Done: …“ zeigt.
4. Die heruntergeladene Datei als **Bericht A** ablegen (z. B. in `spike-report-A.json` umbenennen).

## 3. Bericht A2 und Bericht B: Bleibt das Link-Objekt erhalten?

1. **Bericht A2:** Die Seite der ersten Kopie neu laden (F5) und die Probes erneut ausführen. Datei als **Bericht A2** ablegen. Der Wert `existedBefore` in P3 zeigt, ob das Link-Objekt `spike-git-link` ohne eigenes Speichern erhalten blieb.
2. **Bericht B:** Die erste Kopie im Hub duplizieren, die zweite Kopie öffnen und die Probes ausführen. Datei als **Bericht B** ablegen. `existedBefore` in P3 zeigt, ob das Link-Objekt mitkopiert wurde.

## 4. Bericht C: „Publish and replace“

1. Eine Wegwerf-App (z. B. eine leere neue App) in einen Test-Stream veröffentlichen.
2. In der QMC die **erste Kopie** auswählen → „Publish“ → „Publish and replace“ → die eben veröffentlichte Wegwerf-App als Ziel wählen.
3. Die veröffentlichte App im Stream öffnen und die Probes ausführen. Datei als **Bericht C** ablegen.
   - `existedBefore` in P3 beantwortet Frage 9 (Link-Objekt nach „Publish and replace“).
   - P8 beantwortet Frage 8 (Skript einer veröffentlichten App lesbar).
   - Dass in einer veröffentlichten App einzelne Anlege- oder Speicheraufrufe (P2, P3, P5, P7) mit Fehler enden, ist möglich und selbst ein Ergebnis – einfach den Bericht abgeben.

## 5. Sichtbarkeit des Link-Objekts prüfen

In einer der Kopien (oder der veröffentlichten App) in der Oberfläche nachsehen, ob `spike-git-link` irgendwo auftaucht: Sheet-Liste, Master Items (Dimensionen, Kennzahlen, Visualisierungen), Bookmarks, Stories. Ergebnis kurz notieren (z. B. „nirgends sichtbar“ oder „erscheint unter …“, gern mit Screenshot).

## 6. Aufräumen und übergeben

1. Beide Kopien und die Wegwerf-App (im Stream, ggf. über die QMC) löschen.
2. In `chrome://extensions` die Extension „Qlik Git Spike“ entfernen.
3. Die Berichte **A, A2, B und C** sowie die Notiz aus Schritt 5 übergeben.

## Wenn etwas nicht klappt

- **Kein Button:** Er erscheint nur auf App-Seiten (URL enthält `/sense/app/<App-ID>`). Seite neu laden; prüfen, ob die Extension in `chrome://extensions` aktiv ist und nach einem Neubau dort auf „Neu laden“ geklickt wurde.
- **Kein Download:** Der Bericht steht zusätzlich in der DevTools-Konsole (F12 → Console) unter `[qlik-git-spike] report`. Den JSON-Text kopieren und als Datei speichern.
- **Viele Probes „skipped“:** Dann ist P1 (WebSocket) fehlgeschlagen; der Grund steht in `detail` von P1. Den Bericht trotzdem abgeben – das ist die Antwort auf Frage 1.
