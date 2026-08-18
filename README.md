# Slot Master v13.25

Figma plugin by Alexey Kylik for bulk synchronization, renaming, normalization, title fitting, sorting, and styling of casino and slot-game cards.

## Main features

- Synchronizes physical Figma cards with spreadsheet rows.
- Renames cards while keeping titles and identifiers linked to their source rows.
- Creates missing cards from a shared visual reference.
- Normalizes card dimensions and internal layout proportions.
- Fits titles into one to three rows using reference typography.
- Sorts cards and distributes local gradient styles.

See `README.txt` for the complete feature and version history.

## Installation

1. Clone or download this repository.
2. In Figma Desktop, open **Plugins → Development → Import plugin from manifest…**.
3. Select `manifest.json` from this directory.

## Development

The runtime source is plain JavaScript. `manifest.json` loads `code.js` and `ui.html` directly, so no compilation step is required.

Run the local validation before committing changes:

```sh
npm test
```

The check verifies JavaScript syntax, parses the manifest, and confirms that its runtime files exist. GitHub Actions runs the same check for pushes and pull requests.
