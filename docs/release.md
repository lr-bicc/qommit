# Releasing Qommit

## Each release

1. Raise `version` in `src/ext/manifest.json` (for v1.0.0: `1.0.0`). It has 1 to 4 integers, and each store upload needs a higher version than the last.
2. Open a pull request and merge it into `main`.
3. Tag the merge commit and push the tag:
   ```
   git checkout main
   git pull
   git tag v1.0.0
   git push origin v1.0.0
   ```
   The tag must be `v` plus the manifest version, or the workflow stops.
4. Wait for the release workflow in GitHub Actions. It runs the checks, builds the extension and creates the GitHub release with `qommit-<version>.zip`.
5. Download the zip from the release and upload it in the Chrome Web Store Developer Dashboard. Enter the texts from `store/listing.md` and submit.

## Once, before v1.0.0

1. Make the repository public: Settings, General, Danger Zone, Change visibility. The full history becomes public.
2. Put the privacy page on the `gh-pages` branch (see below).
3. Turn on GitHub Pages: Settings, Pages, Source "Deploy from a branch", branch `gh-pages`, folder `/ (root)`.
4. Open https://lr-bicc.github.io/qommit/ and check that the page loads.

## The privacy page on gh-pages

The source is `site/index.html` on `main`, so changes go through a pull request. The `gh-pages` branch holds only `index.html`. After a change is merged, copy the file over.

First time (orphan branch in a temporary worktree):

```
git worktree add --detach ../qommit-pages main
cd ../qommit-pages
git checkout --orphan gh-pages
git rm -rf .
git checkout main -- site/index.html
git mv site/index.html index.html
git commit -m "Privacy page"
git push origin gh-pages
cd -
git worktree remove --force ../qommit-pages
```

Later changes:

```
git worktree add ../qommit-pages gh-pages
cd ../qommit-pages
git checkout main -- site/index.html
git mv -f site/index.html index.html
git commit -am "Update privacy page"
git push origin gh-pages
cd -
git worktree remove ../qommit-pages
```

## Switching from the unpacked version

The store version has another extension id, so it does not share settings with an unpacked install. Users remove the unpacked version, install the store version, and enter their token and servers again.
