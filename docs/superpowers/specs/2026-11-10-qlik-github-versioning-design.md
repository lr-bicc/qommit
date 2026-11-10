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
| Restore | In dieselbe App **und** als neue App |
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
4. **Roundtrip:** App A serialisieren → als neue App B wiederherstellen → B serialisieren ergibt bis auf IDs/Metadaten identische Dateien. Getestet mit mindestens drei echten Apps (klein, mittel, groß).
5. Ein Restore in dieselbe App kann über den automatischen Sicherungs-Commit vollständig rückgängig gemacht werden.

## 2. Architektur

### Kontexte und Komponenten
Die Qlik Engine API (WebSocket) prüft den `Origin`-Header gegen die Host-Whitelist des Virtual Proxy und benötigt den Session-Cookie. Deshalb laufen **alle Qlik-Zugriffe im Kontext der Qlik-Seite**, alle GitHub-Zugriffe im Service Worker.

| Komponente | Läuft in | Verantwortung |
|---|---|---|
| Popup | Extension-Seite | Tabs „Lokale Änderungen“, „Historie“, „Tags“; Commit-Formular; Restore-Dialog; Verknüpfungsdialog (neues Repo / verbinden). Löst nur Befehle aus und zeigt Status – keine Geschäftslogik. |
| Optionsseite | Extension-Seite | GitHub-Token + „Verbindung prüfen“, Org (Default `lr-bicc`), Repo-Präfix (Default `qlik-`), Liste der Qlik-Server-URLs |
| Service Worker | Hintergrund | Einziger Halter des Tokens; GitHub-Client; Orchestrierung der Abläufe (Commit, Restore, Tag, Verknüpfung); Nachrichten-Routing |
| Content Script | Qlik-Seite, isolierte Welt | Brücke Extension ↔ Seitenskript; Diff-Overlay und Restore-Fortschritt in Shadow DOM |
| Seitenskript | Qlik-Seite, Main World | Engine-Zugriff via enigma.js: App lesen, Objekte anlegen/ändern/löschen, neue App erzeugen, `DoSave` |

### Reine Logikmodule (ohne Browser-Abhängigkeit, einzeln testbar)
| Modul | Eingabe → Ausgabe |
|---|---|
| `serializer` | Rohdaten aus der Engine → `FileMap` (Pfad → Inhalt), deterministisch sortiert und formatiert |
| `deserializer` | `FileMap` → typisierte App-Struktur für den Restore |
| `diff` | zwei `FileMap`s → Liste von Objektänderungen (neu/geändert/gelöscht), für `script.qvs` zusätzlich Zeilen-Diff |
| `restore-planner` | Zielstand + aktueller App-Stand + gewählte Bereiche → geordnete Aktionsliste (anlegen/ändern/löschen) |
| `repo-layout` | App-Name/ID → Repo-Name, Dateipfade, Topic, Metadatei |

### Schnittstellen zwischen Kontexten
Nachrichten sind typisierte Request/Response-Paare (TypeScript-Union), z. B.:
- Popup → Service Worker: `getStatus`, `commit`, `listHistory`, `createTag`, `restore`, `linkRepo`, `createRepo`
- Service Worker → Seitenskript (über Content Script): `readApp`, `applyPlan`, `createApp`, `getAppInfo`
- Service Worker → Content Script: `showDiff`, `showProgress`

Langlaufende Abläufe laufen im Service Worker bzw. Seitenskript weiter, auch wenn das Popup geschlossen wird; das Popup fragt den Status beim erneuten Öffnen ab.

### Tech-Stack
TypeScript, Manifest V3, Vite, enigma.js, GitHub REST API via `fetch` (Git Data API für atomare Commits), Diff-Bibliothek `diff` (jsdiff) für Zeilen-Diffs, Vitest.

### Berechtigungen (Manifest)
- `storage`, `scripting`
- `host_permissions`: `https://api.github.com/*`
- `optional_host_permissions`: `https://*/*` – angefragt wird zur Laufzeit nur für die in den Optionen eingetragenen Qlik-Server.

## 3. Repo-Struktur und Verknüpfung

### Repo-Benennung
`<präfix><app-name-slug>`, z. B. `qlik-umsatz-dashboard`. Slug: Kleinbuchstaben, Umlaute transliteriert (ä→ae …), alle anderen Zeichen außer `a-z0-9` → `-`, mehrfache `-` zusammengefasst, max. 80 Zeichen. Bei Kollision werden `-<erste 8 Zeichen der App-ID>` angehängt. Repos werden als **privat** angelegt.

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
- Variablen-Dateinamen: Variablenname, für das Dateisystem escaped; reservierte/Systemvariablen werden ausgelassen.

### Was nicht versioniert wird
- Daten bzw. das QVF-Binary
- Datenverbindungen (Serverebene, enthalten Zugangsdaten)
- Private und Community-Objekte. Regel: In **unveröffentlichten** Apps werden alle Objekte versioniert; in **veröffentlichten** Apps nur Objekte mit `qMeta.approved = true` (Basis-Objekte).

### Verknüpfung App ↔ Repo
- Jedes verknüpfte Repo trägt das Topic `qlik-<app-id>` pro verknüpfter App.
- Auflösung beim Öffnen einer App: lokaler Cache (`chrome.storage.local`, App-ID → Repo) → GitHub-Suche `org:<org> topic:qlik-<app-id>`.
- Keine Verknüpfung gefunden → Popup bietet **„Neues Repo anlegen“** oder **„Mit bestehendem Repo verbinden“** (Repo-Auswahl aus der Org, Filter auf Präfix).
- „Verbinden“ ergänzt Topic und `linkedApps`-Eintrag. So können z. B. Dev- und Prod-App (unterschiedliche IDs) dasselbe Repo nutzen; Umbenennungen der App brechen die Verknüpfung nicht.
- Da die Verknüpfung auf GitHub liegt, gilt sie für das ganze Team ohne zusätzliche Konfiguration.
- Hinweis: Die GitHub-Suche kann nach dem Anlegen eines Repos kurz verzögert sein; deshalb wird der Cache beim Anlegen/Verbinden sofort geschrieben.

## 4. Abläufe

### Lokale Änderungen (Popup-Starttab)
Seitenskript liest die App → `serializer` → `FileMap`; Service Worker lädt die `FileMap` des HEAD-Commits von `main` → `diff`. Das Popup zeigt geänderte Objekte gruppiert nach Typ mit Status neu/geändert/gelöscht; Klick öffnet den Diff im Overlay.

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
Dialog mit Auswahl der Bereiche: Skript, Variablen, Master Items, Sheets, Bookmarks, Stories, Eigenschaften (Default: alle). Vor jedem Restore wird `serializerVersion` geprüft; ist sie höher als die der Extension, wird abgebrochen („Extension aktualisieren“).

### Restore – in dieselbe App
1. `restore-planner` erzeugt die Aktionsliste; Vorschau „X anlegen, Y ändern, Z löschen“ mit aufklappbarer Objektliste; Nutzer bestätigt.
2. Weicht die aktuelle App von HEAD ab → automatischer **Sicherungs-Commit** „Sicherung vor Wiederherstellung von `<sha|tag>`“.
3. Aktionen in fester Reihenfolge ausführen: Eigenschaften → Variablen → Master-Dimensionen/-Measures → Master-Visualisierungen → Sheets → Bookmarks → Stories → Skript; danach `DoSave`. Fortschritt im Overlay.
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
- Token erscheint nie in Logs, Fehlermeldungen oder Nachrichten an Content/Seitenskript.
- Seitenskript erhält nur die für die jeweilige Aktion nötigen Daten.

## 6. Tests

- **Unit-Tests (Vitest)** für alle Logikmodule:
  - `serializer`: Fixtures aus echten, anonymisierten Engine-Antworten; gleicher Input → byte-gleicher Output; flüchtige Felder werden entfernt.
  - `diff`, `restore-planner`, `repo-layout` (Slug, Kollision, Pfade).
  - GitHub-Client mit gemocktem `fetch`: Commit-Ablauf, Konflikt-Retry, Fehlerzuordnung.
- **Roundtrip-Test gegen den Dev-Server** (zentrales Abnahmekriterium, siehe Erfolgskriterium 4), als Skript, das über die Extension-Funktionen läuft.
- **Manuelle Checkliste** für UI und Sonderfälle: Popup, Overlay, Optionen/Verbindungstest, veröffentlichte App, fehlende Rechte, abgelaufene Sitzung, abgebrochener Restore.
- Automatisierte E2E-Tests (Playwright) sind für v1 nicht vorgesehen.

## 7. Offene Punkte außerhalb von v1
- Verteilung (Chrome Web Store „nicht gelistet“ oder Gruppenrichtlinie)
- Branches, Pull Requests, Apps-Manager, Qlik Cloud
