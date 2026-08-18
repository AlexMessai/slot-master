Slot Master v13.25
by Alexey Kylik

Slot Master is a Figma plugin for bulk work with casino / slot game cards.

MAIN FEATURES

1. Rename
- Maps spreadsheet rows to physical Figma cards.
- Uses Title + Identifier + existing card content.
- Every table row remains a separate row occurrence.
- Repeated Identifiers are supported.
- Reports Missing, Extra, Duplicate, Skipped, and shared-Identifier groups.

2. Full Sync
- Reconciles existing Figma cards with spreadsheet rows before suggesting any creation.
- Matching order includes current Identifier, provider aliases, exact visible Title, and controlled fuzzy matching.
- Duplicate creation is suggested only when reconciliation proves that a repeated-Identifier row still lacks its own physical card.
- Raw Figma/Table count difference is diagnostic only.

3. Missing duplicate creation
- Creates a physical duplicate only for a genuinely unresolved repeated-Identifier row.
- After duplication, only newly created cards are selected.
- The full sync scope is kept internally so reports remain accurate.

4. Normalize
- Uses a reference card.
- Scales the whole card proportionally.
- Preserves internal layout proportions, artwork, text, effects, strokes, radii, spacing, and offsets.

5. Title Fit
- Automatic 1–3 row title composition.
- Independent font sizing per row.
- Reference-based typography.
- CAP_HEIGHT leading trim.
- Optimized for large batches.

6. Styles
- Random gradient distribution from local Paint Styles.
- Auto Gradient by Banner Color.

7. Sorting
- Alphabetical order.
- Spreadsheet order.
- Grid/chunk arrangement controls.

TABLE PRINCIPLE

The spreadsheet is trusted as the source of truth.

Title and Identifier are independent values from the same row.
The plugin does not “correct” differences between numbers in Title and Identifier.

Example:
4 Glittery Diamonds -> mgg_3glitterydiamonds

This is valid if it is exactly what the spreadsheet contains.

REPEATED IDENTIFIERS

Example:
Game 10 -> mgg_game
Game 20 -> mgg_game

These are two different table rows and may require two physical cards.
Slot Master first tries to assign all existing cards correctly by visible Title.
Only after reconciliation can it suggest creating a missing duplicate.

LANGUAGE

UI languages:
- English — by Alexey Kylik
- Русский — by Alexey Kylik

BRANDING

Plugin name: Slot Master
Avatar: SM icon supplied by the author.

INSTALLATION

For a local development plugin:
1. Keep code.js, ui.html, and slot-master-icon.png together with your existing plugin manifest.
2. In Figma Desktop, open Plugins -> Development -> Import plugin from manifest.
3. Select the manifest used by your Slot Master project.

Important:
This package preserves the existing plugin runtime files and does not replace your manifest automatically.

VERSION

v13.1
- Slot Master branding finalized.
- Added user-provided SM avatar to the header.
- Localized author credit:
  by Alexey Kylik
- Refined header spacing and hierarchy.
- Rewrote README for a shareable/community-ready package.
- Preserved all v12.8 synchronization and clone-selection behavior.


8. Create cards from table
- Select exactly one reference banner/card.
- Slot Master creates one new physical card for EVERY parsed table row.
- The reference card itself is not counted.
- The full visual/content structure of the reference is cloned.
- Outer frame name is set from the row Identifier.
- Visible title is rebuilt from the Title belonging to the same row.
- Repeated Identifiers are NOT deduplicated: every row still creates its own card.
- The title style, effects and position are derived automatically from the reference.
- Current Title Fit padding/gap/min/max settings are reused.
- On free canvas the generated cards are arranged in a configurable grid.
- In Auto Layout parents the parent controls placement.
- After generation only the newly created cards are selected.

v13.2
- Added Create cards from table generator.
- One reference -> N table rows -> N physical cards.
- Automatic Identifier + linked Title assignment.
- Preserves full reference-card content.
- Supports repeated Identifiers as separate rows/cards.


v13.3 — Shared Visual Reference

One shared reference is now used by:
- Create from table
- Normalize
- Title Fit

Set it once from any selected card or one of its title layers.
Slot Master resolves the parent card and renders a real PNG preview in the UI.

The preview shows:
- the actual reference artwork/card
- detected title
- outer frame name
- card size
- title row count
- Title Fit readiness

Create from table no longer depends on the current selection after the reference is set.
Normalize and Title Fit update/use the same shared reference rather than separate internal references.


v13.4 — Reference UI cleanup

Reference controls were simplified.

There is still one shared reference internally, but the visual reference card is shown only in:
- Normalize
- Title Fit

Removed:
- shared reference card from Rename
- duplicate reference section inside Normalize
- duplicate reference/template section inside Title Fit

Create from table remains self-contained:
- if a shared reference already exists, it is used
- otherwise the single selected card is automatically adopted as the reference when generation starts

This keeps the “one reference” behavior without showing the same function several times.


v13.5 — UI recovery fix
- Fixed a UI initialization crash introduced by the v13.4 reference cleanup.
- Removed stale JavaScript references to deleted Normalize reference labels.
- Embedded the Slot Master avatar directly into ui.html, so it renders reliably in Figma.
- Removed the custom Close button; Figma's native window close control is used.
- Preserved the v13.4 reference behavior:
  - no reference on Rename
  - one shared visual reference for Normalize / Title Fit
  - Create can adopt a single selected reference automatically


v13.6
- Increased tab label font size for better readability.
- Kept tab height and overall layout unchanged.


v13.7
- Selection / Table counters are now shown only on the Rename tab.
- Normalize, Title Fit, Styles and Reports no longer display that global status row.


v13.9
- Removed the visible Hint / Подсказка dropdowns from Styles.
- Added compact info icons directly to the right of:
  - Random Gradients
  - Auto Gradient by Banner Color
- Hover or keyboard-focus the icon to see the localized explanation tooltip.


v13.10
- Normalize Apply is disabled until a shared reference is selected.
- Title Fit Preview and Apply are disabled until a shared reference is selected.
- Added a compact × button in the top-right corner of the visual reference card.
- Clearing the reference also clears the stored Title Fit template and returns all reference-dependent controls to the disabled state.


v13.11
- Moved the shared-reference clear × into the top-right corner of the visual preview image.
- The button now overlays the preview instead of occupying the outer card corner.


v13.12
- Sorting was moved out of Rename into its own dedicated Sort tab.
- All existing sort settings and behavior are preserved:
  - table / alphabetical order
  - columns and rows per chunk
  - card gap
  - chunk gap
  - chunks per row


v13.13
- All six navigation tabs now stay on one horizontal row.
- Renamed “Missing / Skipped” tab to “Report”.


v13.14
- Sort action button is aligned to the left.
- Added a monochrome magic-wand icon to Auto Gradient by Banner Color.


v13.15
- Removed the redundant status line under the shared reference.
- The reference card now shows only useful information: title, identifier/frame name, dimensions and row count.


v13.25
- Auto Gradient magic-wand icon now uses the same visual language as the tool badges: black circular background with a white icon.


v13.25
- Sort tab moved to the penultimate position in the top navigation.


v13.25
- Title Fit preview now shows image thumbnails in the preview list.


v13.25
- Normalize: removed the title-selection button from the UI, moved Apply under advanced settings, and changed the section heading to Settings with a gear icon.


v13.25
- Normalize horizontal centering now centers the title in the frame that directly contains it.
- It no longer copies the reference card's horizontal X offset.
- Text layers also receive centered paragraph alignment, and canonical title Auto Layout uses centered cross-axis alignment.


v13.25 — Performance Optimization
- Faster Rename: cached table indexes, no per-card table rebuilding, direct selected-node renaming, batched yielding.
- Faster matching: semantic Identifier/title payload index and precomputed legacy fallback keys.
- Faster Normalize/Title Fit: shared row-context cache, compact result payloads, batched progress updates.
- Full Sync exact passes now use card/title indexes instead of repeatedly filtering the full table/selection.
- Title Fit preview renders only the first 5 resolved cards and builds each preview once.
- Preview PNGs reduced to 144px source width for faster cross-system rendering.
- Added Title Fit layout cache for repeated titles/settings.
- Cleaned duplicate RU translations and restored missing EN Styles translations.
- Shortened RU/EN helper copy for clearer UI.
- Generator progress is throttled on large tables and uses adaptive batch yields to reduce UI overhead.


v13.25 — Create Missing from Full Sync
- The “Truly missing from Figma” section can now create any missing table row, not only repeated-Identifier duplicates.
- The base/reference is the LAST selected banner from the Full Sync selection and stays stable while Missing cards are created.
- Created cards receive the exact table Identifier as the outer frame name and the exact table Title as visible title content.
- Bulk “Create all Missing” and per-row “Create card” actions are available.
- Generator grid / gap and current Title Fit settings are reused for creation.
- Only newly created cards are selected after creation.


v13.25 — Selection & Language reliability
- Selection-dependent actions are disabled until the required Figma frames/layers are selected.
- Sort requires at least 2 selected frames.
- Normalize / Title Fit require both a shared reference and a non-empty selection.
- Selection state updates live through Figma selectionchange events.
- Fixed RU/EN race: a late settings load can no longer switch the language back after the user presses RU/EN.
- LocalStorage language preference now has priority over stale clientStorage settings.
- Added Sort to persisted tab restoration.
- Cleaned remaining English-mode Cyrillic copy and localized dynamic Rows/Chunks/Gap status labels.


v13.25
- Removed the manual Refresh selection button. Selection state is updated automatically from Figma.
