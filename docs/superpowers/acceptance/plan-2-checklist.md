# Abnahme-Checkliste Plan 2: Qommit-Extension, erste Stufe

Du führst diese Liste gegen den Testserver `https://lr-analytics-test.lrworld.com` aus. Hake jeden Schritt ab, wenn das erwartete Ergebnis eintritt. Weicht etwas ab, notiere den Wortlaut und mache ein Bildschirmfoto (siehe Abschnitt 8).

## Was diese Version kann und was nicht

Diese Version verbindet eine Qlik-Sense-App mit einem GitHub-Repository, zeigt lokale Änderungen und speichert ausgewählte Änderungen als Commit. Sie kann noch **nicht**:

- **Update** (Stand aus GitHub in die App zurückschreiben),
- Diff-Details (Inhalt einer Änderung ansehen),
- Tags,
- Import.

In der Qlik-App wird nichts verändert außer einem versteckten Objekt (Typ `qommit-link`), das die Verknüpfung zum Repository speichert. Es erscheint in keinem Sheet. Veröffentlichte Apps werden nie beschrieben.

## 1. Einrichten

- [ ] `qommit-extension.zip` entpacken (oder im Repo `npm run build:ext` ausführen; das Ergebnis liegt dann in `dist/ext`). In Chrome `chrome://extensions` öffnen, „Entwicklermodus" einschalten, „Entpackte Erweiterung laden" und den entpackten Ordner `qommit-extension` wählen. Erwartet: Qommit erscheint ohne Fehlermeldung in der Liste. Die Spike-Extension vorher entfernen.
- [ ] Optionen der Extension öffnen, deinen GitHub-Token eintragen und speichern. Erwartet: Der Token wird gespeichert, das Feld zeigt ihn nicht im Klartext.
- [ ] „Check connection" klicken. Erwartet: Erfolgsmeldung mit deinem GitHub-Benutzernamen.
- [ ] Server `https://lr-analytics-test.lrworld.com` hinzufügen. Erwartet: Chrome fragt nach der Berechtigung für diese Seite, nach Zustimmung steht der Server in der Liste.

## 2. Bestehendes gitoqlok-Repo

- [ ] Im Hub die veröffentlichte „Supply Chain Performance" duplizieren, die Kopie öffnen und das Qommit-Panel öffnen. Erwartet: Das Panel weist darauf hin, dass dies die Kopie einer versionierten App ist.
- [ ] „Create Branch" wählen und einen eigenen Branch-Namen eingeben. Erwartet auf GitHub: Der neue Branch existiert im Repository, und auf dem Standard-Branch gibt es einen Commit „Update branches table" (die README-Tabelle enthält die neue Zeile). Das Panel zeigt die App danach als verknüpft mit dem neuen Branch.

## 3. Local Changes der frischen Kopie

Die Zahlen gelten für eine frische Kopie der veröffentlichten „Supply Chain Performance", die du in Abschnitt 2 gerade angelegt hast und an der du noch nichts geändert hast.

- [ ] Tab „Local Changes" öffnen und den Ladefortschritt abwarten. Erwartet (laut Spike): 11 geänderte Sheets, 2 geänderte Dimensionen, 357 gelöschte Variablen, sonst nichts.
- [ ] „Remove files no longer maintained" ansehen. Erwartet: Die Option nennt 5 Dateien: `loadScript.qvs`, `objects/fields.json`, `objects/themes.json`, `objects/glossarylinks.json` und `builds/<id>.qvf`.
- [ ] Weicht eine Zahl ab, notiere sie und mache ein Bildschirmfoto.
- [ ] Nach dem Speichern in Abschnitt 4: Die beiden geänderten Dimensionen auf GitHub öffnen (Commit ansehen, Datei unter `objects/dimensions/`). Erwartet: Der Unterschied zum vorigen Stand ist nur, dass `qMeta` innerhalb von `_ColorMapModel` weggefallen ist. Jede andere Abweichung notieren.

## 4. Save changes mit allen Einträgen

- [ ] „Save changes" klicken, alle Einträge ausgewählt lassen, eine Commit-Nachricht eingeben und „Save" klicken. Erwartet: Ein neuer Commit liegt auf dem Branch, und das Panel zeigt „No local changes".
- [ ] Bei einer frischen Kopie wird kein Dialog „The branch has moved on" erwartet. Erscheint er trotzdem, notiere, welche Commits er auflistet (Wortlaut der Zeilen), und mache ein Bildschirmfoto.
- [ ] Seite neu laden, danach die Daten der App neu laden (Skript ausführen). Erwartet: Weiterhin „No local changes" (Erfolgskriterium 3).

## 5. Änderung in der App

- [ ] In der App ein Measure und einen Skript-Tab ändern (ohne zu veröffentlichen). Panel auf „Refresh". Erwartet: Genau diese zwei Einträge unter Local Changes.
- [ ] Nur das Measure auswählen und speichern. Erwartet: Commit enthält nur das Measure; der Skript-Tab bleibt weiterhin als Änderung stehen.

## 6. Neues Repo

- [ ] Eine kleine App ohne Repository öffnen. Erwartet: Das Panel bietet „Create repository" an.
- [ ] „Create repository" klicken. Erwartet auf GitHub: Das neue Repository ist privat und hat eine `README.md` mit Branch-Tabelle. Das Panel zeigt die App als verknüpft und danach „No local changes".
- [ ] Zweiter Durchlauf mit einer App in realer Größe (mehrere hundert Objekte, z. B. eine weitere Kopie von „Supply Chain Performance", vorher mit „Unlink repository" gelöst, oder eine andere große App ohne Repository): „Create repository" klicken. Erwartet: Auf GitHub genau ein Commit „Initial commit" mit allen Dateien, keine Meldung zum GitHub-Rate-Limit, danach „No local changes". Notiere die Dauer vom Klick bis „No local changes" (Sekunden). Meldet das Panel, dass es schon ein Repository mit dem Namen gibt, „Create as …" wählen. Das Test-Repository kannst du danach auf GitHub löschen.

## 7. Sonderfälle

- [ ] Die veröffentlichte „Supply Chain Performance" öffnen. Erwartet: Das Panel zeigt den Hinweis „Published app – read only. Duplicate the app to make changes.", im Kopf das Repository (und, wenn bekannt, den Branch), keine Schaltflächen „Save changes" oder „Unlink repository", und in der App wird nichts geschrieben. Ist der Commit bekannt, aus dem die App veröffentlicht wurde, steht darunter „Published from commit" mit den ersten 7 Zeichen des Commits (Link auf GitHub) und die Liste der lokalen Änderungen ohne Speichern.
- [ ] Hinweis: Eine veröffentlichte App ohne Repository zeigt „No linked repository" mit „Create repository" und „Connect to existing repository". Ein Klick darauf schreibt nichts und antwortet mit „Published apps are read only. Duplicate the app to make changes." – das ist erwartet.
- [ ] Eine frisch veröffentlichte App: Die in Abschnitt 4 gespeicherte Kopie in einen Test-Stream veröffentlichen, wie beim Spike („Test (Qommit)"), **nicht** über die echte „Supply Chain Performance" legen. Die veröffentlichte Test-App öffnen. Erwartet: der Hinweis „Published app – read only. Duplicate the app to make changes.", die Zeile „Published from commit" mit den ersten 7 Zeichen des zuletzt gespeicherten Commits und „No local changes".
- [ ] Den Token in den Optionen entfernen und das Panel aktualisieren. Erwartet: Ein Hinweis zum fehlenden Token mit der Schaltfläche „Open options". Token danach wieder eintragen.
- [ ] In Qlik abmelden (zweiter Tab) und im Panel „Refresh" klicken. Erwartet: Ein Hinweis zur Qlik-Sitzung, kein Absturz. Danach wieder anmelden.
- [ ] „Unlink repository" wählen. Erwartet: Das Panel zeigt „No linked repository", und das bleibt auch nach „Refresh" so.
- [ ] Eine zweite, unabhängige kleine App öffnen und sie mit „Connect to existing repository" → „To existing branch" an den Branch `main` des Repositories aus Abschnitt 6 hängen. Erwartet: Die App ist verknüpft; Local Changes zeigt die Unterschiede zwischen den beiden Apps; die Zeile von `main` in der Branch-Tabelle bleibt unverändert (sie nennt weiter die erste App). Nichts speichern, danach „Unlink repository".
- [ ] Dieselbe App mit „As a new branch" an dasselbe Repository hängen. Erwartet: neuer Branch auf GitHub, neue Zeile in der Branch-Tabelle. Danach „Unlink repository".

## 8. Rückmeldung

Bitte melde zurück:

- [ ] Wie lange das Laden der Local Changes gedauert hat (Sekunden, bei „Supply Chain Performance").
- [ ] Unerwartete Einträge unter Local Changes, mit Bildschirmfoto.
- [ ] Alle Fehlermeldungen im Wortlaut.
- [ ] Welche Schritte oben nicht wie erwartet liefen (Nummer und Abweichung).
