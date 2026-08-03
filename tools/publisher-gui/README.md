# Tysons Times Publisher Desk

The Publisher Desk is a local-only control panel for the collection, rewrite, preview, and publication pipeline. It binds to `127.0.0.1:4784`; it is not exposed to the network.

## Open it

Use the **Tysons Times Publisher Desk** shortcut on the Windows desktop, or run:

```powershell
npm run publisher
```

The desktop shortcut reuses an existing console process when one is already running.

## Supported flows

- scrape an explicit inclusive date range → rewrite staging
- scrape → rewrite → guarded direct deployment to `main`
- process selected existing `unprocessed-articles` → staging
- process selected existing `unprocessed-articles` → direct deployment
- deploy selected rewrite-stage articles
- resume selected prepared-but-uncommitted articles after an interrupted deployment
- build and launch the local site with both published and staged articles
- open the production site and copy/open paired local and production article links
- review every scrape run, including selected sites, date range, per-site limit, results, failures, storage, and compression savings

## Deployment safeguards

Direct deployment validates the feed, requires an empty Git index, requires local `main` to match `origin/main`, stages only the selected article directories, checks the staged patch, commits, pushes, watches the GitHub Pages workflow, and verifies every article ID in the live content feed. Unrelated worktree changes are not staged.

The production GitHub Actions workflow in `.github/workflows/deploy-pages.yml` runs on every push to `main`, validates and builds the content feed, deploys GitHub Pages, and verifies that the deployed index matches the pushed commit.
