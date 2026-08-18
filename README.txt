Slot Master v1.0
by Alexey Kylik

Slot Master is a Figma plugin for bulk work with casino and slot-game cards.

MAIN FEATURES

1. Rename
- Maps spreadsheet rows to physical Figma cards.
- Uses Title, Identifier, and existing card content.
- Keeps every table row as a separate occurrence.
- Supports repeated Identifiers.
- Reports Missing, Extra, Duplicate, Skipped, and shared-Identifier groups.

2. Full Sync
- Reconciles existing Figma cards with spreadsheet rows before suggesting creation.
- Matches current Identifiers, provider aliases, exact visible Titles, and controlled fuzzy alternatives.
- Uses the spreadsheet as the source of truth.
- Can create individual missing cards or all missing cards from the reconciliation report.

3. Create cards from table
- Creates one physical card for every parsed table row from a reference card.
- Preserves the reference structure, artwork, and content.
- Sets the outer frame name from the row Identifier.
- Rebuilds the visible title from the linked row Title.
- Keeps repeated Identifiers as separate physical cards.
- Arranges generated cards in a configurable grid on the free canvas.

4. Normalize
- Uses a shared visual reference card.
- Scales the whole card proportionally.
- Preserves artwork, text, effects, strokes, radii, spacing, and offsets.
- Supports centered title alignment within its direct parent frame.

5. Title Fit
- Builds titles in one to three rows.
- Supports independent font sizing per row.
- Uses reference-based typography and CAP_HEIGHT leading trim.
- Includes visual previews and optimized large-batch processing.

6. Styles
- Distributes random gradients from local Paint Styles.
- Supports Auto Gradient by Banner Color.

7. Sorting
- Sorts alphabetically or by spreadsheet order.
- Supports grid and chunk arrangement controls.

SHARED VISUAL REFERENCE

Create from table, Normalize, and Title Fit use one shared reference.
Select a card or one of its title layers to set it. Slot Master resolves the parent card and shows a preview with its artwork, title, frame name, dimensions, and title row count.

TABLE PRINCIPLE

Title and Identifier are independent values from the same spreadsheet row. Slot Master does not correct differences between numbers or wording in those fields.

Example:
4 Glittery Diamonds -> mgg_3glitterydiamonds

Repeated Identifiers remain separate rows and may require separate physical cards.

LANGUAGE

UI languages:
- English
- Русский

INSTALLATION

1. Keep manifest.json, code.js, ui.html, and slot-master-icon.png in the same project folder.
2. In Figma Desktop, open Plugins -> Development -> Import plugin from manifest.
3. Select manifest.json from the Slot Master folder.

DEVELOPMENT

The plugin runs directly from code.js and ui.html without a compilation step.
Run npm test to validate JavaScript syntax, manifest fields, and runtime entry points.
