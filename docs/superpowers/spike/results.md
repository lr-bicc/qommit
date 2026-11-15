# Spike-Ergebnisse

**Stand:** 2026-11-13 · **Server:** `lr-analytics-test.lrworld.com`, Virtual Proxy `/qs` · **Benutzer:** `LR\r.vasilev`

Grundlage sind fünf Berichte der Spike-Extension (`docs/superpowers/spike/RUNBOOK.md`) vom 2026-11-13 und die Notiz zur Sichtbarkeit des Link-Objekts („nirgends sichtbar“). Alle fünf Läufe liefen vollständig durch, keine Probe lief in ein Timeout.

| Bericht | App | Was geprüft wurde |
|---|---|---|
| A | Kopie 1 der veröffentlichten „Supply Chain Performance“ (`0a15fa01…`), ohne `DoSave` | Grundlauf |
| A2 | Duplikat von Kopie 1 (`6b4121db…`), ohne `DoSave` | Bleibt das Link-Objekt ohne `DoSave` erhalten? |
| B1 | Kopie 1 erneut, mit `DoSave` | Bleiben die Daten beim Speichern erhalten? |
| B | weiteres Duplikat von Kopie 1 (`deae9888…`) | Wird das Link-Objekt nach dem Speichern mitkopiert? |
| C | veröffentlichte App „Test (Qommit)“ (`4b733a81…`) nach „Publish and replace“ mit Kopie 1, mit `DoSave` | Verhalten in einer veröffentlichten App |

## Antworten auf die Fragen aus Spec Abschnitt 9

| # | Frage | Antwort | Beleg |
|---|---|---|---|
| 1 | WebSocket aus dem Content Script | **Ja.** | P1 in allen fünf Läufen: Sitzung `SESSION_ATTACHED`, `OpenDoc` erfolgreich. |
| 2 | Objekte mit vorgegebener `qId` anlegen | **Ja**, in derselben und in einer neuen App, für Dimension, Measure, Master-Visualisierung, Sheet, Story und Variable. | P2 (A, A2, B1, B) und P9 (alle Läufe): `idKept: true` für alle sechs Typen. |
| 3 | Link-Objekt: mitkopiert, ohne `DoSave` erhalten, unsichtbar | **Ja, alle drei.** | A2: `existedBefore: true` in einem Duplikat, das vor jedem `DoSave` entstand. B: ebenso nach dem Speichern. Notiz: nirgends sichtbar. |
| 4 | Stabiles Lesen; Übereinstimmung mit dem Referenz-Repo | **Ja**, mit zwei erklärten Abweichungen (siehe unten). | P4: 208 Objekte zweimal gelesen, 0 Abweichungen, in allen Läufen. Vergleich der 422 Datei-Prüfsummen mit `origin/main` von `lr-bicc/supply-chain-performance`. |
| 5 | Statische Dateien lesen, hochladen, löschen | **Ja**, auch in der veröffentlichten App. | P5: 21 Dateien gelistet, Download 200, Upload 201, Löschen 204. |
| 6 | Story mit Snapshots in eine neue App ohne Daten | **Offen.** Die Test-App hat keine Story. | P6: `storyCount: 0`. Bestätigt ist nur, dass sich eine Story mit vorgegebener ID anlegen lässt (P9). |
| 7 | Daten bleiben bei `DoSave` erhalten | **Ja** nach Objektänderungen. Nach einer Skriptänderung ist es nicht geprüft. | P7 (B1, C): 8 Tabellen und 4.092.937 Zeilen vor und nach `DoSave`. Die gespeicherte Kopie brachte ihre Daten über „Publish and replace“ in die veröffentlichte App mit. |
| 8 | Ladeskript einer veröffentlichten App lesen | **Ja.** | P8 (C): `GetScript` liefert 44.508 Zeichen. |
| 9 | Link-Objekt wandert bei „Publish and replace“ mit | **Ja.** | P3 (C): `existedBefore: true` in der veröffentlichten App. |
| 10 | Ablageort von gitoqloks Metadaten | Generisches Objekt mit `qId` und `qType` **`_gitoqlikMetaData`**; die Daten liegen unter `_data.infoByServerType.github` (Schlüssel `lastCommitId` gefunden). Lesbar in Kopien und in der veröffentlichten App. | P10 in allen Läufen. Der Bericht enthält nur Pfade, keine Werte. |
| 11 | CSRF-Token | `GET /qs/qps/csrftoken` antwortet mit **204**, leerem Body und dem Token im Header **`qlik-csrf-token`** (22 Zeichen). Der Virtual Proxy nimmt den WebSocket **mit und ohne** Token an. | P11, P1 (`withoutToken.ok` und `withToken.ok`). |

## Vergleich mit dem Referenz-Repo (Frage 4 im Detail)

Die Spike-Extension hat die App mit dem Serializer des Projekts in Repo-Dateien umgesetzt. Von den 422 Dateien sind **409 bytegleich** mit `origin/main`:

| Gruppe | Dateien | bytegleich | Abweichung |
|---|---|---|---|
| Skript-Tabs und `tab_order.txt` | 13 | 13 | – |
| `objects/appprops.json` | 1 | 1 | – |
| Measures | 197 | 197 | – |
| Master-Visualisierungen | 2 | 2 | – |
| Variablen | 175 | 175 | – |
| Dimensionen | 23 | 21 | 2: im Repo steht zusätzlich `_ColorMapModel` |
| Sheets | 11 | 0 | 11: nur die App-ID in `/appcontent/<App-ID>/…` |

Beide Abweichungen sind vollständig erklärt und nachgerechnet:

- **Sheets:** Ersetzt man in den 11 Repo-Dateien die App-ID durch die der gelesenen App, stimmen alle 11 Prüfsummen. Im Repo steht dort durchgehend `c479fcff…`, die ID der App des Branches `forecast-and-nordics`, nicht die der `main`-Zeile (`a600a3f7…`).
- **Dimensionen:** Entfernt man aus den beiden Repo-Dateien (`FpnjKw`, `kWjJPeh`) den Schlüssel `_ColorMapModel`, stimmen beide Prüfsummen.

Nur im Repo, wie in Spec 4.5 vorgesehen: 357 Dateien skripterzeugter Variablen, `README.md`, `loadScript.qvs`, `objects/fields.json`, `objects/themes.json`, `objects/glossarylinks.json`, `builds/<id>.qvf` (33 MB) und die 21 Dateien unter `appcontent/` (im Spike nicht verglichen).

## Weitere Befunde

1. **gitoqlok bettet die Wertefarben einer Master-Dimension in die Dimensionsdatei ein.** Die Farben liegen in der App als eigenes generisches Objekt `ColorMapModel_<qId der Dimension>` vom Typ `ColorMap` (zwei Stück in der Test-App). gitoqlok schreibt es als `_ColorMapModel: { qInfo, qMeta, colorMap }` ans Ende der Dimensionsdatei. Der Serializer des Projekts kennt das noch nicht; ohne Anpassung würde der erste „Save changes“ die Farben aus dem Repo entfernen, und ein Update würde sie nicht wiederherstellen.
2. **Kennzeichen der Variablen.** Von 565 Variablen tragen 357 das Kennzeichen `qIsScriptCreated` in `GetProperties`. Die Variablenliste (`qVariableListDef` mit `qShowReserved` und `qShowConfig`) kennzeichnet 390, also zusätzlich 33 reservierte. Erst mit beiden Quellen bleiben genau die 175 Variablen übrig, die auch gitoqlok versioniert.
3. **Fremde App-IDs sind im Repo der Normalfall.** Jede Sheet-Datei trägt die ID der App, die zuletzt committet hat. Die Regel aus Spec 4.3 (nur die eigene ID ersetzen) reicht deshalb nicht; es muss jede App-ID an dieser Stelle ersetzt werden.
4. **Veröffentlichte App.** Mit Entwicklerrechten lassen sich dort Sheets, Stories und Variablen anlegen, Dateien hochladen und `DoSave` aufrufen. Dimensionen, Measures und Master-Visualisierungen werden mit „Access denied“ abgelehnt. Die Meldung „cleanup FAILED“ in Bericht C ist deshalb ein Fehlalarm: Die drei Objekte wurden nie angelegt, es bleibt nichts zurück.
5. **Lesedauer.** Der Spike fragt Objekte nacheinander ab und braucht dafür gut 30 ms pro Objekt (P10: 22 Sekunden für 672 Objekte). Die App hat rund 800 versionierte Objekte; die Extension muss deshalb parallel lesen und den Fortschritt anzeigen.
6. **`builds/` im Repo.** Die QVF-Datei macht den ZIP-Abruf eines Repo-Stands rund 35 MB groß. Für das Update (Spec 6.6) ist der Abruf einzelner Dateien günstiger, bis die Datei aus dem Repo entfernt ist.
7. **Weitere Objekttypen in der App:** `LoadModel` (1) und `singlepublic` (1). gitoqlok versioniert sie nicht, die Extension auch nicht.

## Folgen

**Für die Spec (Revision 9):**

- 4.2/4.3: Dimensionsdateien enthalten `_ColorMapModel`; die Kennzeichen der Variablen kommen aus `GetProperties` und der Variablenliste; jede App-ID in `/appcontent/<App-ID>/` wird ersetzt.
- 4.5: Neue Abweichung: `qMeta` im eingebetteten `_ColorMapModel` wird nicht geschrieben (Zeitstempel der Engine).
- 5: `qId` des Link-Objekts festgelegt; Ablageort und Inhalt von gitoqloks Metadaten eingetragen; kein `DoSave` nach dem Schreiben des Link-Objekts.
- 3: CSRF-Token wird angehängt, wenn der Server eines liefert; Build mit esbuild statt Vite.
- 9: Spike abgeschlossen.

**Offen bleibt Frage 6** (Stories mit Snapshots). Sie wird in der Abnahme geprüft, sobald eine App mit Story vorliegt.

**Für Plan 3 (Update, Import):** Zielstand über Tree und einzelne Blobs laden statt über das ZIP; `DoSave` nach einer Skriptänderung auf Datenerhalt prüfen; Wertefarben beim Zurückschreiben als eigenes Objekt anlegen, ändern oder löschen.

## Aufräumen auf dem Testserver

In den drei Kopien und in „Test (Qommit)“ liegt noch das Objekt `spike-qommit-link`. Die Kopien und die Test-App können gelöscht werden. Alle fünf Läufe haben ihre App `spike-probe-…` selbst wieder gelöscht (`deleted: true`).
