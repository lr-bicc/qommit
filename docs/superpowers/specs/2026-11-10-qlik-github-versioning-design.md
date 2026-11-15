# Design: Qommit – Versionierungstool für Qlik Sense Apps (Chrome-Extension + GitHub)

- **Name des Tools:** Qommit (Paket- und Repo-Name `qommit`, Repo `lr-bicc/qommit`)
- **Datum:** 2026-11-13 (Revision 9)
- **Status:** Revision 8 freigegeben am 2026-11-11. Revision 9 enthält die Anpassungen nach dem Spike; sie sind in Abschnitt 11 aufgelistet.
- **Vorbild:** gitoqlok – bewusst abgespeckt auf GitHub als einziges Backend
- **Referenzen:** Repo `lr-bicc/supply-chain-performance` (von gitoqlok erzeugt) und vier Bildschirmaufnahmen der gitoqlok-Abläufe vom 2026-11-11 (Branch anlegen, Save changes, Update, Rundgang mit Connect-Dialog und Einstellungen) sowie ein gitoqlok-Log desselben Tages

## 1. Ziel und Rahmen

### Ziel
Entwickler im Qlik-Team versionieren ihre Qlik-Sense-Apps direkt aus dem Browser heraus in GitHub. Arbeitsweise, Oberfläche und Repo-Format folgen gitoqlok, damit das Team nicht umlernen muss und bestehende gitoqlok-Repos samt Historie weiter genutzt werden können.

### Rahmenbedingungen (entschieden)
| Thema | Entscheidung |
|---|---|
| Qlik-Plattform | Qlik Sense Enterprise on Windows (client-managed). Qlik Cloud ist nicht Teil von v1. |
| Versionierter Umfang | Ladeskript, Variablen, Master-Dimensionen (mit Wertefarben)/-Measures/-Visualisierungen, Sheets inkl. Visualisierungen, Stories, App-Eigenschaften, statische Dateien der App (Bilder), Bookmarks (nur lesend, siehe 4.4) |
| Repo-Organisation | Ein Repo pro App in der GitHub-Org `lr-bicc`, ein Branch pro App-Kopie (wie gitoqlok) |
| Repo-Format | gitoqlok-Format (Abschnitt 4); bestehende gitoqlok-Repos bleiben nutzbar |
| GitHub-Auth | Persönlicher Access Token (classic, Scope `repo`) pro Entwickler, eingetragen in der Optionsseite |
| Funktionen v1 | Repo anlegen/verbinden, Branch anlegen, Save changes (Commit), Update (Repo-Stand in die App übernehmen, auch ältere Stände), Historie, Diff, Tags, Import (neue App aus Repo) |
| Nicht in v1 | Pull Requests in der Extension anlegen oder mergen (nur Link nach GitHub), Publish App (Veröffentlichen bleibt bei Hub und QMC), Documentation Wizard, Qlik-Helper-Leiste, Apps-Manager, Qlik Cloud, QVF-Export, Reload-Tasks und Datenverbindungen, KI-Vorschlag für Commit-Nachrichten, Wiederherstellen von Bookmarks |
| Umstieg | Das Team steigt vollständig von gitoqlok um; ein Parallelbetrieb auf denselben Repos wird nicht unterstützt. |
| UI-Ansatz | Chrome Side Panel wie gitoqlok; Diffs als Overlay in der Qlik-Seite |
| UI-Sprache | Durchgehend Englisch (Panel, Dialoge, Optionsseite, Fehlermeldungen), mit den Bezeichnungen aus gitoqlok („Local Changes“, „Save changes“, „Update“, „Create Branch“ …) |
| Verteilung | Vorerst als entpackte Extension (Entwicklermodus) |

### Erfolgskriterien
1. **Kompatibilität:** Für die App eines bestehenden gitoqlok-Repos erzeugt die Extension die gepflegten Dateien (Abschnitt 4) inhaltsgleich zu gitoqlok, abgesehen von den dokumentierten Abweichungen (4.5).
2. **Ablauf Ende zu Ende:** Veröffentlichte App duplizieren → Branch anlegen → ändern → Save changes → Pull Request auf GitHub mergen → in der QMC per „Publish and replace“ veröffentlichen. Danach ergibt die Serialisierung der veröffentlichten App genau die Dateien des Default-Branches.
3. **Kein Rauschen:** Eine frisch duplizierte App zeigt direkt nach dem Anlegen des Branches keine lokalen Änderungen, sofern die Quell-App keine hatte. Ein Reload der Daten allein erzeugt keine lokalen Änderungen.
4. **Roundtrip:** App A serialisieren → per Import als neue App B anlegen → B serialisieren ergibt dieselben Dateien (Bookmarks ausgenommen). Getestet mit mindestens drei echten Apps (klein, mittel, groß).
5. **Nichts geht verloren:** Vor jedem Update, das lokale Änderungen überschreibt, liegt der bisherige App-Stand als Sicherungs-Branch auf GitHub.

## 2. Arbeitsweise

Die Arbeitsweise entspricht der heutigen mit gitoqlok:

- Die **veröffentlichte App** im Stream ist der ausgelieferte Stand.
- Der Branch **`main`** ist der gemergte Stand im Repo. Mit `main` ist nur die App verbunden, aus der das Repo angelegt wurde (6.2); danach entstehen Änderungen auf Branches, und `main` braucht keine eigene App.
- Jede Änderung entsteht in einer **Kopie** der veröffentlichten App auf einem eigenen Branch.

Ablauf:

1. Der Entwickler dupliziert die veröffentlichte App im Hub und öffnet die Kopie. Die Extension erkennt, dass die Kopie von einer versionierten App stammt, und bietet **Create Branch** an. Der Branch zweigt von `main` ab.
2. Steht die Kopie hinter `main` zurück, meldet das Panel „Repository has N new commits“; **Update** bringt sie auf den Stand.
3. Der Entwickler arbeitet in der Kopie und sichert mit **Save changes** auf den Branch.
4. Der Branch wird auf GitHub per Pull Request nach `main` gemergt. Git führt dabei die Dateien zusammen; weil Kopien die Objekt-IDs der Quell-App behalten, passen die Dateien zueinander.
5. Die Branch-App wird in der QMC per „Publish and replace“ über die veröffentlichte App gelegt. Die Extension ist daran in v1 nicht beteiligt.

## 3. Architektur

### Kontexte und Komponenten
Die Qlik Engine API (WebSocket) prüft den `Origin`-Header gegen die Host-Whitelist des Virtual Proxy und benötigt den Session-Cookie. Deshalb laufen alle Qlik-Zugriffe im Kontext der Qlik-Seite, alle GitHub-Zugriffe im Service Worker.

| Komponente | Läuft in | Verantwortung |
|---|---|---|
| Side Panel | Extension-Seite neben der Qlik-Seite | Gesamte Bedienung (Abschnitt 6.1). Löst Befehle aus und zeigt Status; keine Geschäftslogik. |
| Optionsseite | Extension-Seite | GitHub-Token + „Check connection“, Org (Default `lr-bicc`), optionales Repo-Präfix (Default leer), Liste der Qlik-Server-URLs |
| Service Worker | Hintergrund | Einziger Halter des Tokens; GitHub-Client; öffnet das Side Panel beim Klick auf das Extension-Icon. Hält keinen Zustand im Speicher. |
| Content Script | Qlik-Seite, isolierte Welt | Engine-Zugriff via enigma.js; liest und schreibt statische Dateien; führt Update-Pläne aus; zeigt Diff-Overlay in Shadow DOM |

**Side Panel:** Benötigt Chrome 116 oder neuer. Tabs der eingetragenen Qlik-Server erhalten ihr eigenes Panel; es zeigt immer den Stand des Tabs, zu dem es gehört. Auf allen anderen Tabs zeigt das Panel nur den Hinweis, dass der Server in den Optionen eingetragen sein muss, mit einem Link dorthin.

**Engine-Zugriff aus dem Content Script:** Netzwerkzugriffe eines Content Scripts laufen unter dem Origin der Seite, also mit deren Cookie und einem Origin, den der Virtual Proxy akzeptiert. Der Spike (Abschnitt 9) bestätigt das für WebSockets; schlägt er fehl, wandert nur der Engine-Zugriff in ein Main-World-Skript.

**CSRF-Token:** Vor dem Verbindungsaufbau fragt das Content Script `/<präfix>/qps/csrftoken` ab und hängt ein geliefertes Token als `qlik-csrf-token` an die WebSocket-URL und an QRS-Aufrufe an. Auf dem Testserver antwortet der Aufruf mit `204` und dem Token im Antwort-Header `qlik-csrf-token`; der Virtual Proxy nimmt die Verbindung dort mit und ohne Token an (Spike). Liefert ein Server kein Token, verbindet sich die Extension ohne.

**URLs:** WebSocket- und Datei-URLs werden aus der Tab-URL abgeleitet, inklusive Virtual-Proxy-Präfix (`https://<host>/<präfix>/sense/app/<id>` → `wss://<host>/<präfix>/app/<id>`; auf dem Testserver ist das Präfix `qs`).

**Lebensdauer:** Chrome beendet einen untätigen Service Worker nach rund 30 Sekunden. Lange Abläufe (Lesen, Update) führt deshalb das Content Script aus und ruft den Service Worker nur für einzelne GitHub-Aufrufe. Der Stand eines laufenden Ablaufs liegt in `chrome.storage.session`. Wird der Tab während eines Updates geschlossen oder neu geladen, gilt das als Fehler mitten im Update (Abschnitt 7).

### Reine Logikmodule (ohne Browser-Abhängigkeit, einzeln testbar)
| Modul | Eingabe → Ausgabe |
|---|---|
| `serializer` | Rohdaten aus der Engine → `FileMap` (Pfad → Inhalt) im gitoqlok-Format |
| `deserializer` | `FileMap` → typisierte App-Struktur für Update und Import |
| `script-tabs` | Ladeskript ↔ Tab-Dateien + `tab_order.txt` |
| `diff` | zwei `FileMap`s → Liste von Objektänderungen (added/deleted/changed), für Skripte zusätzlich Zeilen-Diff |
| `update-planner` | Zielstand + aktueller App-Stand + gewählte Teile → geordnete Aktionsliste |
| `repo-layout` | App-Name → Repo-Name; Pfade; README erzeugen; Branch-Tabelle lesen und ändern |
| `git-hash` | Dateiinhalt → Git-Blob-SHA (Vergleich mit GitHub ohne Download) |

### Tech-Stack
TypeScript, Manifest V3, esbuild, Preact (Side Panel und Optionsseite), enigma.js, GitHub REST API (Git Data API für atomare Commits) und GraphQL via `fetch`, Diff-Bibliothek `diff` (jsdiff), Vitest.

### Berechtigungen (Manifest)
- `storage`, `scripting`, `sidePanel`
- `host_permissions`: `https://api.github.com/*`, `https://codeload.github.com/*` (Ziel der Weiterleitung beim Abruf eines Repo-Stands als ZIP)
- `optional_host_permissions`: `https://*/*` – angefragt wird zur Laufzeit nur für die in den Optionen eingetragenen Qlik-Server.

## 4. Repo-Format

### 4.1 Benennung
Repo-Name = App-Name als Slug (Kleinbuchstaben, Umlaute transliteriert, alles außer `a-z0-9` → `-`, mehrfache `-` zusammengefasst, max. 80 Zeichen), optional mit Präfix aus den Optionen. Beispiel: „Supply Chain Performance“ → `supply-chain-performance`. Bei Kollision werden `-<erste 8 Zeichen der App-ID>` angehängt. Repos werden **privat**, mit Default-Branch `main` und mit `auto_init: true` angelegt, weil die Git Data API auf einem leeren Repo mit `409` antwortet.

### 4.2 Dateistruktur (wie gitoqlok)
```
README.md                         Titel, Ersteller, Sheet-Tabelle, Branch-Tabelle
data_load_script/<Tab>.qvs        eine Datei pro Skript-Tab
data_load_script/tab_order.txt    Reihenfolge der Tabs
objects/appprops.json             App-Eigenschaften
objects/variables/<qId>.json
objects/dimensions/<qId>.json     inkl. Wertefarben (`_ColorMapModel`, siehe 4.3)
objects/measures/<qId>.json
objects/masterobjects/<qId>.json  Full Property Tree
objects/sheets/<qId>.json         Full Property Tree (Sheet + alle Kindobjekte)
objects/stories/<qId>.json        Full Property Tree
objects/bookmarks/<qId>.json
appcontent/<Dateiname>            statische Dateien der App (Bilder)
```

### 4.3 Serialisierungsregeln
- **JSON:** 2 Leerzeichen Einrückung, Schlüssel in der Reihenfolge der Engine, Zeilenenden `\n`, kein abschließender Zeilenumbruch. Variablen, Dimensionen und Measures sind die Eigenschaften des Objekts (`GetProperties`); Sheets, Master-Visualisierungen und Stories sind `{ "qProperty": …, "qChildren": [...] }` (`GetFullPropertyTree`); `appprops.json` ist ein Array solcher Bäume. Kindobjekte eines Sheets stehen in der Reihenfolge der Engine; erweist sie sich im Spike als nicht stabil, werden sie nach `qId` sortiert.
- **Wertefarben von Master-Dimensionen:** Die Engine hält sie als eigenes generisches Objekt `ColorMapModel_<qId der Dimension>` vom Typ `ColorMap`. Wie bei gitoqlok steht es als letzter Schlüssel `_ColorMapModel` in der Datei der Dimension, mit den Feldern `qInfo` und `colorMap`. Beim Übernehmen in eine App wird daraus wieder das eigene Objekt angelegt, geändert oder gelöscht.
- **Variablen:** Ob eine Variable im Skript erzeugt oder reserviert ist, ergibt sich aus `GetProperties` und aus der Variablenliste (`qShowReserved`, `qShowConfig`) zusammen; `GetProperties` allein kennzeichnet reservierte Variablen nicht (Spike).
- **Objekt-IDs** (`qInfo.qId`) sind Dateiname und bleiben erhalten. Sie werden bei Update und Import wiederverwendet; nur so bleiben Verweise gültig, etwa von einer Visualisierung auf ein Master Item, und nur so lassen sich Branches mergen.
- **Ladeskript:** Das Skript liegt nur in den Tab-Dateien. Sie entstehen durch Teilen an den Zeilen `///$tab <Name>`, Zeilenenden bleiben unverändert; Dateiname ist der Tab-Name, in dem für Dateinamen ungültige Zeichen durch Leerzeichen ersetzt sind. `tab_order.txt` enthält die Namen in Reihenfolge, getrennt durch `%tab_file_order_divider%`. Beim Update wird das Skript aus `tab_order.txt` und den Tab-Dateien zusammengesetzt.
- **App-ID in Datei-URLs:** Verweise der Form `/appcontent/<App-ID>/<Datei>` enthalten die ID einer App. Beim Schreiben ins Repo wird **jede** App-ID an dieser Stelle durch die ersetzt, die in der Branch-Tabelle beim Default-Branch steht (sie dient nur als feste Marke, die App muss nicht mehr existieren; fehlt die Zeile, gilt die erste Zeile der Tabelle, ohne Tabelle die ID der App selbst). Beim Übernehmen in eine App wird jede App-ID durch deren eigene ersetzt. Ohne diese Regel ändert jeder Branch-Wechsel alle Sheets mit Bildern. Folge: Ein Verweis auf die Dateien einer anderen App lässt sich nicht versionieren; er zeigt nach dem Übernehmen auf die eigene App.
- **README.md** wird beim Anlegen des Repos erzeugt (Titel, Ersteller, Datum, Tabelle der Sheets, Branch-Tabelle). Danach ändert die Extension nur noch die Branch-Tabelle.

### 4.4 Was nicht oder nur eingeschränkt versioniert wird
- Daten und QVF-Dateien (`builds/` wird nicht gepflegt)
- Datenverbindungen (Serverebene, enthalten Zugangsdaten)
- Themes und Visualisierungs-Extensions; auf dem Zielserver müssen sie vorhanden sein
- Private und Community-Objekte: In unveröffentlichten Apps werden alle Objekte versioniert, in veröffentlichten nur Sheets, Stories und Bookmarks mit `qMeta.approved = true` (Master Items sind dort immer freigegeben).
- **Stories:** Sie werden versioniert und zurückgeschrieben. Ob Snapshots den Weg in eine App ohne Daten überstehen, ist ungeprüft, weil die Test-App keine Story hat (Spike-Frage 6); das wird in der Abnahme geprüft, sobald eine App mit Story vorliegt.
- **Bookmarks** werden gespeichert und im Diff angezeigt, aber nicht in eine App zurückgeschrieben. Die Engine legt ein Bookmark nur an, indem die Auswahl in einer App mit Daten nachgestellt wird; das würde die laufende Auswahl des Nutzers verändern und geht in einer App ohne Daten gar nicht.

### 4.5 Bewusste Abweichungen von gitoqlok
| Abweichung | Grund |
|---|---|
| Im Ladeskript erzeugte Variablen (`qIsScriptCreated`) werden nicht versioniert. | Sie stehen bereits im Skript und ändern sich bei jedem Reload (`vU.Today`, `Qvc.Global.v.ScriptStart` …). Im Referenz-Repo betreffen alle 190 Variablenänderungen der letzten 60 Commits solche Variablen. |
| App-IDs in Datei-URLs werden normalisiert (4.3). | Im Referenz-Repo steht dort die ID der zuletzt committenden Branch-App; eine frische Kopie zeigt deshalb sofort 11 geänderte Sheets. |
| Im eingebetteten `_ColorMapModel` wird `qMeta` nicht geschrieben. | `qMeta` enthält nur Zeitstempel und Status der Engine und lässt sich nicht zurückschreiben. |
| `objects/fields.json`, `objects/themes.json`, `objects/glossarylinks.json` werden nicht gepflegt. | Abgeleitete Daten, die sich nicht in eine App zurückschreiben lassen. |
| `loadScript.qvs` (das zusammengefügte Gesamtskript) wird nicht geschrieben. | Jede Skriptänderung stünde sonst doppelt im Repo, und jeder Merge-Konflikt im Skript müsste zweimal gleich gelöst werden. gitoqlok bietet dasselbe als Einstellung an („Do not commit full loadScript.qvs file“). |
| Commit-Nachrichten erhalten keinen Zusatz wie `[%_OBJECTS_%%_SCRIPT_%]`. | Der Zusatz ist für die Extension nicht nötig. |

**Bestehende gitoqlok-Repos:** Der erste „Save changes“ mit der Extension entfernt einmalig die Dateien skripterzeugter Variablen, schreibt die normalisierten Datei-URLs und entfernt `qMeta` aus den Wertefarben. Für `supply-chain-performance` sind das 357 Variablen-Dateien, 11 Sheets und 2 Dimensionen (Spike). Liegen im Repo nicht mehr gepflegte Dateien (`loadScript.qvs`, `fields.json`, `themes.json`, `glossarylinks.json`, `builds/`), zeigt der Commit-Dialog die Option „Remove files no longer maintained“ (vorausgewählt); die Dateien bleiben in der Git-Historie erhalten.

## 5. Verknüpfung App ↔ Repo ↔ Branch

### In der App: Link-Objekt
Die Extension legt in jeder verknüpften App ein verstecktes generisches Objekt mit `qId` und `qType` `qommit-link` an. Seine Eigenschaft `link` enthält:
```json
{ "repo": "lr-bicc/supply-chain-performance", "branch": "forecast-and-nordics", "appId": "<ID der App, die zuletzt gespeichert hat>", "syncedSha": "<Commit, auf dem die App steht>" }
```
- Das Objekt wird nicht versioniert.
- Es bleibt ohne `DoSave` erhalten und ist in der Qlik-Oberfläche nicht sichtbar (Spike). Die Extension ruft nach dem Schreiben des Link-Objekts kein `DoSave` auf.
- Wird eine App dupliziert oder per „Publish and replace“ über eine andere App gelegt, wandert das Objekt mit. In der Kopie stimmt `appId` nicht mit der eigenen ID überein; daran erkennt die Extension „duplicated from an app tracked in <repo>“.
- `syncedSha` ist der Commit, auf dem die App steht: der letzte eigene Commit oder der Commit, auf den zuletzt aktualisiert wurde. Er trennt lokale Änderungen (App gegen `syncedSha`) von neuen Commits (`syncedSha` gegen Branch-HEAD). Nach einem Update auf einen älteren Commit meldet das Panel deshalb wie gitoqlok „Repository has N new commits“.
- gitoqlok arbeitet nach demselben Prinzip: Es legt in der App ein generisches Objekt mit `qId` und `qType` `_gitoqlikMetaData` ab; die Angaben (Repo, letzter Commit) liegen darin unter `_data.infoByServerType.github` (Spike). Die Extension liest daraus das Repo (`full_name`) und den letzten Commit (`lastCommitId`). Den Branch entnimmt sie der Branch-Tabelle des Repos; steht die App dort nicht, gilt sie als Kopie einer versionierten App.
- Lässt sich das Objekt nicht anlegen (veröffentlichte App, fehlende Rechte), liegen dieselben Angaben in `chrome.storage.local`; die Erkennung von Kopien entfällt dann.

### Im Repo: Branch-Tabelle in README.md
Wie bei gitoqlok enthält `README.md` die Tabelle `Branch Name | Qlik application` mit der URL der App je Branch. Die Extension ergänzt beim Anlegen eines Branches eine Zeile (Commit „Update branches table“ auf dem Default-Branch; ist dieser geschützt, auf dem neuen Branch). Pro Branch-Name gibt es genau eine Zeile; eine vorhandene Zeile gleichen Namens wird ersetzt.

### Auflösung beim Öffnen einer App
1. Link-Objekt mit passender `appId` → verknüpft.
2. Link-Objekt mit fremder `appId` in einer unveröffentlichten App → Kopie einer versionierten App (Ablauf 6.3).
3. Link-Objekt in einer veröffentlichten App → Nur-Lese-Ansicht: Repo, Branch und Commit, aus dem veröffentlicht wurde, sowie Abweichungen der App von diesem Commit. Änderungen sind hier nicht möglich; das Panel verweist auf das Duplizieren.
4. Kein Link-Objekt → lokaler Cache; sonst das Repo aus `_gitoqlikMetaData` der App; sonst eine GraphQL-Abfrage über die Repos der Org, die `README.md` des Default-Branches liest und die App-ID in der Branch-Tabelle sucht. Steht die App in der Branch-Tabelle des gefundenen Repos → Link-Objekt wird angelegt; `syncedSha` ist der letzte Commit aus den gitoqlok-Angaben, sofern er in der Historie des Branches liegt, sonst der Branch-HEAD. Nennen die gitoqlok-Angaben ein Repo, in dessen Tabelle die App nicht steht → Kopie einer versionierten App (Ablauf 6.3, ohne bekannten Quell-Branch). So werden Apps erkannt, die bisher mit gitoqlok versioniert wurden.
5. Kein Treffer → „No linked repository“ (Ablauf 6.2).

Verweist ein Link-Objekt auf einen Branch, den es auf GitHub nicht mehr gibt (nach dem Merge gelöscht), meldet das Panel das und bietet **Create Branch** und **Connect to existing repository** an.

## 6. Abläufe

### 6.1 Aufbau des Side Panels
- **Kopf:** App-Name; darunter Repo (`lr-bicc/<repo>`, Link nach GitHub), Branch-Badge, Hinweis „Repository has N new commits“, Symbole für „Unlink“ und „Refresh“.
- **Reiter:** Local Changes · History · Tags · Import
- **Local Changes:** Commit-Auswahl + **Update** (mit Zähler neuer Commits und Aufklappmenü für die Teile), **Save changes**, darunter die Gruppen *Added objects*, *Deleted objects*, *Changed objects*, jeweils unterteilt nach Sheets, Master Items, Variables, Script, Attached files, mit Objekttitel und Link „details“.
- **Commit-Auswahl:** aufklappbare, durchsuchbare Liste der Commits des Branches, neuester zuerst, je Eintrag Nachricht, Datum und Uhrzeit sowie Tag-Badges. Vorausgewählt ist der Branch-HEAD.
- **Fußzeile:** Status („Ready“, „Loading application data…“, Fortschritt).
- Repo-Daten werden pro Branch zwischengespeichert; „Refresh“ lädt sie neu. Die lokalen Änderungen werden beim Öffnen des Panels, bei „Refresh“ und nach jedem Commit oder Update neu ermittelt; eine laufende Überwachung der App im Hintergrund wie bei gitoqlok gibt es in v1 nicht.

### 6.2 App ohne Repo
Das Panel zeigt „No linked repository“ mit zwei Aktionen:
- **Create repository:** legt das Repo an (4.1), erzeugt `README.md`, committet den App-Stand als ersten Commit auf `main` und legt das Link-Objekt an.
- **Connect to existing repository:** Dialog wie bei gitoqlok mit filterbarer Repo-Liste der Org und der Wahl „As a new branch“ (Name vorbelegt mit dem Qlik-Benutzernamen, abgezweigt vom Default-Branch) oder „To existing branch“ (Auswahlliste). Die App wird dem Branch zugeordnet (Link-Objekt, Zeile in der Branch-Tabelle). `syncedSha` wird auf den Branch-HEAD gesetzt; Unterschiede erscheinen als lokale Änderungen.

### 6.3 Kopie einer versionierten App: Create Branch
Das Panel meldet „We found a repository for the master Qlik application, from which current application was duplicated“ und bietet **Create Branch**, **Unlink Repository** und **Connect to existing repository** an.

Create Branch:
- Feld „Branch Name“, vorbelegt mit dem Qlik-Benutzernamen (z. B. `r.vasilev`); der Name wird gegen die Git-Regeln geprüft.
- Option „Branch off from the branch that is used in the app you are duplicating from“ mit Anzeige dieses Branches. Ohne Option wird vom Default-Branch abgezweigt. Existiert der Branch der Quell-App nicht mehr, wird die Option nicht angeboten.
- Ablauf: Zeile in der Branch-Tabelle committen → Branch auf diesen Commit anlegen → Link-Objekt der Kopie auf den neuen Branch und die eigene App-ID setzen.
- **`syncedSha` der Kopie:** Die Kopie steht auf dem Stand ihrer Quell-App, nicht zwingend auf dem des neuen Branches. Liegt der `syncedSha` aus dem mitkopierten Link-Objekt in der Historie des neuen Branches, bleibt er erhalten; das Panel zeigt dann wie gitoqlok „Repository has N new commits“, und ein Update holt sie in die Kopie. Nur so dreht ein späterer Commit aus der Kopie keine Änderungen zurück, die inzwischen gemergt wurden. Liegt er nicht in der Historie oder fehlt er, wird `syncedSha` auf den Branch-HEAD gesetzt, und Unterschiede erscheinen als lokale Änderungen.
- Existiert der Branch-Name bereits → Fehlermeldung, nichts wird geändert.

### 6.4 Local Changes
Das Content Script liest die App und serialisiert sie. Vom Commit `syncedSha` wird nur der Tree geladen (Pfad → Blob-SHA); `git-hash` berechnet die Blob-SHAs der lokalen Dateien, der Vergleich ergibt added/deleted/changed ohne Download. Inhalte werden erst für „details“ geladen. Der HEAD des Branches wird abgefragt; ist er neuer als `syncedSha`, zeigt der Kopf die Zahl der Commits dazwischen.

### 6.5 Save changes (Commit)
1. „Save changes“ schaltet den Reiter in den Commit-Modus, wie bei gitoqlok:
   - „Choose what to save“ mit den Teilen Load script, App Objects, Bookmarks, Attached files. Vorausgewählt sind alle Teile mit Änderungen.
   - Jede Gruppe und jedes einzelne Objekt in den Listen erhält ein Häkchen; so lässt sich genau wählen, was in den Commit kommt.
   - Pflichtfeld für die Commit-Nachricht, Schaltflächen **Save** und **Back**. Nach Erfolg zeigt die Schaltfläche „Success“, und die Liste wird neu geladen.
2. **Steht die App nicht auf dem Branch-HEAD** (`syncedSha` ≠ HEAD), fragt die Extension vor dem Commit nach: „Update first“ (Standard) oder „Commit anyway“. Ein Commit ist ein Schnappschuss der App; auf einen neueren Stand gesetzt, dreht er dessen Änderungen zurück. „Commit anyway“ listet deshalb die Commits, die überschrieben würden, und ist der Weg, einen älteren Stand bewusst wieder zum aktuellen zu machen.
3. Die App wird frisch gelesen. Der Service Worker lädt die gewählten geänderten Dateien als Blobs hoch (max. 5 parallel, Binärdateien base64), erzeugt den Tree auf Basis des HEAD-Trees (gelöschte Dateien mit `sha: null`), erzeugt den Commit und setzt den Branch per Fast-Forward.
4. Schlägt das Setzen des Branches fehl, weil inzwischen jemand committet hat → die Nachfrage aus Schritt 2 erscheint, nichts geht verloren.
5. Danach `syncedSha` = neuer Commit. Nicht gewählte Änderungen bleiben als lokale Änderungen stehen. Ohne Auswahl gibt es keinen Commit.

Autor ist der GitHub-Account des Token-Inhabers.

### 6.6 Update (Repo-Stand in die App übernehmen)
Ziel ist der Branch-HEAD oder ein in der Commit-Auswahl gewählter älterer Commit oder Tag. Über das Aufklappmenü lassen sich die Teile wählen: Load script, App Objects, Attached files (Default: alle).

1. Der Zielstand wird als ZIP in einem Aufruf geladen (`zipball/<commit>`) und vollständig geprüft, bevor die App angefasst wird: jede JSON-Datei muss sich lesen lassen, keine Datei darf Konfliktmarken (`<<<<<<<`) enthalten, und `tab_order.txt` muss zu den Tab-Dateien passen. Bei Fehlern bricht das Update mit der Liste der betroffenen Dateien ab. Danach erzeugt `update-planner` die Aktionsliste. Anlegen und Ändern in der Reihenfolge App-Eigenschaften → Variablen → Master-Dimensionen/-Measures → Master-Visualisierungen → Sheets → Stories → statische Dateien → Skript; Löschen in umgekehrter Reihenfolge. Objekte werden mit ihrer ursprünglichen ID angelegt.
2. Bestätigungsdialog „Update Application from the repository?“ mit dem gewählten Commit (Link nach GitHub), der Vorschau „X anlegen, Y ändern, Z löschen“ mit aufklappbarer Liste und den Schaltflächen **Update** und **Cancel**.
3. Hat die App lokale Änderungen, werden sie zuerst gesichert: Commit des aktuellen App-Stands mit Parent `syncedSha` auf einen neuen Branch `backup/<branch>-<JJJJMMTT-hhmm>`. Der Sicherungs-Branch lässt sich auf GitHub per Pull Request wieder einbringen oder per Update zurückholen.
4. Aktionen ausführen, danach `DoSave`. Fortschritt in der Fußzeile; die Update-Schaltfläche zeigt am Ende „Success“. Geschrieben werden nur Objekte, die sich vom Zielstand unterscheiden.
5. `syncedSha` = übernommener Commit, sofern er auf dem Branch liegt. Wurde nur ein Teil übernommen, erscheinen die übrigen Unterschiede als lokale Änderungen. Liegt das Ziel nicht auf dem Branch (Tag oder Sicherungs-Branch außerhalb), bleibt `syncedSha` unverändert, und der übernommene Stand erscheint insgesamt als lokale Änderung. Es gibt keinen automatischen Commit.
6. Veröffentlichte Apps und Apps ohne Schreibrecht: Update ist gesperrt. Eine veröffentlichte App ändert sich nur durch „Publish and replace“ in der QMC.

### 6.7 History und Diff
- **History:** Commits des Branches (paginiert, 30 pro Seite) mit Autor, Datum, Nachricht, Tag-Badges. Aktionen: „Diff to previous“, „Diff to app“, „Add tag“, „Update app to this commit“.
- **Diff („details“):** Overlay in der Qlik-Seite; links die geänderten Objekte nach Typ mit Titel, rechts die Gegenüberstellung. Skripte zeilenweise nebeneinander (je Tab), JSON als Zeilen-Diff.
- **Pull Request:** Auf einem Branch ungleich Default-Branch zeigt das Panel den Link „Open pull request on GitHub“ (öffnet die Vergleichsseite `compare/<default>...<branch>`).

### 6.8 Tags
Annotiertes Git-Tag auf einem Commit (Name + optionale Beschreibung). Der Name wird gegen die Git-Regeln geprüft; ein bestehender Name wird nicht überschrieben. Der Reiter „Tags“ listet alle Tags mit Datum, Commit und den Aktionen „Diff to app“ und „Update app to this tag“.

### 6.9 Import (neue App aus Repo)
Im Hub oder in einer App: Repo, Branch und Commit oder Tag wählen → auf dem Server des aktiven Tabs wird eine neue App „<App-Name> (<branch|tag|sha7>)“ angelegt, befüllt und gespeichert. Daten werden nicht geladen. Die neue App ist nicht verknüpft; beim Öffnen kann der Nutzer sie verbinden oder einen Branch für sie anlegen. So lassen sich Stände auf andere Server übertragen.

## 7. Fehlerbehandlung

### GitHub
| Fall | Verhalten |
|---|---|
| `401` | „Token invalid or expired“ + Link zur Optionsseite |
| `403` mit Header `X-GitHub-SSO` | Hinweis, den Token für die Org per SSO freizugeben, + Link aus dem Header |
| `403`/`429` Rate Limit | Meldung mit Uhrzeit aus `X-RateLimit-Reset` bzw. `Retry-After` |
| `403` sonstige | „No permission“ (z. B. Repo-Anlage in der Org nicht erlaubt → Admin legt Repo an, danach „Connect“) |
| `404` | „Repository not found or no access“ |
| `422` bei Repo-Anlage | Name existiert → „Connect to existing repository“ anbieten |
| Branch lässt sich nicht per Fast-Forward setzen | Nachfrage „Update first“ / „Commit anyway“ (6.5) |
| Geschützter Branch lehnt Commit ab | Meldung mit Hinweis, auf einem eigenen Branch zu arbeiten |
| Netzwerkfehler | Meldung mit „Retry“ |

### Qlik
| Fall | Verhalten |
|---|---|
| Keine/abgelaufene Sitzung, WebSocket geschlossen | Hinweis, sich in Qlik neu anzumelden bzw. die Seite neu zu laden |
| Fehlende Schreibrechte | Update gesperrt |
| Fehler mitten im Update | Stopp beim ersten Fehler; das Panel zeigt erledigte und offene Aktionen sowie die Engine-Meldung; `syncedSha` bleibt unverändert. Die App lässt sich per Update erneut auf den Zielstand oder auf den Sicherungs-Branch bringen. |
| Zielstand enthält fehlerhafte Dateien (z. B. nach einem falsch gelösten Merge-Konflikt) | Update startet nicht; Liste der Dateien mit Link nach GitHub |
| Branch der App existiert nicht mehr | Hinweis; „Create Branch“ und „Connect to existing repository“ (gitoqlok meldet hier nur „Error occurred during GIT request“) |
| Server nicht in den Optionen eingetragen | Hinweis im Panel mit „Open options“; dort trägt „Add server“ den Server ein und fragt die Host-Berechtigung an. (Ohne Berechtigung kennt die Extension die Adresse des Tabs nicht.) |

### Sicherheit
- Token in `chrome.storage.local` (nicht `sync`); außer der Optionsseite, in der er eingetragen wird, liest ihn nur der Service Worker.
- Token erscheint nie in Logs, Fehlermeldungen oder Nachrichten an das Content Script.
- Der Service Worker nimmt Nachrichten nur von der eigenen Extension an, kennt nur eine feste Liste von GitHub-Aufrufen und führt sie nur gegen Repos der in den Optionen eingestellten Org aus. (Die Verknüpfung liegt in der App und taugt deshalb nicht als Grenze.)

## 8. Tests

- **Unit-Tests (Vitest)** für alle Logikmodule:
  - `serializer`/`deserializer`: synthetische Fixtures nach der Struktur des Referenz-Repos; gleicher Input → byte-gleicher Output; Normalisierung der Datei-URLs in beide Richtungen; Ausschluss skripterzeugter Variablen.
  - `script-tabs`: Teilen und Zusammensetzen ergibt das Original, inklusive Tab-Namen mit Sonderzeichen.
  - Prüfung des Zielstands: kaputtes JSON, Konfliktmarken, fehlende Tab-Datei.
  - `repo-layout`: Slug, Kollision, README erzeugen, Branch-Tabelle lesen und ergänzen (auch Tabellen, die gitoqlok geschrieben hat).
  - `diff`, `update-planner`, `git-hash`.
  - GitHub-Client mit gemocktem `fetch`: Commit-Ablauf, abgelehnter Fast-Forward, Branch anlegen, Fehlerzuordnung.
- **Abnahmetests gegen den Testserver** entlang der Erfolgskriterien 1 bis 5, als geführte Checkliste.
- **Manuelle Checkliste** für Sonderfälle: veröffentlichte App, fehlende Rechte, abgelaufene Sitzung, abgebrochenes Update, geschützter Branch.
- Automatisierte E2E-Tests (Playwright) sind für v1 nicht vorgesehen.

## 9. Spike vor der Umsetzung

**Abgeschlossen am 2026-11-13.** Ergebnisse: `docs/superpowers/spike/results.md`. Alle Fragen sind positiv beantwortet, bis auf Frage 6 (offen, die Test-App hat keine Story) und einen Teil von Frage 7 (`DoSave` nach einer Skriptänderung ist nicht geprüft).

Mehrere Annahmen lassen sich nur am echten Server prüfen. Der erste Schritt des Implementierungsplans ist ein kurzer Spike gegen den Testserver, dessen Code nicht übernommen wird:

1. Akzeptiert der Virtual Proxy eine WebSocket-Verbindung aus dem Content Script?
2. Lassen sich Dimensionen, Measures, Master-Visualisierungen, Sheets und Stories mit vorgegebener `qId` anlegen, in derselben und in einer neuen App?
3. Wird ein generisches Objekt vom Typ `qommit-link` beim Duplizieren mitkopiert, bleibt es ohne `DoSave` erhalten, und ist es in der Qlik-Oberfläche unsichtbar?
4. Liefert die Engine bei zwei Lesevorgängen ohne Änderung byte-gleiche Eigenschaften in gleicher Schlüsselreihenfolge, und stimmen sie mit den Dateien im Referenz-Repo überein?
5. Lassen sich statische Dateien einer App mit den Rechten eines Entwicklers lesen, hochladen und löschen (`/appcontent/…`, QRS `appcontent`)?
6. Übersteht eine Story mit Snapshots den Weg `GetFullPropertyTree` → `SetFullPropertyTree` in eine neue App ohne Daten?
7. Bleiben die Daten einer App erhalten, wenn `DoSave` nach Objekt- und Skriptänderungen in der Sitzung des Nutzers aufgerufen wird?
8. Lässt sich das Ladeskript einer veröffentlichten App mit den Rechten eines Entwicklers lesen?
9. Wandert das Link-Objekt mit, wenn eine App in der QMC per „Publish and replace“ über eine veröffentlichte App gelegt wird?
10. Wo legt gitoqlok `gitoqlikMetadata` in der App ab, und lässt es sich lesen?
11. Liefert `/qps/csrftoken` ein Token, und in welcher Form erwartet es der Virtual Proxy?

Fällt eine Antwort negativ aus, wird die Spec vor der Umsetzung angepasst.

## 10. Offene Punkte außerhalb von v1
- Wiederherstellen von Bookmarks
- Pull Requests in der Extension anlegen
- Publish App: Veröffentlichen aus der Extension, mit Prüfung, ob die App dem Stand von `main` entspricht, und optionalem Tag auf den veröffentlichten Commit
- Verteilung (Chrome Web Store „nicht gelistet“ oder Gruppenrichtlinie)
- Apps-Manager, Qlik Cloud

## 11. Änderungen in Revision 9 (nach dem Spike)

| Abschnitt | Änderung | Anlass |
|---|---|---|
| 3 | CSRF-Token: Form und Verhalten des Testservers eingetragen. Build mit esbuild statt Vite, Oberfläche mit Preact. | Spike-Frage 11; esbuild ist seit dem Spike im Projekt und baut Content Script, Service Worker und Seiten ohne weiteres Werkzeug. |
| 4.2, 4.3, 4.5 | Wertefarben von Master-Dimensionen stehen als `_ColorMapModel` in der Dimensionsdatei, ohne `qMeta`. | gitoqlok versioniert sie so; zwei Dimensionen des Referenz-Repos sind betroffen. |
| 4.3 | Kennzeichen der Variablen aus `GetProperties` und Variablenliste. | `GetProperties` kennzeichnet reservierte Variablen nicht. |
| 4.3 | Jede App-ID in `/appcontent/<App-ID>/` wird ersetzt, nicht nur die eigene; Regel für eine fehlende Default-Branch-Zeile. | Im Referenz-Repo tragen alle Sheets die ID einer anderen Branch-App. |
| 4.4 | Filter in veröffentlichten Apps auf Sheets, Stories und Bookmarks eingegrenzt; Hinweis zu Stories. | Spike-Frage 6 ist offen. |
| 5 | `qId` des Link-Objekts festgelegt; kein `DoSave` nach dem Schreiben; Ablageort und Nutzung von `_gitoqlikMetaData`; Auflösung in Schritt 4 genauer gefasst. | Spike-Fragen 3 und 10. |
| 3, 7 | Panel auf Tabs nicht eingetragener Server: nur Hinweis mit Link zu den Optionen. | Abschnitt 3 und 7 widersprachen sich; ohne Host-Berechtigung sieht die Extension die Adresse des Tabs nicht. |
| 7 | Grenze des Service Workers: feste Liste von Aufrufen, nur Repos der eingestellten Org. Die Optionsseite greift auf den Token zu. | Die Verknüpfung liegt in der App und lässt sich vom Service Worker nicht prüfen. |
| 9 | Spike abgeschlossen, Verweis auf die Ergebnisse. | – |
