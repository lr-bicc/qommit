# Eingaben für Plan 2 (Extension)

Stand nach Abschluss von Plan 1 (`2026-11-11-spike-and-core.md`), Branch `feat/spike-and-core`. Diese Liste sammelt, was die Reviews von Plan 1 an Plan 2 weiterreichen. Plan 2 wird erst geschrieben, wenn die Spike-Berichte vorliegen (`docs/superpowers/spike/RUNBOOK.md`).

## Entscheidungen, die Plan 2 treffen muss

1. **Fremde App-IDs in `/appcontent/<id>/`-URLs.** Heute ersetzt der Deserializer nur IDs aus `knownAppIds`. Steht in einer Datei die ID einer anderen Branch-Kopie, wird sie unverändert in die App geschrieben und fällt nie als lokale Änderung auf; die Bilder brechen, sobald jene Kopie gelöscht wird. Empfehlung: auf beiden Seiten jede GUID nach `/appcontent/` ersetzen (deckt auch Apps ab, die nicht mehr in der Branch-Tabelle stehen). Das ändert Spec 4.5.
2. **Mehrdeutige Zuordnung.** `findRepoForApp` und `findBranchForApp` liefern den ersten Treffer. Steht eine App unter zwei Branches oder in zwei Repos, muss das Panel das als mehrdeutig anzeigen.
3. **Fehlende Zeile des Standard-Branches.** `canonicalAppId` liefert dann `null`; die Spec sagt nicht, was passieren soll.

## Pflichten des Aufrufers (Engine-Adapter, Abläufe)

- Den Zielstand mit der ID der geöffneten App als `targetAppId` deserialisieren, sonst unterscheiden sich Sheets mit Thumbnails immer.
- Variablen-Kennzeichen `qIsScriptCreated` / `qIsReserved`: klären, aus welcher Engine-Quelle sie kommen (Spike P4 berichtet das). Fehlen sie im Snapshot, werden Skript-Variablen versioniert und beim Update gelöscht.
- „Commit anyway“: Änderungen gegen den Baum des aktuellen Branch-Kopfs bilden, nicht gegen `syncedSha`; eine Löschung eines Pfads, den es im `base_tree` nicht gibt, lehnt GitHub vermutlich ab.
- `getBranchSha` liefert `null` auch für ein unzugängliches Repo (GitHub antwortet in beiden Fällen 404). Vor „Branch wurde gelöscht“ den Repo-Zugriff prüfen.
- Im Browser prüfen, dass `fetch` den `Authorization`-Header beim Zipball-Redirect auf `codeload.github.com` nicht mitschickt.
- `serializeApp` wirft bei einer leeren `qId` oder einer `qId` mit `/`. Das Panel braucht dafür eine verständliche Meldung.
- `validateTarget` kennt jetzt zusätzlich `missing-tab-order` und `invalid-object`; beide brauchen einen Text im Panel.

## Aufgaben für Plan 2

- `listBranches` und `listTags` paginieren (heute höchstens 100; Backup-Branches sammeln sich an).
- Großer Erst-Commit: ein Blob-Request pro Datei kann GitHubs sekundäre Limits treffen; Textdateien als `content` direkt im Tree-Aufruf senden.
- Nach einem fehlgeschlagenen Blob-Upload die übrigen Uploads abbrechen.
- GraphQL-Antwort `RATE_LIMITED` (HTTP 200) auf die Rate-Limit-Art abbilden; `retry-after` als HTTP-Datum auswerten.
- Pfad-Erkennung von Deserializer und `groupOf` zusammenführen; `asText` existiert viermal.
- Update-Planer: Namenstausch zweier Variablen braucht einen Zwischennamen; eine Zielvariable, deren Name eine Skript-Variable der App belegt, scheitert beim Anlegen.
- README-Tabelle: `|` in Branch-Namen und Sheet-Titeln, `)` und Leerzeichen in URLs maskieren.
- Tab-Dateinamen: abschließende Punkte/Leerzeichen und Steuerzeichen unter Windows; Skripte mit gemischten Zeilenenden werden nicht bytegleich wiederhergestellt.
- `isValidRefName` lässt Steuerzeichen und ein einzelnes `@` zu.
- Fehlende Tests: BOM bleibt beim Zipball-Download erhalten; `listOrgRepos`; leeres Repo ohne Standard-Branch; `qIsReserved` wird nicht geschrieben; nicht gepflegte Pfade werden ignoriert.

## Bereits geprüft

Das Referenz-Repo `lr-bicc/sales-overview` (806 Dateien) besteht `validateTarget` ohne Befund. `deserializeApp` → `serializeApp` schreibt 443 Dateien, alle bytegleich mit dem Repo. Nicht geschrieben werden wie in Spec 4.5 festgelegt: skript-erzeugte Variablen, `loadScript.qvs`, `fields.json`, `themes.json`, `glossarylinks.json`, `builds/`.
