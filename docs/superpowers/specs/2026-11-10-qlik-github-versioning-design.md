# Design: Versionierungstool für Qlik Sense Apps (Chrome-Extension + GitHub)

- **Datum:** 2026-11-11 (Revision 3)
- **Status:** Entwurf zur Freigabe
- **Vorbild:** gitoqlok – bewusst abgespeckt auf GitHub als einziges Backend
- **Referenzen:** Repo `lr-bicc/supply-chain-performance` (von gitoqlok erzeugt) und die Bildschirmaufnahme des gitoqlok-Ablaufs vom 2026-11-11

## 1. Ziel und Rahmen

### Ziel
Entwickler im Qlik-Team versionieren ihre Qlik-Sense-Apps direkt aus dem Browser heraus in GitHub. Arbeitsweise, Oberfläche und Repo-Format folgen gitoqlok, damit das Team nicht umlernen muss und bestehende gitoqlok-Repos samt Historie weiter genutzt werden können.

### Rahmenbedingungen (entschieden)
| Thema | Entscheidung |
|---|---|
| Qlik-Plattform | Qlik Sense Enterprise on Windows (client-managed). Qlik Cloud ist nicht Teil von v1. |
| Versionierter Umfang | Ladeskript, Variablen, Master-Dimensionen/-Measures/-Visualisierungen, Sheets inkl. Visualisierungen, Stories, App-Eigenschaften, statische Dateien der App (Bilder), Bookmarks (nur lesend, siehe 4.4) |
| Repo-Organisation | Ein Repo pro App in der GitHub-Org `lr-bicc`, ein Branch pro App-Kopie (wie gitoqlok) |
| Repo-Format | gitoqlok-Format (Abschnitt 4); bestehende gitoqlok-Repos bleiben nutzbar |
| GitHub-Auth | Persönlicher Access Token (classic, Scope `repo`) pro Entwickler, eingetragen in der Optionsseite |
| Funktionen v1 | Repo anlegen/verbinden, Branch anlegen, Save changes (Commit), Update (Repo-Stand in die App übernehmen, auch ältere Stände), Historie, Diff, Tags, Import (neue App aus Repo) |
| Nicht in v1 | Pull Requests in der Extension anlegen oder mergen (nur Link nach GitHub), Publish App, Documentation Wizard, Qlik-Helper-Leiste, Apps-Manager, Qlik Cloud, QVF-Builds, Wiederherstellen von Bookmarks |
| UI-Ansatz | Chrome Side Panel wie gitoqlok; Diffs als Overlay in der Qlik-Seite |
| UI-Sprache | Englisch, mit den Bezeichnungen aus gitoqlok („Local Changes“, „Save changes“, „Update“, „Create Branch“ …) |
| Verteilung | Vorerst als entpackte Extension (Entwicklermodus) |

### Erfolgskriterien
1. **Kompatibilität:** Für die App eines bestehenden gitoqlok-Repos erzeugt die Extension die gepflegten Dateien (Abschnitt 4) inhaltsgleich zu gitoqlok, abgesehen von den dokumentierten Abweichungen (4.5).
2. **Branch-Ablauf Ende zu Ende:** App duplizieren → Branch anlegen → ändern → Save changes → Pull Request auf GitHub mergen → Update in der Haupt-App. Danach entspricht die Haupt-App der Branch-App.
3. **Kein Rauschen:** Eine frisch duplizierte App zeigt direkt nach dem Anlegen des Branches keine lokalen Änderungen. Ein Reload der Daten allein erzeugt keine lokalen Änderungen.
4. **Roundtrip:** App A serialisieren → per Import als neue App B anlegen → B serialisieren ergibt dieselben Dateien (Bookmarks ausgenommen). Getestet mit mindestens drei echten Apps (klein, mittel, groß).
5. **Nichts geht verloren:** Vor jedem Update, das lokale Änderungen überschreibt, liegt der bisherige App-Stand als Sicherungs-Branch auf GitHub.

## 2. Arbeitsweise

Wie bei gitoqlok gehört zu jedem Branch genau eine Qlik-App:

1. Die Haupt-App gehört zum Branch `main` ihres Repos.
2. Für eine Änderung dupliziert der Entwickler die App im Hub und öffnet die Kopie. Die Extension erkennt, dass die Kopie von einer versionierten App stammt, und bietet **Create Branch** an.
3. Der Entwickler arbeitet in der Kopie und sichert mit **Save changes** auf den Branch.
4. Der Branch wird auf GitHub per Pull Request nach `main` gemergt. Git führt dabei die Dateien zusammen; weil Kopien die Objekt-IDs der Haupt-App behalten, passen die Dateien zueinander.
5. In der Haupt-App meldet die Extension „Repository has N new commits“. **Update** übernimmt den Stand in die App.

## 3. Architektur

### Kontexte und Komponenten
Die Qlik Engine API (WebSocket) prüft den `Origin`-Header gegen die Host-Whitelist des Virtual Proxy und benötigt den Session-Cookie. Deshalb laufen alle Qlik-Zugriffe im Kontext der Qlik-Seite, alle GitHub-Zugriffe im Service Worker.

| Komponente | Läuft in | Verantwortung |
|---|---|---|
| Side Panel | Extension-Seite neben der Qlik-Seite | Gesamte Bedienung (Abschnitt 6.1). Löst Befehle aus und zeigt Status; keine Geschäftslogik. |
| Optionsseite | Extension-Seite | GitHub-Token + „Check connection“, Org (Default `lr-bicc`), optionales Repo-Präfix (Default leer), Liste der Qlik-Server-URLs |
| Service Worker | Hintergrund | Einziger Halter des Tokens; GitHub-Client; öffnet das Side Panel beim Klick auf das Extension-Icon. Hält keinen Zustand im Speicher. |
| Content Script | Qlik-Seite, isolierte Welt | Engine-Zugriff via enigma.js; liest und schreibt statische Dateien; führt Update-Pläne aus; zeigt Diff-Overlay in Shadow DOM |

**Side Panel:** Benötigt Chrome 116 oder neuer. Das Panel wird pro Tab aktiviert und nur auf Tabs der eingetragenen Qlik-Server angeboten; es zeigt immer den Stand des Tabs, zu dem es gehört.

**Engine-Zugriff aus dem Content Script:** Netzwerkzugriffe eines Content Scripts laufen unter dem Origin der Seite, also mit deren Cookie und einem Origin, den der Virtual Proxy akzeptiert. Der Spike (Abschnitt 9) bestätigt das für WebSockets; schlägt er fehl, wandert nur der Engine-Zugriff in ein Main-World-Skript.

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
TypeScript, Manifest V3, Vite, enigma.js, GitHub REST API (Git Data API für atomare Commits) und GraphQL via `fetch`, Diff-Bibliothek `diff` (jsdiff), Vitest.

### Berechtigungen (Manifest)
- `storage`, `scripting`, `sidePanel`
- `host_permissions`: `https://api.github.com/*`
- `optional_host_permissions`: `https://*/*` – angefragt wird zur Laufzeit nur für die in den Optionen eingetragenen Qlik-Server.

## 4. Repo-Format

### 4.1 Benennung
Repo-Name = App-Name als Slug (Kleinbuchstaben, Umlaute transliteriert, alles außer `a-z0-9` → `-`, mehrfache `-` zusammengefasst, max. 80 Zeichen), optional mit Präfix aus den Optionen. Beispiel: „Supply Chain Performance“ → `supply-chain-performance`. Bei Kollision werden `-<erste 8 Zeichen der App-ID>` angehängt. Repos werden **privat**, mit Default-Branch `main` und mit `auto_init: true` angelegt, weil die Git Data API auf einem leeren Repo mit `409` antwortet.

### 4.2 Dateistruktur (wie gitoqlok)
```
README.md                         Titel, Ersteller, Sheet-Tabelle, Branch-Tabelle
loadScript.qvs                    komplettes Ladeskript
data_load_script/<Tab>.qvs        eine Datei pro Skript-Tab
data_load_script/tab_order.txt    Reihenfolge der Tabs
objects/appprops.json             App-Eigenschaften
objects/variables/<qId>.json
objects/dimensions/<qId>.json
objects/measures/<qId>.json
objects/masterobjects/<qId>.json  Full Property Tree
objects/sheets/<qId>.json         Full Property Tree (Sheet + alle Kindobjekte)
objects/stories/<qId>.json        Full Property Tree
objects/bookmarks/<qId>.json
appcontent/<Dateiname>            statische Dateien der App (Bilder)
```

### 4.3 Serialisierungsregeln
- **JSON:** 2 Leerzeichen Einrückung, Schlüssel in der Reihenfolge der Engine, Zeilenenden `\n`, kein abschließender Zeilenumbruch. Variablen, Dimensionen und Measures sind die Eigenschaften des Objekts (`GetProperties`); Sheets, Master-Visualisierungen und Stories sind `{ "qProperty": …, "qChildren": [...] }` (`GetFullPropertyTree`); `appprops.json` ist ein Array solcher Bäume.
- **Objekt-IDs** (`qInfo.qId`) sind Dateiname und bleiben erhalten. Sie werden bei Update und Import wiederverwendet; nur so bleiben Verweise gültig, etwa von einer Visualisierung auf ein Master Item, und nur so lassen sich Branches mergen.
- **Ladeskript:** `loadScript.qvs` enthält das Skript unverändert, inklusive Zeilenenden. Die Tab-Dateien entstehen durch Teilen an den Zeilen `///$tab <Name>`; Dateiname ist der Tab-Name, in dem für Dateinamen ungültige Zeichen durch Leerzeichen ersetzt sind. `tab_order.txt` enthält die Namen in Reihenfolge, getrennt durch `%tab_file_order_divider%`. Maßgeblich beim Update ist `loadScript.qvs`; weichen die Tab-Dateien davon ab (etwa nach einem von Hand gelösten Merge-Konflikt), warnt die Extension vor dem Update.
- **App-ID in Datei-URLs:** Verweise der Form `/appcontent/<App-ID>/<Datei>` enthalten die ID der jeweiligen App. Beim Schreiben ins Repo wird die ID durch die der `main`-App ersetzt, beim Übernehmen in eine App durch deren eigene ID. Ohne diese Regel ändert jeder Branch-Wechsel alle Sheets mit Bildern.
- **README.md** wird beim Anlegen des Repos erzeugt (Titel, Ersteller, Datum, Tabelle der Sheets, Branch-Tabelle). Danach ändert die Extension nur noch die Branch-Tabelle.

### 4.4 Was nicht oder nur eingeschränkt versioniert wird
- Daten und QVF-Dateien (`builds/` wird nicht gepflegt)
- Datenverbindungen (Serverebene, enthalten Zugangsdaten)
- Themes und Visualisierungs-Extensions; auf dem Zielserver müssen sie vorhanden sein
- Private und Community-Objekte: In unveröffentlichten Apps werden alle Objekte versioniert, in veröffentlichten nur Objekte mit `qMeta.approved = true`.
- **Bookmarks** werden gespeichert und im Diff angezeigt, aber nicht in eine App zurückgeschrieben. Die Engine legt ein Bookmark nur an, indem die Auswahl in einer App mit Daten nachgestellt wird; das würde die laufende Auswahl des Nutzers verändern und geht in einer App ohne Daten gar nicht.

### 4.5 Bewusste Abweichungen von gitoqlok
| Abweichung | Grund |
|---|---|
| Im Ladeskript erzeugte Variablen (`qIsScriptCreated`) werden nicht versioniert. | Sie stehen bereits im Skript und ändern sich bei jedem Reload (`vU.Today`, `Qvc.Global.v.ScriptStart` …). Im Referenz-Repo betreffen alle 190 Variablenänderungen der letzten 60 Commits solche Variablen. |
| App-IDs in Datei-URLs werden normalisiert (4.3). | Im Referenz-Repo steht dort die ID der zuletzt committenden Branch-App; eine frische Kopie zeigt deshalb sofort 11 geänderte Sheets. |
| `objects/fields.json`, `objects/themes.json`, `objects/glossarylinks.json` werden nicht gepflegt. | Abgeleitete Daten, die sich nicht in eine App zurückschreiben lassen. |
| Commit-Nachrichten erhalten keinen Zusatz wie `[%_OBJECTS_%%_SCRIPT_%]`. | Der Zusatz ist für die Extension nicht nötig. |

**Bestehende gitoqlok-Repos:** Der erste „Save changes“ mit der Extension entfernt einmalig die Dateien skripterzeugter Variablen und schreibt die normalisierten Datei-URLs. Nicht gepflegte Dateien (`fields.json`, `themes.json`, `glossarylinks.json`, `builds/`) bleiben unverändert liegen.

## 5. Verknüpfung App ↔ Repo ↔ Branch

### In der App: Link-Objekt
Die Extension legt in jeder verknüpften App ein verstecktes generisches Objekt vom Typ `git-link` an:
```json
{ "repo": "lr-bicc/supply-chain-performance", "branch": "main", "appId": "<ID dieser App>", "syncedSha": "<Commit, auf dem die App steht>" }
```
- Das Objekt wird nicht versioniert.
- Wird eine App dupliziert, wandert das Objekt mit. In der Kopie stimmt `appId` nicht mit der eigenen ID überein; daran erkennt die Extension „duplicated from an app tracked in <repo>“.
- `syncedSha` ist der Commit, mit dem die App zuletzt abgeglichen wurde. Er trennt lokale Änderungen (App gegen `syncedSha`) von neuen Commits (`syncedSha` gegen Branch-HEAD).
- Lässt sich das Objekt nicht anlegen (veröffentlichte App, fehlende Rechte), liegen dieselben Angaben in `chrome.storage.local`; die Erkennung von Kopien entfällt dann.

### Im Repo: Branch-Tabelle in README.md
Wie bei gitoqlok enthält `README.md` die Tabelle `Branch Name | Qlik application` mit der URL der App je Branch. Die Extension ergänzt beim Anlegen eines Branches eine Zeile (Commit „Update branches table“ auf dem Default-Branch; ist dieser geschützt, auf dem neuen Branch).

### Auflösung beim Öffnen einer App
1. Link-Objekt mit passender `appId` → verknüpft.
2. Link-Objekt mit fremder `appId` → Kopie einer versionierten App (Ablauf 6.3).
3. Kein Link-Objekt → lokaler Cache, sonst eine GraphQL-Abfrage über die Repos der Org, die `README.md` des Default-Branches liest und die App-ID in der Branch-Tabelle sucht. Treffer → Link-Objekt wird angelegt. So werden Apps erkannt, die bisher mit gitoqlok versioniert wurden.
4. Kein Treffer → „No linked repository“ (Ablauf 6.2).

## 6. Abläufe

### 6.1 Aufbau des Side Panels
- **Kopf:** App-Name; darunter Repo (`lr-bicc/<repo>`, Link nach GitHub), Branch-Badge, Hinweis „Repository has N new commits“, Symbole für „Unlink“ und „Refresh“.
- **Reiter:** Local Changes · History · Tags · Import
- **Local Changes:** Commit-Auswahl + **Update** (mit Zähler neuer Commits und Aufklappmenü für die Teile), **Save changes**, darunter die Gruppen *Added objects*, *Deleted objects*, *Changed objects*, jeweils unterteilt nach Sheets, Master Items, Variables, Script, Attached files, mit Objekttitel und Link „details“.
- **Fußzeile:** Status („Ready“, „Loading application data…“, Fortschritt).
- Repo-Daten werden pro Branch zwischengespeichert; „Refresh“ lädt sie neu.

### 6.2 App ohne Repo
Das Panel zeigt „No linked repository“ mit zwei Aktionen:
- **Create repository:** legt das Repo an (4.1), erzeugt `README.md`, committet den App-Stand als ersten Commit auf `main` und legt das Link-Objekt an.
- **Connect to existing repository:** Auswahl eines Repos der Org und eines Branches; die App wird diesem Branch zugeordnet (Link-Objekt, Zeile in der Branch-Tabelle). `syncedSha` wird auf den Branch-HEAD gesetzt; Unterschiede erscheinen als lokale Änderungen.

### 6.3 Kopie einer versionierten App: Create Branch
Das Panel meldet „We found a repository for the master Qlik application, from which current application was duplicated“ und bietet **Create Branch**, **Unlink Repository** und **Connect to existing repository** an.

Create Branch:
- Feld „Branch Name“, vorbelegt mit dem Qlik-Benutzernamen (z. B. `r.vasilev`); der Name wird gegen die Git-Regeln geprüft.
- Option „Branch off from the branch that is used in the app you are duplicating from“ mit Anzeige dieses Branches. Ohne Option wird vom Default-Branch abgezweigt.
- Ablauf: Zeile in der Branch-Tabelle committen → Branch auf diesen Commit anlegen → Link-Objekt der Kopie auf den neuen Branch und die eigene App-ID setzen, `syncedSha` = Branch-HEAD.
- Existiert der Branch-Name bereits → Fehlermeldung, nichts wird geändert.

### 6.4 Local Changes
Das Content Script liest die App und serialisiert sie. Vom Commit `syncedSha` wird nur der Tree geladen (Pfad → Blob-SHA); `git-hash` berechnet die Blob-SHAs der lokalen Dateien, der Vergleich ergibt added/deleted/changed ohne Download. Inhalte werden erst für „details“ geladen. Der HEAD des Branches wird abgefragt; liegt er vor `syncedSha`, zeigt der Kopf die Zahl neuer Commits.

### 6.5 Save changes (Commit)
1. Dialog mit Commit-Nachricht und Auswahl der Teile: Objects, Bookmarks, Script, Static files (Default: alle).
2. **Nur möglich, wenn `syncedSha` der Branch-HEAD ist.** Gibt es neue Commits, verlangt die Extension zuerst ein Update. Ein Commit ist ein Schnappschuss der App; auf einen neueren Stand gesetzt, würde er die Änderungen anderer stillschweigend zurückdrehen.
3. Die App wird frisch gelesen. Der Service Worker lädt geänderte Dateien der gewählten Teile als Blobs hoch (max. 5 parallel, Binärdateien base64), erzeugt den Tree auf Basis des HEAD-Trees (gelöschte Dateien mit `sha: null`), erzeugt den Commit und setzt den Branch per Fast-Forward.
4. Schlägt das Setzen des Branches fehl, weil inzwischen jemand committet hat → Meldung „Update erforderlich“, nichts geht verloren.
5. Danach `syncedSha` = neuer Commit. Keine Änderungen → kein leerer Commit.

Autor ist der GitHub-Account des Token-Inhabers.

### 6.6 Update (Repo-Stand in die App übernehmen)
Ziel ist der Branch-HEAD oder ein in der Commit-Auswahl gewählter älterer Commit oder Tag. Über das Aufklappmenü lassen sich die Teile wählen: Objects, Script, Static files (Default: alle).

1. `update-planner` erzeugt die Aktionsliste. Anlegen und Ändern in der Reihenfolge App-Eigenschaften → Variablen → Master-Dimensionen/-Measures → Master-Visualisierungen → Sheets → Stories → statische Dateien → Skript; Löschen in umgekehrter Reihenfolge. Objekte werden mit ihrer ursprünglichen ID angelegt.
2. Vorschau „X anlegen, Y ändern, Z löschen“ mit aufklappbarer Liste; der Nutzer bestätigt.
3. Hat die App lokale Änderungen, werden sie zuerst gesichert: Commit des aktuellen App-Stands mit Parent `syncedSha` auf einen neuen Branch `backup/<branch>-<JJJJMMTT-hhmm>`. Der Sicherungs-Branch lässt sich auf GitHub per Pull Request wieder einbringen oder per Update zurückholen.
4. Aktionen ausführen, danach `DoSave`. Fortschritt in der Fußzeile.
5. `syncedSha` = Branch-HEAD. Wurde ein älterer Commit oder nur ein Teil übernommen, erscheinen die Unterschiede zum HEAD anschließend als lokale Änderungen; „Save changes“ macht daraus einen normalen Commit. Es gibt keinen automatischen Commit.
6. Veröffentlichte Apps und Apps ohne Schreibrecht: Update ist gesperrt; stattdessen wird Import angeboten.

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
| Branch lässt sich nicht per Fast-Forward setzen | „Update required“ (6.5) |
| Geschützter Branch lehnt Commit ab | Meldung mit Hinweis, auf einem eigenen Branch zu arbeiten |
| Netzwerkfehler | Meldung mit „Retry“ |

### Qlik
| Fall | Verhalten |
|---|---|
| Keine/abgelaufene Sitzung, WebSocket geschlossen | Hinweis, sich in Qlik neu anzumelden bzw. die Seite neu zu laden |
| Fehlende Schreibrechte | Update gesperrt, Import angeboten |
| Fehler mitten im Update | Stopp beim ersten Fehler; das Panel zeigt erledigte und offene Aktionen sowie die Engine-Meldung; `syncedSha` bleibt unverändert. Die App lässt sich per Update erneut auf den Zielstand oder auf den Sicherungs-Branch bringen. |
| Tab-Dateien weichen von `loadScript.qvs` ab | Warnung vor dem Update, `loadScript.qvs` gilt |
| Server nicht in den Optionen eingetragen | Hinweis mit „Add server“ (fragt Host-Berechtigung an) |

### Sicherheit
- Token in `chrome.storage.local` (nicht `sync`); nur der Service Worker liest ihn.
- Token erscheint nie in Logs, Fehlermeldungen oder Nachrichten an das Content Script.
- Der Service Worker nimmt Nachrichten nur von der eigenen Extension an und führt für das Content Script nur Aufrufe gegen das mit der App verknüpfte Repo aus.

## 8. Tests

- **Unit-Tests (Vitest)** für alle Logikmodule:
  - `serializer`/`deserializer`: synthetische Fixtures nach der Struktur des Referenz-Repos; gleicher Input → byte-gleicher Output; Normalisierung der Datei-URLs in beide Richtungen; Ausschluss skripterzeugter Variablen.
  - `script-tabs`: Teilen und Zusammensetzen ergibt das Original, inklusive Tab-Namen mit Sonderzeichen.
  - `repo-layout`: Slug, Kollision, README erzeugen, Branch-Tabelle lesen und ergänzen (auch Tabellen, die gitoqlok geschrieben hat).
  - `diff`, `update-planner`, `git-hash`.
  - GitHub-Client mit gemocktem `fetch`: Commit-Ablauf, abgelehnter Fast-Forward, Branch anlegen, Fehlerzuordnung.
- **Abnahmetests gegen den Testserver** entlang der Erfolgskriterien 1 bis 5, als geführte Checkliste.
- **Manuelle Checkliste** für Sonderfälle: veröffentlichte App, fehlende Rechte, abgelaufene Sitzung, abgebrochenes Update, geschützter Branch.
- Automatisierte E2E-Tests (Playwright) sind für v1 nicht vorgesehen.

## 9. Spike vor der Umsetzung

Mehrere Annahmen lassen sich nur am echten Server prüfen. Der erste Schritt des Implementierungsplans ist ein kurzer Spike gegen den Testserver, dessen Code nicht übernommen wird:

1. Akzeptiert der Virtual Proxy eine WebSocket-Verbindung aus dem Content Script?
2. Lassen sich Dimensionen, Measures, Master-Visualisierungen, Sheets und Stories mit vorgegebener `qId` anlegen, in derselben und in einer neuen App?
3. Wird ein generisches Objekt vom Typ `git-link` beim Duplizieren mitkopiert, bleibt es ohne `DoSave` erhalten, und ist es in der Qlik-Oberfläche unsichtbar?
4. Liefert die Engine bei zwei Lesevorgängen ohne Änderung byte-gleiche Eigenschaften in gleicher Schlüsselreihenfolge, und stimmen sie mit den Dateien im Referenz-Repo überein?
5. Lassen sich statische Dateien einer App mit den Rechten eines Entwicklers lesen, hochladen und löschen (`/appcontent/…`, QRS `appcontent`)?
6. Übersteht eine Story mit Snapshots den Weg `GetFullPropertyTree` → `SetFullPropertyTree` in eine neue App ohne Daten?
7. Bleiben die Daten einer App erhalten, wenn `DoSave` nach Objekt- und Skriptänderungen in der Sitzung des Nutzers aufgerufen wird?
8. Lässt sich das Ladeskript einer veröffentlichten App mit den Rechten eines Entwicklers lesen?

Fällt eine Antwort negativ aus, wird die Spec vor der Umsetzung angepasst.

## 10. Offene Punkte außerhalb von v1
- Wiederherstellen von Bookmarks
- Pull Requests in der Extension anlegen
- Verteilung (Chrome Web Store „nicht gelistet“ oder Gruppenrichtlinie)
- Apps-Manager, Qlik Cloud
