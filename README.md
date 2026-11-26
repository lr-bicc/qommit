# Qommit

Version control for Qlik Sense apps with GitHub. Qommit is a Chrome extension with a side panel on Qlik Sense pages. It commits an app to a GitHub repository, shows the history and diffs, updates the app to an earlier or newer version, sets tags, and imports apps.

## Install

Install Qommit from the Chrome Web Store. Then open the extension options and enter your GitHub token, your GitHub organization and your Qlik Sense server. Chrome asks you to allow access to that server.

## Develop

```
npm ci
npm test
npm run build:ext
```

`npm run build:ext` writes the extension to `dist/ext`. In Chrome, open `chrome://extensions`, turn on developer mode and load that folder. `npm run icons` regenerates the icons from `assets/icon.svg`.

To publish a version, see [docs/release.md](docs/release.md).

## Privacy

Qommit collects no data for its publisher. Read the [privacy policy](https://lr-bicc.github.io/qommit/).

## License

[MIT](LICENSE)
