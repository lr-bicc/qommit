# Design: Qommit für den Chrome Web Store vorbereiten (Release v1.0.0)

**Stand:** 2026-11-26 · **Bezug:** Spec `2026-11-10-qlik-github-versioning-design.md`, Abschnitt 10 („Verteilung: Chrome Web Store ‚nicht gelistet‘ oder Gruppenrichtlinie“)

## Absicht

Qommit läuft bisher als entpackte Extension im Entwicklermodus. Die erste produktive Version soll als **v1.0.0** erscheinen: als GitHub-Release unter dem Tag `v1.0.0` und im Chrome Web Store, und Chrome zeigt dann die Version 1.0.0. Dieses Vorhaben bereitet das Repo so vor, dass der Release später in wenigen Schritten geht. Hochladen und Store-Eintrag macht der Nutzer selbst im Developer Dashboard (eigenes Konto, Gebühr, Freigabe).

## Ziele

- Eigenes Icon (Entwurf A „Branch Q“) statt des grauen Platzhalters, in allen Größen, die Chrome und der Store brauchen.
- Öffentliche Datenschutzerklärung mit fester URL, wie der Store sie wegen des gespeicherten GitHub-Tokens verlangt.
- Release per Tag: Push von `v<version>` baut die Extension und legt das GitHub-Release mit dem Zip an.
- Alles, was der Nutzer im Store-Formular eintragen muss, liegt fertig im Repo.
- Das Repo ist bereit, öffentlich zu werden (README, Lizenz).

## Nicht-Ziele

- Kein automatisches Hochladen in den Store (bräuchte API-Zugangsdaten; später möglich).
- Keine Änderung am Verhalten der Extension.
- Kein Bereinigen der Git-Historie: Sie wird mit Testserver, Autor-E-Mail und internen Details öffentlich. Das ist bewusst entschieden.
- Version 1.0.0, Tag, Sichtbarkeit „öffentlich“ und GitHub Pages gehören **nicht** zu diesem Vorhaben, sondern zum Release selbst, jeweils erst nach Freigabe des Nutzers.

## Anti-Ziele

- Weder das Qlik-Logo noch das GitHub-Logo im Icon oder Store-Eintrag (Markenrecht, Store-Richtlinien).
- Keine internen Namen (Testserver, App-Namen, Benutzer) in Datenschutzerklärung, README oder Store-Texten.

## Randbedingungen

- Repo `lr-bicc/qommit` ist privat, die Org hat den kostenlosen GitHub-Plan: GitHub Pages geht erst, wenn das Repo öffentlich ist. Der Nutzer ist Org-Admin und darf die Sichtbarkeit ändern.
- GitHub Actions sind in der Org aktiv.
- Chrome-Versionen bestehen aus 1–4 Zahlen; jeder Upload in den Store braucht eine höhere Version als der vorige.

## Ansätze

| Teil | Erwogen | Gewählt (vom Nutzer) | Grund |
| --- | --- | --- | --- |
| Ort der Datenschutzerklärung | kleines öffentliches Repo; Firmen-Website; `gh-pages`-Branch in `qommit` | `gh-pages`-Branch in `qommit`, Repo wird öffentlich | ein Repo, wie `qe-api-client`; der Nutzer nimmt die öffentliche Historie in Kauf |
| Icon-Dateien | PNGs einmalig von Hand; SVG-Quelle + Skript | SVG-Quelle + Skript, PNGs eingecheckt | Icon bleibt änderbar |
| Release | lokales Skript mit `gh`; GitHub Actions | GitHub Actions bei Tag-Push | unabhängig vom Rechner, für öffentliche Repos unbegrenzt |
| Icon-Entwurf | A Branch Q, B Commit graph, C Diff Q | A | auch bei 16 px lesbar, hell und dunkel |

## Entwurf

1. **Icon.** `assets/icon.svg` ist die Quelle (Entwurf A: abgerundetes Quadrat `#0F6E56`, weißer Q-Ring, Schwanz endet in einem Commit-Punkt `#9FE1CB`). `assets/promo-small.svg` (440 × 280) zeigt Icon, „Qommit“ und den Untertitel „Version control for Qlik Sense apps with GitHub“. `npm run icons` (Skript `scripts/icons.mjs`, Dev-Abhängigkeit `@resvg/resvg-js`) erzeugt `src/ext/icons/icon-16.png`, `-32`, `-48`, `-128` und `store/promo-small-440x280.png`; die PNGs werden eingecheckt. Der Build kopiert `src/ext/icons/` nach `dist/ext/icons/`. Das Manifest bekommt `icons` (16/32/48/128), `action.default_icon` (16/32) und `homepage_url: https://github.com/lr-bicc/qommit`.
2. **Datenschutzerklärung.** Verwaiste Branch `gh-pages` mit `index.html` (eine Seite, Englisch), später unter `https://lr-bicc.github.io/qommit/`. Inhalt: Qommit sammelt keine Daten für den Herausgeber; GitHub-Token, Org und Serverliste liegen nur in `chrome.storage.local` im Browser; App-Inhalte gehen nur an die GitHub-API der eingestellten Org und an die eingestellten Qlik-Server; keine Analyse, keine Dritten, kein Verkauf; Entfernen der Extension löscht die Daten; Kontakt über die Issues des Repos. Die Quelle liegt zusätzlich auf `main` unter `site/index.html`, damit Änderungen per Pull Request laufen; die Release-Anleitung beschreibt, wie sie nach `gh-pages` kommt.
3. **Release-Workflow.** `.github/workflows/release.yml`, ausgelöst bei Push eines Tags `v*`: Checkout, Node einrichten, `npm ci`, Prüfung „Tag = `v` + Version im Manifest“ (sonst Abbruch), `npm run typecheck`, `npm test`, `npm run build:ext`, Zip `qommit-<version>.zip` mit `manifest.json` auf oberster Ebene, `gh release create <tag> <zip> --title <tag> --generate-notes`. Rechte: `contents: write`.
4. **Store-Unterlagen.** `store/listing.md`: Name, Kurzbeschreibung (≤ 132 Zeichen), ausführliche Beschreibung, Kategorie „Developer Tools“, Sprache, Sichtbarkeit „nicht gelistet“, Einzelzweck, Begründung je Berechtigung (`storage`, `scripting`, `sidePanel`, GitHub-Hosts, optionale `https://*/*`), „kein Remote-Code“, Angaben zur Datennutzung (Authentifizierungsdaten: GitHub-Token, nur lokal), Link zur Datenschutzerklärung, Hinweis auf die Screenshots (1280 × 800), die der Nutzer selbst aufnimmt.
5. **Release-Anleitung.** `docs/release.md`: Version im Manifest erhöhen (für v1.0.0: `1.0.0`), PR mergen, Tag setzen und pushen, Workflow abwarten, Zip im Store hochladen; einmalig vor v1.0.0: Repo öffentlich schalten, Pages auf `gh-pages` einstellen, URL prüfen. Umstieg der Nutzer: entpackte Version entfernen, Store-Version installieren, Token und Server neu eintragen (andere Extension-ID).
6. **Öffentliche Dateien.** `README.md` (was Qommit tut, Installation aus dem Store, Entwicklung: `npm ci`, `npm test`, `npm run build:ext`, Link zur Datenschutzerklärung) und `LICENSE` (MIT).

## Offen (Nutzer)

- Inhaber im MIT-Copyright-Vermerk (Firma mit genauem Namen oder Person).

## Dem Umsetzer überlassen

- Genaue Formen im SVG innerhalb des Entwurfs A, Wortlaut der Texte, Node-Version im Workflow, Tests für Build (Icons im Zip, Manifest-Felder) und für die Prüfung Tag gegen Version.
