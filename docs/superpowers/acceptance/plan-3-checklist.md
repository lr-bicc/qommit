# Abnahme-Checkliste Plan 3: Qommit-Extension, zweite Stufe

Du führst diese Liste gegen den Testserver `https://lr-analytics-test.lrworld.com` aus. Hake jeden Schritt ab, wenn das erwartete Ergebnis eintritt. Weicht etwas ab, notiere den Wortlaut und mache ein Bildschirmfoto (siehe Abschnitt 5).

## Was diese Version zusätzlich kann

Neu gegenüber Plan 2: **Update** (Stand aus GitHub in die App schreiben, mit Vorschau und Sicherungs-Branch), Diff-Details („details“, „Diff to previous“, „Diff to app“), Tags und Import einer App aus einem Repository. Veröffentlichte Apps werden weiterhin nie beschrieben. Bookmarks werden nie geschrieben.

## 1. Vorbereitung

- [ ] **1.** Die Extension neu laden: In `chrome://extensions` bei Qommit „Neu laden“ klicken (nach `npm run build:ext` im Repo, Ergebnis in `dist/ext`). Erwartet: Qommit erscheint ohne Fehlermeldung in der Liste; Token und Server aus Plan 2 sind noch eingetragen.
- [ ] **2.** Qlik-Seite des Testservers `lr-analytics-test.lrworld.com` neu laden und das Panel öffnen. Erwartet: Das Panel öffnet ohne Fehler.

## 2. Update

- [ ] **3.** Kopie einer versionierten App, die hinter `main` steht, öffnen. In der Commit-Auswahl „Update (N)“ klicken, die Vorschau ansehen und „Update“ klicken. Erwartet: Die Vorschau nennt die Anzahl der anzulegenden, zu ändernden und zu löschenden Objekte; die Schaltfläche zeigt am Ende „Success“. Danach zeigt das Panel „No local changes“ und keinen Hinweis auf neue Commits.
- [ ] **4.** Dieselbe Kopie mit einer lokalen Änderung (ein Sheet umbenennen) auf einen älteren Commit aktualisieren. Erwartet auf GitHub: Ein Sicherungs-Branch `backup/<branch>-…` mit dem Commit „Backup before update to …“. Das Panel meldet „Repository has N new commits“.
- [ ] **5.** In der Commit-Auswahl den Sicherungs-Branch wählen und auf seinen Commit aktualisieren. Erwartet: Das umbenannte Sheet ist zurück. Es erscheint als lokale Änderung, weil der Sicherungs-Branch nicht auf dem Branch der App liegt (`syncedSha` bleibt).
- [ ] **6.** Nur „Load script“ übernehmen. Erwartet: Die Objekte bleiben, das Skript entspricht dem Zielstand. Danach die Daten der App neu laden und prüfen, dass die App ihre Daten nach dem `DoSave` behält (Spike-Frage 7, Skriptteil).
- [ ] **7.** Abgebrochenes Update: Während eines Updates den Tab neu laden. Erwartet: Das Panel zeigt den Hinweis „The last update did not finish …“. Ein erneutes Update entfernt ihn.
- [ ] **8.** Nur Dateien ändern, die das Update nie schreibt (z. B. die README in einem neuen Commit auf `main`), und dann „Update (N)“ wählen. Erwartet: Der Dialog sagt „The app already matches this state.“ und bietet „Update“ und „Cancel“. Nach „Update“ ist „Repository has N new commits“ verschwunden. Dasselbe gilt für ein abgebrochenes Update ohne verbliebene Änderungen: „Update“ beendet es und entfernt den Hinweis.

## 3. Tags, Diff und Import

- [ ] **9.** Tag „acceptance-1“ mit Beschreibung auf einen Commit setzen. Erwartet: Er ist im Reiter „Tags“ sichtbar und auf GitHub ein annotiertes Tag. Derselbe Name noch einmal ergibt „Tag already exists.“
- [ ] **10.** „Update app to this tag“ wählen. Erwartet: `syncedSha` bleibt (Prüfung über die Engine), und der Stand erscheint als lokale Änderung, falls das Tag nicht auf dem Branch liegt.
- [ ] **11.** „details“, „Diff to previous“ und „Diff to app“ wählen. Erwartet: Ein Overlay mit der Liste der Änderungen und der Gegenüberstellung; Skripte zeilenweise. „Close“ und die Escape-Taste schließen das Overlay.
- [ ] **12.** Import von „Supply Chain Performance“ (`main`) im Hub. Erwartet: Eine neue App „Supply Chain Performance (main)“ ohne Daten. Sie mit „Connect to existing repository“ → „To existing branch“ `main` verbinden. Erwartet: „No local changes“ außer Bookmarks (Erfolgskriterium 4). Danach „Unlink repository“ und die App löschen.
- [ ] **13.** Story mit Snapshots (falls eine App mit Story vorliegt): importieren und mit der Quelle vergleichen. Erwartet: Die Story samt Snapshots stimmt überein (Spike-Frage 6).

## 4. Veröffentlichte Apps und Ende zu Ende

- [ ] **14.** Eine veröffentlichte App öffnen. Erwartet: Kein „Update“ und keine „Update …“-Aktionen; „Diff to app“ und „Add tag“ sind vorhanden.
- [ ] **15.** Ende zu Ende (Erfolgskriterium 2): Kopie → „Create Branch“ → ändern → „Save changes“ → Pull Request auf GitHub mergen → in der QMC „Publish and replace“. Erwartet: Die veröffentlichte App zeigt „Published from commit“ mit dem Merge-Commit und „No local changes“.

## 5. Rückmeldung

Bitte melde zurück:

- [ ] Wie lange Vorschau und Update bei „Supply Chain Performance“ gedauert haben (Sekunden).
- [ ] Alle Fehlermeldungen im Wortlaut, mit Bildschirmfoto.
- [ ] Welche Schritte oben nicht wie erwartet liefen (Nummer und Abweichung).
