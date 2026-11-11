# Design: Versionierungstool für Qlik Sense Apps (Chrome-Extension + GitHub)

- **Datum:** 2026-11-10
- **Status:** Entwurf zur Freigabe
- **Vorbild:** gitoqlok – bewusst abgespeckt auf GitHub als einziges Backend

## 1. Ziel und Rahmen

### Ziel
Entwickler im Qlik-Team versionieren ihre Qlik-Sense-Apps direkt aus dem Browser heraus in GitHub. Jede Änderung ist nachvollziehbar (wer, was, wann), Stände lassen sich vergleichen, markieren und wiederherstellen. Manuelles Sichern von Ladeskripten entfällt.

### Rahmenbedingungen (entschieden)
| Thema | Entscheidung |
|---|---|
| Qlik-Plattform | Qlik Sense Enterprise on Windows (client-managed). Qlik Cloud ist nicht Teil von v1. |
| Versionierter Umfang | Komplette App-Struktur: Ladeskript, Variablen, Master-Dimensionen/-Measures/-Visualisierungen, Sheets inkl. Visualisierungen, Bookmarks, Stories, App-Eigenschaften |
| Restore | In dieselbe App **und** als neue App (Bookmarks ausgenommen, siehe Abschnitt 4) |
| Repo-Organisation | Ein Repo pro App in der GitHub-Org `lr-bicc` (wie gitoqlok) |
| GitHub-Auth | Persönlicher Access Token (classic, Scope `repo`) pro Entwickler, eingetragen in der Optionsseite (wie gitoqlok) |
| Funktionen v1 | Commit, Historie, Diff, Restore, Tags |
| Nicht in v1 | Branches, Pull Requests, Apps-Manager/Bulk-Anlage, Qlik Cloud, Daten/QVF-Binary |
| UI-Ansatz | Hybrid wie gitoqlok: Popup für Commit/Historie/Tags/Restore-Auslösung; Diff und Restore-Fortschritt als Overlay in der Qlik-Seite |
| Verteilung | Vorerst als entpackte Extension (Entwicklermodus); Store/Gruppenrichtlinie wird später entschieden |

### Erfolgskriterien
1. Ein Entwickler kann eine App mit einem Klick plus Commit-Nachricht nach GitHub committen; der Commit enthält den vollständigen App-Stand als lesbare Dateien.
2. Die Historie zeigt alle Commits mit Autor, Datum, Nachricht und Tags.
3. Diffs zeigen nur echte Änderungen (kein Rauschen durch Reihenfolge oder Formatierung).
4. **Roundtrip:** App A serialisieren → als neue App B wiederherstellen → B serialisieren ergibt identische Dateien (Objekt-IDs bleiben erhalten; ausgenommen sind `.qlik-app.json` und Bookmarks, siehe Abschnitt 4). Getestet mit mindestens drei echten Apps (klein, mittel, groß).
5. Ein Restore in dieselbe App kann über den automatischen Sicherungs-Commit vollständig rückgängig gemacht werden.

## 2. Architektur

### Kontexte und Komponenten
Die Qlik Engine API (WebSocket) prüft den `Origin`-Header gegen die Host-Whitelist des Virtual Proxy und benötigt den Session-Cookie. Deshalb laufen **alle Qlik-Zugriffe im Kontext der Qlik-Seite**, alle GitHub-Zugriffe im Service Worker.

| Komponente | Läuft in | Verantwortung |
|---|---|---|
| Popup | Extension-Seite | Tabs „Lokale Änderungen“, „Historie“, „Tags“; Commit-Formular; Restore-Dialog; Verknüpfungsdialog (neues Repo / verbinden). Löst nur Befehle aus und zeigt Status – keine Geschäftslogik. |
| Optionsseite | Extension-Seite | GitHub-Token + „Verbindung prüfen“, Org (Default `lr-bicc`), Repo-Präfix (Default `qlik-`), Liste der Qlik-Server-URLs |
| Service Worker | Hintergrund | Einziger Halter des Tokens; GitHub-Client; Nachrichten-Routing. Hält keinen Zustand im Speicher (siehe „Lebensdauer“). |
| Content Script | Qlik-Seite, isolierte Welt | Engine-Zugriff via enigma.js (App lesen, Objekte anlegen/ändern/löschen, neue App erzeugen, `DoSave`); führt den Restore-Plan aus; Diff-Overlay und Restore-Fortschritt in Shadow DOM |

**Engine-Zugriff aus dem Content Script:** Netzwerkzugriffe eines Content Scripts laufen unter dem Origin der Seite, also mit deren Cookie und einem Origin, den der Virtual Proxy akzeptiert. Ein zusätzliches Skript in der Main World entfällt damit, und die Qlik-Seite kann den Nachrichtenkanal nicht mitlesen oder fälschen. Der Spike (Abschnitt 7) bestätigt das für WebSockets auf dem Dev-Server; schlägt er fehl, wandert nur der Engine-Zugriff in ein Main-World-Skript, alles andere bleibt gleich.

**WebSocket-URL:** wird aus der Tab-URL abgeleitet, inklusive Virtual-Proxy-Präfix (`https://<host>/<präfix>/sense/app/<id>` → `wss://<host>/<präfix>/app/<id>`).

**Lebensdauer:** Chrome beendet einen untätigen Service Worker nach rund 30 Sekunden. Deshalb führt das Content Script lange Abläufe (Lesen, Restore) selbst aus und ruft den Service Worker nur für einzelne GitHub-Aufrufe. Der Stand eines laufenden Ablaufs liegt in `chrome.storage.session`, damit Popup und Overlay ihn jederzeit anzeigen können.

### Reine Logikmodule (ohne Browser-Abhängigkeit, einzeln testbar)
| Modul | Eingabe → Ausgabe |
|---|---|
| `serializer` | Rohdaten aus der Engine → `FileMap` (Pfad → Inhalt), deterministisch sortiert und formatiert |
| `deserializer` | `FileMap` → typisierte App-Struktur für den Restore |
| `diff` | zwei `FileMap`s → Liste von Objektänderungen (neu/geändert/gelöscht), für `script.qvs` zusätzlich Zeilen-Diff |
| `restore-planner` | Zielstand + aktueller App-Stand + gewählte Bereiche → geordnete Aktionsliste (anlegen/ändern/löschen) |
| `repo-layout` | App-Name/ID → Repo-Name, Dateipfade, Metadatei |
| `git-hash` | Dateiinhalt → Git-Blob-SHA (für den Vergleich mit GitHub ohne Download) |

### Schnittstellen zwischen Kontexten
Nachrichten sind typisierte Request/Response-Paare (TypeScript-Union), z. B.:
- Popup → Content Script (aktiver Tab): `getStatus`, `commit`, `restore`, `showDiff`, `getAppInfo`
- Popup → Service Worker: `listHistory`, `createTag`, `linkRepo`, `createRepo`, `listRepos`
- Content Script → Service Worker: `getHeadTree`, `getFiles`, `pushCommit`

Abläufe laufen weiter, auch wenn das Popup geschlossen wird; das Popup liest den Stand beim erneuten Öffnen aus `chrome.storage.session`. Wird der Tab während eines Restores geschlossen oder neu geladen, bricht der Ablauf ab und wird wie ein Fehler mitten im Restore behandelt (Abschnitt 5).

**UI-Sprache:** Deutsch.

### Tech-Stack
TypeScript, Manifest V3, Vite, enigma.js, GitHub REST API via `fetch` (Git Data API für atomare Commits), Diff-Bibliothek `diff` (jsdiff) für Zeilen-Diffs, Vitest.

### Berechtigungen (Manifest)
- `storage`, `scripting`
- `host_permissions`: `https://api.github.com/*`
- `optional_host_permissions`: `https://*/*` – angefragt wird zur Laufzeit nur für die in den Optionen eingetragenen Qlik-Server.

## 3. Repo-Struktur und Verknüpfung

### Repo-Benennung
`<präfix><app-name-slug>`, z. B. `qlik-umsatz-dashboard`. Slug: Kleinbuchstaben, Umlaute transliteriert (ä→ae …), alle anderen Zeichen außer `a-z0-9` → `-`, mehrfache `-` zusammengefasst, max. 80 Zeichen. Bei Kollision werden `-<erste 8 Zeichen der App-ID>` angehängt. Repos werden als **privat** und mit `auto_init: true` angelegt, weil die Git Data API auf einem leeren Repo mit `409` antwortet.

### Dateistruktur
```
.qlik-app.json          Metadaten (siehe unten)
script.qvs              Ladeskript als Klartext
app-properties.json     App-Eigenschaften (Titel, Beschreibung, Thema …)
variables/<name>.json
dimensions/<id>.json
measures/<id>.json
masterobjects/<id>.json
sheets/<id>.json        Sheet inkl. aller Kindobjekte (Full Property Tree)
bookmarks/<id>.json
stories/<id>.json
```

`.qlik-app.json`:
```json
{
  "serializerVersion": 1,
  "appName": "Umsatz Dashboard",
  "linkedApps": [
    { "appId": "…", "server": "https://qlik-dev.example" }
  ]
}
```

### Serialisierungsregeln
- JSON mit 2 Leerzeichen Einrückung, Schlüssel rekursiv alphabetisch sortiert, abschließender Zeilenumbruch.
- Flüchtige Felder werden entfernt (u. a. `qMeta`-Zeitstempel, `qLayout`-Rechenergebnisse, Session-IDs). Die genaue Liste wird im Serializer zentral gepflegt und per Fixture-Tests abgesichert.
- `script.qvs` wird unverändert (Zeilenenden normalisiert auf `\n`) gespeichert.
- Variablen-Dateinamen: Variablenname, für das Dateisystem escaped. Reservierte Variablen und im Ladeskript erzeugte Variablen (`qIsScriptCreated`) werden ausgelassen; letztere stehen bereits in `script.qvs` und entstehen beim Reload neu.
- Objekt-IDs (`qInfo.qId`) bleiben in den Dateien erhalten und werden beim Restore wiederverwendet. Nur so bleiben Verweise gültig, etwa von einer Visualisierung auf ein Master Item.

### Was nicht versioniert wird
- Daten bzw. das QVF-Binary
- Datenverbindungen (Serverebene, enthalten Zugangsdaten)
- Bilder aus der Medienbibliothek, Themes und Visualisierungs-Extensions. Versioniert wird nur der Verweis darauf; auf dem Zielserver müssen sie vorhanden sein.
- Private und Community-Objekte. Regel: In **unveröffentlichten** Apps werden alle Objekte versioniert; in **veröffentlichten** Apps nur Objekte mit `qMeta.approved = true` (Basis-Objekte).

### Verknüpfung App ↔ Repo
- Die einzige Quelle der Verknüpfung ist `linkedApps` in `.qlik-app.json` auf `main`.
- Auflösung beim Öffnen einer App: lokaler Cache (`chrome.storage.local`, App-ID → Repo) → sonst eine GraphQL-Abfrage, die alle Repos der Org mit dem Präfix samt Inhalt von `.qlik-app.json` liefert (100 Repos pro Seite), und Suche nach der App-ID darin. Das Ergebnis wird gecacht; ein Cache-Treffer wird beim ersten Zugriff gegen die Datei geprüft.
- Keine Verknüpfung gefunden → Popup bietet **„Neues Repo anlegen“** oder **„Mit bestehendem Repo verbinden“** (Repo-Auswahl aus der Org, Filter auf Präfix).
- „Verbinden“ ergänzt den `linkedApps`-Eintrag per Commit. So können z. B. Dev- und Prod-App (unterschiedliche IDs) dasselbe Repo nutzen; Umbenennungen der App brechen die Verknüpfung nicht.
- Da die Verknüpfung im Repo liegt, gilt sie für das ganze Team, und es genügen Schreibrechte auf das Repo.
- `.qlik-app.json` wird von der Extension verwaltet und erscheint nicht unter „Lokale Änderungen“.

## 4. Abläufe

### Lokale Änderungen (Popup-Starttab)
Content Script liest die App → `serializer` → `FileMap`. Vom HEAD-Commit auf `main` wird nur der Tree geladen (ein Aufruf, Pfad → Blob-SHA). `git-hash` berechnet die Blob-SHAs der lokalen Dateien; der Vergleich der SHAs ergibt neu/geändert/gelöscht ohne Download. Inhalte werden erst geladen, wenn der Nutzer einen Diff öffnet. Das Popup zeigt geänderte Objekte gruppiert nach Typ, mit Titel statt ID; Klick öffnet den Diff im Overlay.

### Commit
1. Nutzer gibt eine Nachricht ein und klickt „Commit“.
2. App wird frisch gelesen und serialisiert (gespeicherter Stand der App auf dem Server).
3. Service Worker: aktuellen HEAD von `main` lesen; nur geänderte Dateien als Blobs hochladen (max. 5 parallel); Tree mit `base_tree` = HEAD-Tree erzeugen, gelöschte Dateien mit `sha: null` entfernen; Commit erzeugen; `main` per Fast-Forward aktualisieren.
4. Konflikt beim Ref-Update (jemand hat parallel committet): einmal automatisch mit neuem HEAD als Parent wiederholen. Jeder Commit ist ein vollständiger Schnappschuss des Server-Stands, deshalb ist kein Merge nötig. Schlägt auch der zweite Versuch fehl → Fehlermeldung.
5. Keine Änderungen gegenüber HEAD → kein leerer Commit, Hinweis „Keine Änderungen“.

Autor des Commits ist der GitHub-Account des Token-Inhabers.

### Historie
Liste der Commits auf `main` (paginiert, 30 pro Seite) mit Autor, Datum, Nachricht, Tag-Badges. Aktionen pro Commit: „Diff zum Vorgänger“, „Diff zur aktuellen App“, „Tag setzen“, „Wiederherstellen…“.

### Diff
Overlay in der Qlik-Seite: links Liste der geänderten Objekte (gruppiert nach Typ), rechts Gegenüberstellung. `script.qvs` als zeilenweiser Side-by-Side-Diff, JSON-Objekte normalisiert und eingerückt als Zeilen-Diff.

### Tag
Annotiertes Git-Tag auf einem Commit (Name + optionale Beschreibung). Tag-Namen werden gegen Git-Regeln validiert; bestehender Name → Fehlermeldung, kein Überschreiben. Tab „Tags“ listet alle Tags mit Datum, Commit und Aktionen „Diff zur aktuellen App“ und „Wiederherstellen…“.

### Restore – gemeinsam
Dialog mit Auswahl der Bereiche: Skript, Variablen, Master Items, Sheets, Stories, Eigenschaften (Default: alle). Vor jedem Restore wird `serializerVersion` geprüft; ist sie höher als die der Extension, wird abgebrochen („Extension aktualisieren“).

Objekte werden mit ihrer ursprünglichen ID angelegt. Der `restore-planner` ordnet die Aktionen nach Abhängigkeit: Anlegen und Ändern in der Reihenfolge Eigenschaften → Variablen → Master-Dimensionen/-Measures → Master-Visualisierungen → Sheets → Stories → Skript, Löschen in umgekehrter Reihenfolge.

**Bookmarks werden versioniert und im Diff angezeigt, in v1 aber nicht wiederhergestellt.** Die Engine speichert die Auswahl eines Bookmarks nicht in seinen Eigenschaften; ein Bookmark lässt sich nur anlegen, indem man die Auswahl in einer App mit geladenen Daten nachstellt. In einer neuen App ohne Daten geht das nicht, und in der bestehenden App würde es die laufende Auswahl des Nutzers verändern. Beim Restore in dieselbe App bleiben vorhandene Bookmarks unangetastet.

### Restore – in dieselbe App
1. `restore-planner` erzeugt die Aktionsliste; Vorschau „X anlegen, Y ändern, Z löschen“ mit aufklappbarer Objektliste; Nutzer bestätigt.
2. Weicht die aktuelle App von HEAD ab → automatischer **Sicherungs-Commit** „Sicherung vor Wiederherstellung von `<sha|tag>`“.
3. Aktionen in der Reihenfolge des Plans ausführen; danach `DoSave`. Fortschritt im Overlay.
4. Automatischer Commit „Wiederhergestellt aus `<sha|tag>`“.
5. **Veröffentlichte Apps** und Apps ohne Schreibrecht: Restore in dieselbe App ist gesperrt; stattdessen wird „Als neue App“ angeboten.

### Restore – als neue App
Auf dem Server des aktiven Tabs wird eine neue App „<App-Name> (aus `<tag|sha7>`)“ angelegt, mit allen gewählten Bereichen befüllt und gespeichert. Es werden keine Daten geladen. Die neue App wird **nicht** automatisch mit dem Repo verknüpft; der Nutzer kann sie bei Bedarf über „Mit bestehendem Repo verbinden“ verknüpfen.

### Neue App aus Repo (im Hub)
Im Hub eines beliebigen eingetragenen Servers bietet das Popup „Neue App aus Repo“: Repo (aus der Org, Filter auf Präfix) und Commit/Tag auswählen → Ablauf wie „Restore als neue App“. Damit lassen sich Stände auf andere Server übertragen.

## 5. Fehlerbehandlung

### GitHub
| Fall | Verhalten |
|---|---|
| `401` | „Token ungültig oder abgelaufen“ + Link zur Optionsseite |
| `403` mit Header `X-GitHub-SSO` | „Token muss für die Org per SSO freigegeben werden“ + Link aus dem Header |
| `403`/`429` Rate Limit | Meldung mit Uhrzeit aus `X-RateLimit-Reset` bzw. `Retry-After` |
| `403` sonstige | „Keine Berechtigung“ (z. B. Repo-Anlage in der Org nicht erlaubt → Admin muss Repo anlegen, danach „Verbinden“) |
| `404` | „Repo nicht gefunden oder keine Leserechte“ |
| `422` bei Repo-Anlage | „Repo-Name existiert bereits“ → „Verbinden“ anbieten |
| Konflikt beim Ref-Update | ein automatischer Retry, danach Meldung |
| Netzwerkfehler | Meldung mit „Erneut versuchen“ |

### Qlik
| Fall | Verhalten |
|---|---|
| Keine/abgelaufene Sitzung, WebSocket geschlossen | „Bitte in Qlik neu anmelden bzw. Seite neu laden“ |
| Fehlende Schreibrechte | Restore in dieselbe App gesperrt, „Als neue App“ angeboten |
| Fehler mitten im Restore | Stopp beim ersten Fehler; Overlay zeigt erledigte und offene Aktionen sowie die Engine-Fehlermeldung; Button „Sicherung wiederherstellen“ (Restore des Sicherungs-Commits). Kein automatischer Commit „Wiederhergestellt aus …“. |
| Server nicht in den Optionen eingetragen | Popup zeigt Hinweis mit Button „Server hinzufügen“ (fragt Host-Berechtigung an) |

### Sicherheit
- Token in `chrome.storage.local` (nicht `sync`); nur der Service Worker liest ihn.
- Token erscheint nie in Logs, Fehlermeldungen oder Nachrichten an das Content Script.
- Der Service Worker nimmt Nachrichten nur von der eigenen Extension an und führt für das Content Script nur Aufrufe gegen das mit der App verknüpfte Repo aus.

## 6. Tests

- **Unit-Tests (Vitest)** für alle Logikmodule:
  - `serializer`: Fixtures aus echten, anonymisierten Engine-Antworten; gleicher Input → byte-gleicher Output; flüchtige Felder werden entfernt.
  - `diff`, `restore-planner`, `repo-layout` (Slug, Kollision, Pfade).
  - GitHub-Client mit gemocktem `fetch`: Commit-Ablauf, Konflikt-Retry, Fehlerzuordnung.
- **Roundtrip-Test gegen den Dev-Server** (zentrales Abnahmekriterium, siehe Erfolgskriterium 4), als Skript, das über die Extension-Funktionen läuft.
- **Manuelle Checkliste** für UI und Sonderfälle: Popup, Overlay, Optionen/Verbindungstest, veröffentlichte App, fehlende Rechte, abgelaufene Sitzung, abgebrochener Restore.
- Automatisierte E2E-Tests (Playwright) sind für v1 nicht vorgesehen.

## 7. Spike vor der Umsetzung

Mehrere Annahmen über die Engine lassen sich nur am echten Server prüfen. Der erste Schritt des Implementierungsplans ist deshalb ein kurzer Spike gegen den Dev-Server, dessen Code nicht übernommen wird. Er beantwortet:

1. Akzeptiert der Virtual Proxy eine WebSocket-Verbindung aus dem Content Script (isolierte Welt)?
2. Lassen sich Dimensionen, Measures, Master-Visualisierungen, Sheets und Stories mit vorgegebener `qId` anlegen, in derselben und in einer neuen App?
3. Übersteht eine Story mit Snapshots den Weg `GetFullPropertyTree` → `SetFullPropertyTree` in eine neue App ohne Daten?
4. Lässt sich das Ladeskript einer veröffentlichten App mit den Rechten eines Entwicklers lesen?
5. Bleiben die Daten einer App erhalten, wenn `DoSave` nach Objektänderungen in der Sitzung des Nutzers aufgerufen wird?
6. Welche Felder ändern sich zwischen zwei Lesevorgängen ohne Änderung an der App (Liste der flüchtigen Felder)?

Fällt eine Antwort negativ aus, wird die Spec vor der Umsetzung angepasst.

## 8. Offene Punkte außerhalb von v1
- Restore von Bookmarks
- Verteilung (Chrome Web Store „nicht gelistet“ oder Gruppenrichtlinie)
- Branches, Pull Requests, Apps-Manager, Qlik Cloud
