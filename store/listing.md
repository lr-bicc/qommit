# Chrome Web Store listing

Values to enter in the Developer Dashboard. The screenshots (1280 x 800) are in `store/screenshots/`; the small promo tile is `store/promo-small-440x280.png`.

## Store listing

**Name:** Qommit

**Short description:** Version control for Qlik Sense apps with GitHub.

**Category:** Developer Tools

**Language:** English

**Visibility:** Unlisted

**Privacy policy URL:** https://lr-bicc.github.io/qommit/

**Detailed description:**

Qommit brings version control to Qlik Sense apps. A side panel on your Qlik Sense pages lets you:

- commit an app to a GitHub repository,
- browse the history and compare two versions in a diff,
- update the app to another version,
- set tags,
- import apps.

You need a GitHub token and a GitHub organization. Qommit stores them only in your browser and sends app content only to GitHub and to your own Qlik Sense servers. It has no server of its own and no analytics.

## Privacy practices

**Single purpose:** Version control for Qlik Sense apps: save an app to GitHub, show its history and differences, and restore a version.

**Permission justifications:**

- `storage`: keeps the GitHub token, the organization, the server list and the app-to-repository links in the browser.
- `scripting`: injects the Qommit content script into a Qlik Sense page, which reads and updates the app of that tab.
- `sidePanel`: shows the Qommit panel beside the Qlik Sense page.
- Host permission `https://api.github.com/*`: reads and writes the repositories of the configured organization.
- Host permission `https://codeload.github.com/*`: GitHub redirects repository downloads (snapshots of a version) to this host.
- Optional host permission `https://*/*`: requested per Qlik Sense server, only for servers the user adds in the options. Qlik Sense servers have no common address, so the host cannot be fixed in advance.

**Remote code:** No. All code is in the extension package. Qommit loads and runs no code from a server.

**Data usage:**

- Data type collected: Authentication information (the GitHub token).
- Data type collected: Website content (the content of the user's Qlik Sense apps: scripts, sheets and objects). It is sent only to the GitHub organization the user configured, to store versions there.
- The token is stored only locally in the browser (`chrome.storage.local`) and sent only to GitHub.
- Not collected: personal communications, health, financial, location, web history, user activity.
- Certifications: the data is not sold, not used for unrelated purposes, and not used for creditworthiness or lending.

## Screenshots

Upload these four, in this order (each 1280 x 800):

1. `store/screenshots/1-history.png`: the History tab with commits and tags.
2. `store/screenshots/2-diff.png`: the diff of the local changes over the page.
3. `store/screenshots/3-commit.png`: choosing what to save, with a commit message.
4. `store/screenshots/4-update.png`: updating the app to an earlier commit.

They show the real side panel with demo data: the app "Sales Overview", the repository `acme-analytics/sales-overview` and the server `qlik.example.com`. New screenshots must not show real server names or app names either.
