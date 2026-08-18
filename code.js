figma.showUI(__html__, { width: 720, height: 840, themeColors: true });

let normalizeReferenceId = null;
let sharedReferenceId = null;
let titleFitTemplate = null;
const TITLE_FIT_TEMPLATE_KEY = "gir-titlefit-template-v1";

function strictNormalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

function looseNormalize(value) {
  return strictNormalize(value)
    .replace(/[’'`]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9а-яё]+/gi, "");
}

function getTextNodes(root) {
  const out = [];
  function walk(node) {
    if (node.type === "TEXT") {
      out.push(node);
      return;
    }
    if ("children" in node) {
      for (const child of node.children) walk(child);
    }
  }
  walk(root);
  return out;
}

function buildIndexes(rows) {
  const strict = new Map();
  const loose = new Map();
  const semantic = new Map();
  const legacyEntries = [];

  function add(map, key, row) {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }

  for (const row of rows) {
    const strictKey = strictNormalize(row.title);
    const looseKey = looseNormalize(row.title);

    add(strict, strictKey, row);
    add(loose, looseKey, row);

    const semanticKeys = new Set(
      identifierPayloadKeys(row.identifier)
    );

    if (looseKey && looseKey.length >= 4) {
      semanticKeys.add(looseKey);
    }

    for (const key of semanticKeys) {
      add(semantic, key, row);
      legacyEntries.push({ key, row });
    }
  }

  return {
    strict,
    loose,
    semantic,
    legacyEntries,
    rows
  };
}

const girRowContextCache = new WeakMap();

function getRowContext(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];

  if (Array.isArray(rows)) {
    const cached = girRowContextCache.get(rows);
    if (cached) return cached;
  }

  const indexes = buildIndexes(safeRows);
  const firstByIdentifier = new Map();
  const rowsByIdentifier = new Map();
  const strictTitleRows = new Map();
  const identifierSet = new Set();

  for (const row of safeRows) {
    const identifier = String(row.identifier || '').trim();
    const titleKey = strictNormalize(row.title);

    if (identifier) {
      identifierSet.add(identifier);

      if (!firstByIdentifier.has(identifier)) {
        firstByIdentifier.set(identifier, row);
      }

      if (!rowsByIdentifier.has(identifier)) {
        rowsByIdentifier.set(identifier, []);
      }
      rowsByIdentifier.get(identifier).push(row);
    }

    if (titleKey) {
      if (!strictTitleRows.has(titleKey)) {
        strictTitleRows.set(titleKey, []);
      }
      strictTitleRows.get(titleKey).push(row);
    }
  }

  const context = {
    rows: safeRows,
    indexes,
    firstByIdentifier,
    rowsByIdentifier,
    strictTitleRows,
    identifierSet
  };

  if (Array.isArray(rows)) {
    girRowContextCache.set(rows, context);
  }

  return context;
}

function uniqueRow(index, key) {
  const rows = index.get(key) || [];
  if (rows.length === 1) return { row: rows[0], ambiguous: false };

  if (rows.length > 1) {
    // Repeated spreadsheet rows with the SAME Identifier are intentional
    // physical cards, not an ambiguous title. Row-occurrence accounting is
    // handled later by analyze()/Full Sync.
    const identifiers = new Set(
      rows.map(row => String(row.identifier || '').trim())
    );

    if (identifiers.size === 1) {
      return { row: rows[0], ambiguous: false };
    }

    return { row: null, ambiguous: true };
  }

  return { row: null, ambiguous: false };
}

function dedupeMatches(matches) {
  const byIdentifier = new Map();
  for (const m of matches) byIdentifier.set(m.row.identifier, m);
  return [...byIdentifier.values()];
}


function identifierPayloadKeys(identifier) {
  const raw = String(identifier || "").trim();
  const keys = new Set();

  const add = value => {
    const normalized = looseNormalize(value);
    if (normalized && normalized.length >= 4) keys.add(normalized);
  };

  add(raw);

  // New formats such as provider:GameName or provider/GameName.
  for (const separator of [":", "/", "\\", "|"]) {
    if (raw.includes(separator)) {
      const parts = raw.split(separator).filter(Boolean);
      if (parts.length) add(parts[parts.length - 1]);
    }
  }

  return [...keys];
}

function frameIdentifierPayloadKeys(frameName) {
  const raw = String(frameName || "").trim();
  const keys = new Set();

  const add = value => {
    const normalized = looseNormalize(value);
    if (normalized && normalized.length >= 4) {
      keys.add(normalized);
    }
  };

  add(raw);

  // Provider migrations very often keep the semantic game name after the
  // namespace separator while only changing the provider namespace.
  //
  // Example:
  // softswiss_softswiss:JuicyspinsBar
  // bgmng:JuicySpinsBar
  //
  // Both produce the payload key "juicyspinsbar".
  const separators = [":", "/", "\\", "|"];

  for (const separator of separators) {
    if (!raw.includes(separator)) continue;

    const parts = raw
      .split(separator)
      .map(part => part.trim())
      .filter(Boolean);

    if (parts.length) {
      add(parts[parts.length - 1]);
    }
  }

  return [...keys];
}

function matchByFrameIdentifierPayload(card, indexesOrRows) {
  const frameKeys = frameIdentifierPayloadKeys(
    card && card.name
  );

  if (!frameKeys.length) {
    return {
      row: null,
      ambiguous: false
    };
  }

  const indexes =
    indexesOrRows && indexesOrRows.semantic
      ? indexesOrRows
      : buildIndexes(Array.isArray(indexesOrRows) ? indexesOrRows : []);

  const matches = [];

  for (const frameKey of frameKeys) {
    const candidates = indexes.semantic.get(frameKey) || [];
    matches.push(...candidates);
  }

  const uniqueByIdentifier = new Map();

  for (const row of matches) {
    uniqueByIdentifier.set(
      String(row.identifier || '').trim(),
      row
    );
  }

  const unique = [...uniqueByIdentifier.values()];

  if (unique.length === 1) {
    return {
      row: unique[0],
      ambiguous: false
    };
  }

  return {
    row: null,
    ambiguous: unique.length > 1
  };
}

function matchByLegacyFrameName(card, indexesOrRows) {
  const frameKey = looseNormalize(card && card.name);

  if (!frameKey || frameKey.length < 5) {
    return { row: null, ambiguous: false };
  }

  const indexes =
    indexesOrRows && indexesOrRows.legacyEntries
      ? indexesOrRows
      : buildIndexes(Array.isArray(indexesOrRows) ? indexesOrRows : []);

  const matches = [];

  for (const entry of indexes.legacyEntries) {
    const key = entry.key;

    if (
      key.length >= 4 &&
      (
        frameKey.endsWith(key) ||
        key.endsWith(frameKey)
      )
    ) {
      matches.push(entry.row);
    }
  }

  const uniqueByIdentifier = new Map();

  for (const row of matches) {
    uniqueByIdentifier.set(
      String(row.identifier || '').trim(),
      row
    );
  }

  const unique = [...uniqueByIdentifier.values()];

  if (unique.length === 1) {
    return {
      row: unique[0],
      ambiguous: false
    };
  }

  return {
    row: null,
    ambiguous: unique.length > 1
  };
}

function matchCard(card, indexes, rowsByIdentifier) {
  // 0) If this frame is already named exactly like an identifier from the table,
  // treat it as present. This prevents already-renamed frames from being reported as Missing.
  const existing = rowsByIdentifier.get(String(card.name).trim());
  if (existing) {
    return {
      status: "matched",
      row: existing,
      text: { characters: "(matched by existing frame name)" },
      mode: "frame-name"
    };
  }

  // Provider migration: match the semantic payload of the OLD frame identifier
  // directly against the NEW identifier/title before reading visible text.
  //
  // Example:
  // softswiss_softswiss:JuicyspinsBar
  // -> bgmng:JuicySpinsBar
  const payloadMatch = matchByFrameIdentifierPayload(
    card,
    indexes
  );

  if (payloadMatch.row) {
    return {
      status: "matched",
      row: payloadMatch.row,
      text: {
        characters: "(matched by identifier payload)"
      },
      mode: "identifier-payload"
    };
  }

  if (payloadMatch.ambiguous) {
    return {
      status: "skipped",
      reason:
        "Old frame identifier payload matches more than one table row, so it was not renamed automatically."
    };
  }

  const texts = getTextNodes(card);

  // Build candidate strings from individual text nodes AND adjacent node combinations.
  // This catches titles split into separate text layers, e.g. "AUTO" + "ROULETTE".
  const candidates = [];

  const addCandidate = characters => {
    const value = String(characters || '').trim();
    if (!value) return;

    candidates.push({
      characters: value,
      strictKey: strictNormalize(value),
      looseKey: looseNormalize(value)
    });
  };

  for (let i = 0; i < texts.length; i++) {
    const base = String(texts[i].characters || '').trim();
    if (base) addCandidate(base);

    let joined = base;
    for (let j = i + 1; j < Math.min(texts.length, i + 4); j++) {
      const next = String(texts[j].characters || '').trim();
      if (!next) continue;
      joined = joined ? `${joined} ${next}` : next;
      addCandidate(joined);
    }
  }

  const strictMatches = [];
  for (const t of candidates) {
    const result = uniqueRow(indexes.strict, t.strictKey);
    if (result.ambiguous) {
      return { status: "skipped", reason: `Duplicate title in table for "${t.characters}"` };
    }
    if (result.row) strictMatches.push({ row: result.row, text: t });
  }

  const strictUnique = dedupeMatches(strictMatches);
  if (strictUnique.length === 1) return { status: "matched", ...strictUnique[0], mode: "strict" };
  if (strictUnique.length > 1) {
    return {
      status: "skipped",
      reason: `Several titles matched inside this frame: ${strictUnique.map(x => `"${x.text.characters}"`).join(", ")}`
    };
  }

  const looseMatches = [];
  for (const t of candidates) {
    const result = uniqueRow(indexes.loose, t.looseKey);
    if (result.ambiguous) {
      return { status: "skipped", reason: `Ambiguous fallback match for "${t.characters}"` };
    }
    if (result.row) looseMatches.push({ row: result.row, text: t });
  }

  const looseUnique = dedupeMatches(looseMatches);
  if (looseUnique.length === 1) return { status: "matched", ...looseUnique[0], mode: "loose" };
  if (looseUnique.length > 1) {
    return {
      status: "skipped",
      reason: `Several possible titles matched inside this frame: ${looseUnique.map(x => `"${x.text.characters}"`).join(", ")}`
    };
  }

  // Provider-migration fallback.
  // If the visible title differs slightly or is structured unusually, use the
  // OLD frame name as an additional safe signal. This does not depend on the
  // provider prefix or identifier syntax.
  const legacyNameMatch = matchByLegacyFrameName(
    card,
    indexes
  );

  if (legacyNameMatch.row) {
    return {
      status: "matched",
      row: legacyNameMatch.row,
      text: {
        characters: "(matched by old frame-name suffix)"
      },
      mode: "legacy-frame-name"
    };
  }

  if (legacyNameMatch.ambiguous) {
    return {
      status: "skipped",
      reason:
        "Old frame name matches more than one table row, so the plugin did not rename it automatically."
    };
  }

  return {
    status: "extra",
    reason: "This banner exists in Figma but no matching game was found in the table."
  };
}


const SYNC_ALIAS_KEY = "gir-sync-aliases-v1";
const SYNC_AUTO_THRESHOLD = 95;
const SYNC_REVIEW_THRESHOLD = 75;

let fullSyncSession = null;
let fullSyncSessionSeq = 0;

async function loadSyncAliases() {
  try {
    const value = await figma.clientStorage.getAsync(SYNC_ALIAS_KEY);

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      return value;
    }
  } catch (e) {}

  return {};
}

async function saveSyncAliases(aliases) {
  await figma.clientStorage.setAsync(
    SYNC_ALIAS_KEY,
    aliases && typeof aliases === "object"
      ? aliases
      : {}
  );
}

function syncNormalizeWords(value) {
  return strictNormalize(value)
    .replace(/&/g, " and ")
    .replace(/\bchapter\b/g, " ch ")
    .replace(/\bchap\b/g, " ch ")
    .replace(/\bvolume\b/g, " vol ")
    .replace(/\bversus\b/g, " vs ")
    .replace(/\s+/g, " ")
    .trim();
}

function syncCompact(value) {
  return syncNormalizeWords(value)
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9а-яё]+/gi, "");
}

function syncTokens(value) {
  return syncNormalizeWords(value)
    .split(/[^a-z0-9а-яё]+/gi)
    .map(token => token.trim())
    .filter(Boolean);
}

function syncNumbers(value) {
  return (
    String(value || "")
      .match(/\d+(?:[.,]\d+)?/g) || []
  )
    .map(value => value.replace(",", "."))
    .sort();
}

function syncSameArray(a, b) {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }

  return true;
}

function syncBigramCounts(value) {
  const text = String(value || "");
  const counts = new Map();

  if (text.length < 2) {
    if (text) counts.set(text, 1);
    return counts;
  }

  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }

  return counts;
}

function syncDiceFromCounts(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;

  let overlap = 0;
  let countA = 0;
  let countB = 0;

  for (const value of a.values()) countA += value;
  for (const value of b.values()) countB += value;

  for (const [gram, count] of a.entries()) {
    overlap += Math.min(
      count,
      b.get(gram) || 0
    );
  }

  return (2 * overlap) / Math.max(1, countA + countB);
}

function syncJaccard(tokensA, tokensB) {
  const a = new Set(tokensA);
  const b = new Set(tokensB);

  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;

  let intersection = 0;

  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = new Set([...a, ...b]).size;

  return intersection / Math.max(1, union);
}

function makeSyncTextFeature(text, sourceType = "text") {
  const raw = String(text || "").trim();
  const compact = syncCompact(raw);
  const tokens = syncTokens(raw);

  return {
    raw,
    sourceType,
    compact,
    tokens,
    numbers: syncNumbers(raw),
    bigrams: syncBigramCounts(compact)
  };
}

function syncTextSimilarity(a, b) {
  if (!a || !b || !a.compact || !b.compact) return 0;

  if (a.compact === b.compact) return 100;

  const dice = syncDiceFromCounts(
    a.bigrams,
    b.bigrams
  );

  const tokenScore = syncJaccard(
    a.tokens,
    b.tokens
  );

  const minLength = Math.min(
    a.compact.length,
    b.compact.length
  );

  const maxLength = Math.max(
    a.compact.length,
    b.compact.length
  );

  const lengthRatio =
    maxLength > 0
      ? minLength / maxLength
      : 0;

  const contains =
    minLength >= 5 &&
    (
      a.compact.includes(b.compact) ||
      b.compact.includes(a.compact)
    );

  let score =
    dice * 72 +
    tokenScore * 18 +
    lengthRatio * 10;

  if (contains && lengthRatio >= 0.72) {
    score = Math.max(
      score,
      82 + lengthRatio * 13
    );
  }

  const numbersA = a.numbers;
  const numbersB = b.numbers;

  if (numbersA.length || numbersB.length) {
    if (
      numbersA.length &&
      numbersB.length &&
      !syncSameArray(numbersA, numbersB)
    ) {
      // Different numbers are a very strong signal that these are NOT
      // the same game: Fire Joker != Fire Joker 100.
      score = Math.min(score, 48);
    } else if (
      numbersA.length !== numbersB.length
    ) {
      score = Math.min(score, 72);
    }
  }

  return Math.max(
    0,
    Math.min(100, score)
  );
}

function syncCardTextValues(card) {
  const values = [];
  const seen = new Set();

  const add = (value, sourceType) => {
    const text = String(value || "").trim();
    const key = `${sourceType}\u0000${text}`;

    if (
      !text ||
      text.length < 2 ||
      seen.has(key)
    ) {
      return;
    }

    seen.add(key);
    values.push({
      text,
      sourceType
    });
  };

  add(card.name, "frame-name");

  const rawName = String(card.name || "");

  for (const separator of [":", "/", "\\", "|"]) {
    if (!rawName.includes(separator)) continue;

    const parts = rawName
      .split(separator)
      .map(part => part.trim())
      .filter(Boolean);

    if (parts.length) {
      add(
        parts[parts.length - 1],
        "frame-payload"
      );
    }
  }

  const texts = getTextNodes(card);

  for (let i = 0; i < texts.length; i++) {
    const base = String(
      texts[i].characters || ""
    ).trim();

    if (base) {
      add(base, "visible-text");
    }

    let joined = base;

    for (
      let j = i + 1;
      j < Math.min(texts.length, i + 5);
      j++
    ) {
      const next = String(
        texts[j].characters || ""
      ).trim();

      if (!next) continue;

      joined = joined
        ? `${joined} ${next}`
        : next;

      add(
        joined,
        "visible-combined"
      );
    }
  }

  return values;
}

function buildSyncCardDescriptor(card) {
  const values = syncCardTextValues(card);

  return {
    card,
    nodeId: card.id,
    frameName: card.name,
    values,
    features: values.map(item =>
      makeSyncTextFeature(
        item.text,
        item.sourceType
      )
    )
  };
}

function syncRowCandidateValues(row) {
  const values = [
    {
      text: row.title,
      sourceType: "table-title"
    }
  ];

  const rawIdentifier = String(
    row.identifier || ""
  ).trim();

  if (rawIdentifier) {
    for (const separator of [":", "/", "\\", "|"]) {
      if (!rawIdentifier.includes(separator)) continue;

      const parts = rawIdentifier
        .split(separator)
        .map(part => part.trim())
        .filter(Boolean);

      if (parts.length) {
        values.push({
          text: parts[parts.length - 1],
          sourceType: "identifier-payload"
        });
      }
    }
  }

  return values;
}

function buildSyncRowDescriptor(row) {
  const values = syncRowCandidateValues(row);

  return {
    row,
    identifier: String(row.identifier || "").trim(),
    title: String(row.title || "").trim(),
    features: values.map(item =>
      makeSyncTextFeature(
        item.text,
        item.sourceType
      )
    )
  };
}

function scoreSyncCardToRow(cardDescriptor, rowDescriptor) {
  let best = {
    score: 0,
    sourceText: "",
    sourceType: "",
    targetText: ""
  };

  for (const cardFeature of cardDescriptor.features) {
    for (const rowFeature of rowDescriptor.features) {
      let score = syncTextSimilarity(
        cardFeature,
        rowFeature
      );

      // Visible title text is a stronger signal than an arbitrary old frame
      // name. Identifier payload remains useful for provider migrations.
      if (
        cardFeature.sourceType === "visible-text" ||
        cardFeature.sourceType === "visible-combined"
      ) {
        score += 1.5;
      } else if (
        cardFeature.sourceType === "frame-payload"
      ) {
        score += 0.8;
      }

      score = Math.min(100, score);

      if (score > best.score) {
        best = {
          score,
          sourceText: cardFeature.raw,
          sourceType: cardFeature.sourceType,
          targetText: rowFeature.raw
        };
      }
    }
  }

  return best;
}

function syncAliasKeysForCard(
  cardDescriptor,
  sourceText = ""
) {
  const keys = new Set();

  const add = value => {
    const key = syncCompact(value);

    if (key && key.length >= 4) {
      keys.add(key);
    }
  };

  add(cardDescriptor.frameName);
  add(sourceText);

  for (const feature of cardDescriptor.features) {
    if (
      feature.sourceType === "frame-payload" ||
      feature.sourceType === "visible-text" ||
      feature.sourceType === "visible-combined"
    ) {
      add(feature.raw);
    }
  }

  return [...keys];
}

function getSyncAliasIdentifier(
  cardDescriptor,
  aliases,
  rowsByIdentifier
) {
  for (const key of syncAliasKeysForCard(cardDescriptor)) {
    const identifier = aliases[key];

    if (
      identifier &&
      rowsByIdentifier.has(identifier)
    ) {
      return identifier;
    }
  }

  return null;
}


function chooseBestAssignedSourceForDuplicate(
  targetRow,
  assignedItems
) {
  const sameIdentifier = assignedItems.filter(
    item =>
      String(item.identifier || "").trim() ===
      String(targetRow.identifier || "").trim()
  );

  if (!sameIdentifier.length) return null;

  const targetFeature = makeSyncTextFeature(
    targetRow.title,
    "table-title"
  );

  let best = sameIdentifier[0];
  let bestScore = -1;

  for (const item of sameIdentifier) {
    const sourceFeature = makeSyncTextFeature(
      item.title,
      "table-title"
    );

    const score = syncTextSimilarity(
      sourceFeature,
      targetFeature
    );

    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }

  return best;
}

function buildMissingCloneSuggestions(
  missingRows,
  allRows,
  assignedItems
) {
  const totalRowsByIdentifier = new Map();

  for (const row of allRows) {
    const identifier = String(row.identifier || "").trim();

    totalRowsByIdentifier.set(
      identifier,
      (totalRowsByIdentifier.get(identifier) || 0) + 1
    );
  }

  const suggestions = [];

  for (const missingRow of missingRows) {
    const identifier = String(missingRow.identifier || "").trim();

    // Clone suggestions are ONLY for intentionally repeated exact identifiers.
    if (
      !identifier ||
      (totalRowsByIdentifier.get(identifier) || 0) < 2
    ) {
      continue;
    }

    const source = chooseBestAssignedSourceForDuplicate(
      missingRow,
      assignedItems
    );

    if (!source || !source.cardId) {
      continue;
    }

    suggestions.push({
      id: `clone-${++fullSyncSessionSeq}`,
      score: 100,
      reason: "same-identifier-missing-row",
      sourceCardId: source.cardId,
      sourceRowKey: source.rowKey || null,
      sourceTitle: source.title,
      sourceIdentifier: source.identifier,
      targetRowKey: missingRow._syncRowKey,
      targetTitle: missingRow.title,
      targetIdentifier: missingRow.identifier,
      created: false,
      createdNodeId: null
    });
  }

  return suggestions;
}


function syncPublicCloneSuggestion(item) {
  return {
    id: item.id,
    sourceCardId: item.sourceCardId,
    sourceRowKey: item.sourceRowKey || null,
    sourceTitle: item.sourceTitle,
    sourceIdentifier: item.sourceIdentifier,
    targetRowKey: item.targetRowKey || null,
    targetTitle: item.targetTitle,
    targetIdentifier: item.targetIdentifier,
    score: Number.isFinite(Number(item.score))
      ? Math.round(Number(item.score) * 10) / 10
      : null,
    created: item.created === true,
    createdNodeId: item.createdNodeId || null
  };
}

async function cloneMissingFromSuggestion(sessionId, suggestionId) {
  if (!fullSyncSession || fullSyncSession.id !== sessionId) {
    return { error: "Sync session is no longer active. Run Full Sync again." };
  }

  const suggestion = fullSyncSession.cloneSuggestions.find(
    item => item.id === suggestionId
  );

  if (!suggestion) {
    return { error: "Clone suggestion was not found." };
  }

  if (suggestion.created) {
    return {
      sessionId,
      suggestion: syncPublicCloneSuggestion(suggestion),
      alreadyCreated: true
    };
  }

  const source = await figma.getNodeByIdAsync(suggestion.sourceCardId);

  if (
    !source ||
    source.type === "DOCUMENT" ||
    source.type === "PAGE" ||
    typeof source.clone !== "function"
  ) {
    return {
      error: "Source Figma frame is unavailable or cannot be duplicated."
    };
  }

  try {
    const clone = source.clone();
    clone.name = suggestion.targetIdentifier;

    const parent = clone.parent;

    try {
      const parentUsesAutoLayout =
        parent && "layoutMode" in parent && parent.layoutMode !== "NONE";

      if (
        !parentUsesAutoLayout &&
        typeof source.x === "number" &&
        typeof source.y === "number" &&
        typeof source.width === "number"
      ) {
        const alreadyCreated = fullSyncSession.cloneSuggestions.filter(
          item =>
            item.sourceCardId === suggestion.sourceCardId &&
            item.created === true
        ).length;

        clone.x = source.x + (source.width + 40) * (alreadyCreated + 1);
        clone.y = source.y;
      }
    } catch (e) {}

    suggestion.created = true;
    suggestion.createdNodeId = clone.id;

    fullSyncSession.missing = fullSyncSession.missing.filter(
      item =>
        item._syncRowKey !== suggestion.targetRowKey
    );

    if (
      Array.isArray(fullSyncSession.selectionIds) &&
      !fullSyncSession.selectionIds.includes(clone.id)
    ) {
      fullSyncSession.selectionIds.push(clone.id);
    }

    // User-facing selection should contain ONLY the newly duplicated card.
    // The complete sync set is still preserved internally in selectionIds.
    figma.currentPage.selection = [clone];
    figma.viewport.scrollAndZoomIntoView([clone]);

    return {
      sessionId,
      suggestion: syncPublicCloneSuggestion(suggestion),
      missingCount: fullSyncSession.missing.length,
      createdNodeId: clone.id
    };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}

async function cloneAllMissingSuggestions(sessionId) {
  if (!fullSyncSession || fullSyncSession.id !== sessionId) {
    return { error: "Sync session is no longer active. Run Full Sync again." };
  }

  const created = [];
  const skipped = [];

  for (const suggestion of fullSyncSession.cloneSuggestions) {
    if (wasStopRequested()) break;
    if (suggestion.created) continue;

    const result = await cloneMissingFromSuggestion(sessionId, suggestion.id);

    if (result.error) {
      skipped.push({
        targetTitle: suggestion.targetTitle,
        targetIdentifier: suggestion.targetIdentifier,
        reason: result.error
      });
    } else {
      created.push(result.suggestion);
    }

    if (created.length > 0 && created.length % 6 === 0) {
      if (!(await cooperativeYield())) break;
    }
  }

  const createdNodes = [];

  for (const item of created) {
    if (!item.createdNodeId) continue;
    const node = await figma.getNodeByIdAsync(item.createdNodeId);
    if (node) createdNodes.push(node);
  }

  if (createdNodes.length) {
    // Select ONLY the frames created by this duplication action.
    figma.currentPage.selection = createdNodes;
    figma.viewport.scrollAndZoomIntoView(createdNodes);
  }

  return {
    sessionId,
    created,
    skipped,
    missingCount: fullSyncSession.missing.length,
    stopped: wasStopRequested()
  };
}



function fullSyncMissingCreateOptions(options) {
  const normalized = options || {};

  const result = {
    columns: Math.max(1, Math.min(100, Number(normalized.columns) || 8)),
    gap: Math.max(0, Math.min(2000, Number(normalized.gap) || 24)),
    sidePadding: Math.max(0, Math.min(200, Number(normalized.sidePadding) || 12)),
    visualGap: Math.max(
      0,
      Math.min(
        40,
        Number.isFinite(Number(normalized.visualGap))
          ? Number(normalized.visualGap)
          : 0
      )
    ),
    minFontSize: Math.max(1, Number(normalized.minFontSize) || 16),
    maxFontSize: Math.max(1, Number(normalized.maxFontSize) || 48)
  };

  if (result.maxFontSize < result.minFontSize) {
    result.maxFontSize = result.minFontSize;
  }

  return result;
}

async function createFullSyncMissingRows(
  sessionId,
  rowKeys,
  options
) {
  if (!fullSyncSession || fullSyncSession.id !== sessionId) {
    return { error: "Sync session is no longer active. Run Full Sync again." };
  }

  if (!fullSyncSession.missingReferenceId) {
    return {
      error:
        "No reference banner is available. Run Full Sync with at least one selected banner."
    };
  }

  const reference = await figma.getNodeByIdAsync(
    fullSyncSession.missingReferenceId
  );

  if (
    !reference ||
    reference.type === "DOCUMENT" ||
    reference.type === "PAGE" ||
    reference.type === "TEXT" ||
    typeof reference.clone !== "function"
  ) {
    return {
      error:
        "The last selected reference banner is unavailable or cannot be duplicated."
    };
  }

  const requestedKeys = new Set(
    (Array.isArray(rowKeys) ? rowKeys : [])
      .map(value => String(value || "").trim())
      .filter(Boolean)
  );

  const targets = fullSyncSession.missing.filter(row =>
    requestedKeys.size === 0 || requestedKeys.has(row._syncRowKey)
  );

  if (!targets.length) {
    return {
      sessionId,
      created: [],
      skipped: [],
      missingCount: fullSyncSession.missing.length,
      referenceName: String(reference.name || "")
    };
  }

  const templateResult = await captureGeneratorTitleTemplate(
    reference,
    fullSyncSession.rows
  );

  if (templateResult.error) {
    return { error: templateResult.error };
  }

  const template = templateResult.template;
  const normalizedOptions = fullSyncMissingCreateOptions(options);
  const parent = reference.parent;

  if (!parent || !("appendChild" in parent)) {
    return { error: "Reference card parent cannot contain generated cards." };
  }

  const parentUsesAutoLayout =
    "layoutMode" in parent && parent.layoutMode !== "NONE";

  const referenceIndex =
    "children" in parent
      ? parent.children.findIndex(child => child.id === reference.id)
      : -1;

  const created = [];
  const createdNodes = [];
  const skipped = [];
  const createdRowKeys = new Set();
  let titleFallbacks = 0;
  const batchSize = girBatchSize(targets.length, 6, 18);

  for (let i = 0; i < targets.length; i++) {
    if (wasStopRequested()) break;

    const row = targets[i];
    let clone = null;
    let output = null;

    try {
      clone = reference.clone();

      if (
        referenceIndex >= 0 &&
        typeof parent.insertChild === "function"
      ) {
        try {
          const desiredIndex = Math.min(
            parent.children.length - 1,
            referenceIndex + i + 1
          );
          parent.insertChild(desiredIndex, clone);
        } catch (e) {}
      }

      clone.name = String(row.identifier || "").trim();

      if (!parentUsesAutoLayout) {
        const col = i % normalizedOptions.columns;
        const gridRow = Math.floor(i / normalizedOptions.columns);

        try {
          clone.x =
            reference.x +
            reference.width +
            normalizedOptions.gap +
            col * (reference.width + normalizedOptions.gap);

          clone.y =
            reference.y +
            gridRow * (reference.height + normalizedOptions.gap);
        } catch (e) {}
      }

      const titleResult = await buildTitleFitForCard(
        clone,
        [row],
        normalizedOptions,
        template,
        false
      );

      if (titleResult.error) {
        const fallback = await setGeneratedTitleFallback(
          clone,
          row.title
        );

        if (fallback.error) {
          try {
            const failedNode =
              clone.parent &&
              clone.parent.type === "FRAME" &&
              clone.parent.name === String(row.identifier || "").trim()
                ? clone.parent
                : clone;
            failedNode.remove();
          } catch (e) {}

          skipped.push({
            rowKey: row._syncRowKey,
            title: row.title,
            identifier: row.identifier,
            reason: fallback.error
          });
          continue;
        }

        titleFallbacks++;
      }

      output = generatorOutputNode(clone, titleResult);

      try {
        output.name = String(row.identifier || "").trim();
      } catch (e) {}

      createdNodes.push(output);
      createdRowKeys.add(row._syncRowKey);

      created.push({
        rowKey: row._syncRowKey,
        title: row.title,
        identifier: row.identifier,
        nodeId: output.id
      });

      if (
        Array.isArray(fullSyncSession.selectionIds) &&
        !fullSyncSession.selectionIds.includes(output.id)
      ) {
        fullSyncSession.selectionIds.push(output.id);
      }
    } catch (e) {
      if (clone) {
        try {
          const candidate =
            clone.parent &&
            clone.parent.type === "FRAME" &&
            clone.parent.name === String(row.identifier || "").trim()
              ? clone.parent
              : clone;
          candidate.remove();
        } catch (e2) {}
      }

      skipped.push({
        rowKey: row._syncRowKey,
        title: row.title,
        identifier: row.identifier,
        reason: e && e.message ? e.message : String(e)
      });
    }

    if (
      i === 0 ||
      (i + 1) % Math.max(5, Math.min(20, batchSize)) === 0 ||
      i === targets.length - 1
    ) {
      figma.ui.postMessage({
        type: "full-sync-missing-create-progress",
        created: created.length,
        total: targets.length,
        referenceName: String(reference.name || "")
      });
    }

    if (i > 0 && (i + 1) % batchSize === 0) {
      if (!(await cooperativeYield(true))) break;
    }
  }

  if (createdRowKeys.size) {
    fullSyncSession.missing = fullSyncSession.missing.filter(
      row => !createdRowKeys.has(row._syncRowKey)
    );
  }

  if (createdNodes.length) {
    // Keep the user's canvas selection focused ONLY on newly created cards.
    figma.currentPage.selection = createdNodes;

    try {
      figma.viewport.scrollAndZoomIntoView(createdNodes.slice(0, 40));
    } catch (e) {}
  }

  return {
    sessionId,
    created,
    skipped,
    missingCount: fullSyncSession.missing.length,
    referenceName: String(reference.name || ""),
    titleFallbacks,
    stopped: wasStopRequested()
  };
}

function prepareSyncRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    ...row,
    title: String(row.title || "").trim(),
    identifier: String(row.identifier || "").trim(),
    _syncRowKey:
      String(row._syncRowKey || "").trim() ||
      `table-row-${index + 1}`
  }));
}

function syncRowsByIdentifier(rows) {
  const map = new Map();

  for (const row of rows) {
    const identifier = String(row.identifier || "").trim();

    if (!map.has(identifier)) {
      map.set(identifier, []);
    }

    map.get(identifier).push(row);
  }

  return map;
}

function firstUnclaimedRowByIdentifier(
  rowsByIdentifier,
  identifier,
  claimedRowKeys
) {
  const candidates =
    rowsByIdentifier.get(
      String(identifier || "").trim()
    ) || [];

  return (
    candidates.find(
      row => !claimedRowKeys.has(row._syncRowKey)
    ) || null
  );
}

function syncExactTitleKeyForRow(row) {
  return syncCompact(row.title);
}

function syncCardHasExactRowTitle(cardDescriptor, row) {
  const target = syncExactTitleKeyForRow(row);

  if (!target) return false;

  return cardDescriptor.features.some(feature => {
    if (
      feature.sourceType !== "visible-text" &&
      feature.sourceType !== "visible-combined" &&
      feature.sourceType !== "frame-payload"
    ) {
      return false;
    }

    return feature.compact === target;
  });
}

function syncMakeAssignedItem(
  cardDescriptor,
  row,
  score,
  sourceText,
  mode
) {
  return {
    cardId: cardDescriptor.nodeId,
    frameName: cardDescriptor.frameName,
    rowKey: row._syncRowKey,
    title: row.title,
    identifier: row.identifier,
    score,
    sourceText: sourceText || "",
    mode
  };
}

function syncPublicMatch(item) {
  return {
    id: item.id || null,
    cardId: item.cardId,
    frameName: item.frameName,
    rowKey: item.rowKey || null,
    title: item.title,
    identifier: item.identifier,
    score:
      Number.isFinite(Number(item.score))
        ? Math.round(Number(item.score) * 10) / 10
        : null,
    sourceText: item.sourceText || "",
    mode: item.mode || "",
    confirmed: item.confirmed === true,
    rejected: item.rejected === true
  };
}

function syncPublicSession(session) {
  return {
    sessionId: session.id,
    exact: session.exact.map(syncPublicMatch),
    auto: session.auto.map(syncPublicMatch),
    review: session.review.map(syncPublicMatch),
    duplicates: session.duplicates.map(syncPublicMatch),
    extras: session.extras.map(item => ({
      cardId: item.cardId,
      frameName: item.frameName,
      bestTitle: item.bestTitle || "",
      score:
        Number.isFinite(Number(item.score))
          ? Math.round(Number(item.score) * 10) / 10
          : null
    })),
    missing: session.missing.map(item => {
      const suggestion = session.cloneSuggestions.find(
        candidate =>
          candidate.targetRowKey === item._syncRowKey
      );

      return {
        rowKey: item._syncRowKey,
        title: item.title,
        identifier: item.identifier,
        cloneSuggestion: suggestion
          ? syncPublicCloneSuggestion(suggestion)
          : null
      };
    }),
    cloneSuggestionCount: session.cloneSuggestions.filter(
      item => !item.created
    ).length,
    missingReferenceName: session.missingReferenceName || "",
    missingReferenceAvailable: !!session.missingReferenceId,
    aliasCount: session.aliasCount,
    selectedCount: Array.isArray(session.selectionIds)
      ? session.selectionIds.length
      : 0,
    tableCount: Array.isArray(session.rows)
      ? session.rows.length
      : 0,
    physicalGap:
      (Array.isArray(session.rows) ? session.rows.length : 0) -
      (Array.isArray(session.selectionIds) ? session.selectionIds.length : 0),
    primaryAssignedCount:
      session.exact.length +
      session.auto.length +
      session.review.length,
    safeCount:
      session.exact.length +
      session.auto.length +
      session.duplicates.length,
    stopped: session.stopped === true
  };
}

async function runFullSync(rows, selectionOverrideIds = null, missingReferenceOverrideId = null) {
  let selection = [...figma.currentPage.selection];

  if (
    Array.isArray(selectionOverrideIds) &&
    selectionOverrideIds.length
  ) {
    const resolved = [];

    for (const id of selectionOverrideIds) {
      const node = await figma.getNodeByIdAsync(id);

      if (
        node &&
        node.type !== "DOCUMENT" &&
        node.type !== "PAGE"
      ) {
        resolved.push(node);
      }
    }

    selection = resolved;
  }

  if (!selection.length) {
    return { error: "Select one or more cards first." };
  }

  let missingReference = null;

  if (missingReferenceOverrideId) {
    const overrideNode = await figma.getNodeByIdAsync(missingReferenceOverrideId);

    if (
      overrideNode &&
      overrideNode.type !== "DOCUMENT" &&
      overrideNode.type !== "PAGE" &&
      overrideNode.type !== "TEXT" &&
      typeof overrideNode.clone === "function"
    ) {
      missingReference = overrideNode;
    }
  }

  if (!missingReference) {
    for (let i = selection.length - 1; i >= 0; i--) {
      const candidate = selection[i];

      if (
        candidate &&
        candidate.type !== "DOCUMENT" &&
        candidate.type !== "PAGE" &&
        candidate.type !== "TEXT" &&
        typeof candidate.clone === "function"
      ) {
        missingReference = candidate;
        break;
      }
    }
  }

  const syncRows = prepareSyncRows(rows);

  if (!syncRows.length) {
    return { error: "No valid title + identifier rows." };
  }

  const rowsByIdentifier = syncRowsByIdentifier(syncRows);
  const rowDescriptors = new Map(
    syncRows.map(row => [
      row._syncRowKey,
      buildSyncRowDescriptor(row)
    ])
  );
  const exactTitleRowsByKey = new Map();

  for (const row of syncRows) {
    const key = syncExactTitleKeyForRow(row);
    if (!key) continue;
    if (!exactTitleRowsByKey.has(key)) exactTitleRowsByKey.set(key, []);
    exactTitleRowsByKey.get(key).push(row);
  }

  const aliases = await loadSyncAliases();
  const claimedRowKeys = new Set();
  const usedCardIds = new Set();

  const exact = [];
  const auto = [];
  const review = [];
  const duplicates = [];
  const extras = [];
  const descriptorByCardId = new Map();
  const cardsByFrameName = new Map();

  for (const card of selection) {
    descriptorByCardId.set(card.id, buildSyncCardDescriptor(card));

    const frameName = String(card.name || '').trim();
    if (!cardsByFrameName.has(frameName)) cardsByFrameName.set(frameName, []);
    cardsByFrameName.get(frameName).push(card);
  }

  function claim(cardDescriptor, row, bucket, score, sourceText, mode) {
    if (
      !row ||
      claimedRowKeys.has(row._syncRowKey) ||
      usedCardIds.has(cardDescriptor.nodeId)
    ) {
      return false;
    }

    bucket.push(
      syncMakeAssignedItem(
        cardDescriptor,
        row,
        score,
        sourceText,
        mode
      )
    );

    claimedRowKeys.add(row._syncRowKey);
    usedCardIds.add(cardDescriptor.nodeId);
    return true;
  }

  function rowCardTitleScore(cardDescriptor, row) {
    if (syncCardHasExactRowTitle(cardDescriptor, row)) {
      return 1000;
    }

    const rowDescriptor = rowDescriptors.get(row._syncRowKey);
    return scoreSyncCardToRow(cardDescriptor, rowDescriptor).score;
  }

  function chooseBestFreeRow(cardDescriptor, candidates) {
    const free = candidates.filter(
      row => !claimedRowKeys.has(row._syncRowKey)
    );

    if (!free.length) return null;
    if (free.length === 1) return free[0];

    let best = free[0];
    let bestScore = -Infinity;

    for (const row of free) {
      const score = rowCardTitleScore(cardDescriptor, row);

      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }

    return best;
  }

  // PASS 1: exact current Identifier, but grouped by every spreadsheet row
  // occurrence. If an Identifier repeats, visible Title decides which row gets
  // which existing card before any clone can ever be suggested.
  for (const [identifier, rowGroup] of rowsByIdentifier.entries()) {
    if (wasStopRequested()) break;

    const cards = (cardsByFrameName.get(identifier) || [])
      .filter(card => !usedCardIds.has(card.id))
      .map(card => descriptorByCardId.get(card.id));

    if (!cards.length) continue;

    const pairs = [];

    for (const cardDescriptor of cards) {
      for (const row of rowGroup) {
        pairs.push({
          cardDescriptor,
          row,
          score: rowCardTitleScore(cardDescriptor, row)
        });
      }
    }

    pairs.sort((a, b) => b.score - a.score);

    for (const pair of pairs) {
      if (
        usedCardIds.has(pair.cardDescriptor.nodeId) ||
        claimedRowKeys.has(pair.row._syncRowKey)
      ) {
        continue;
      }

      claim(
        pair.cardDescriptor,
        pair.row,
        exact,
        100,
        pair.cardDescriptor.frameName,
        rowGroup.length > 1
          ? "exact-identifier-group-row"
          : "exact-identifier-row"
      );
    }

    // More physical cards than repeated row slots = real duplicate.
    for (const cardDescriptor of cards) {
      if (usedCardIds.has(cardDescriptor.nodeId)) continue;

      duplicates.push(
        syncMakeAssignedItem(
          cardDescriptor,
          rowGroup[0],
          100,
          cardDescriptor.frameName,
          "duplicate-exact-identifier"
        )
      );

      usedCardIds.add(cardDescriptor.nodeId);
    }
  }

  // PASS 2: learned alias / old provider. If the resolved Identifier has
  // multiple rows, visible Title chooses the best still-free row.
  for (const card of selection) {
    if (wasStopRequested()) break;
    if (usedCardIds.has(card.id)) continue;

    const cardDescriptor = descriptorByCardId.get(card.id);

    const aliasIdentifier = getSyncAliasIdentifier(
      cardDescriptor,
      aliases,
      {
        has(identifier) {
          return rowsByIdentifier.has(identifier);
        }
      }
    );

    if (!aliasIdentifier) continue;

    const row = chooseBestFreeRow(
      cardDescriptor,
      rowsByIdentifier.get(aliasIdentifier) || []
    );

    if (row) {
      claim(
        cardDescriptor,
        row,
        exact,
        100,
        card.name,
        "known-alias-row"
      );
    }
  }

  // PASS 3: exact visible title. This consumes cards that already exist in
  // Figma but still have a stale / different frame identifier.
  for (const card of selection) {
    if (wasStopRequested()) break;
    if (usedCardIds.has(card.id)) continue;

    const cardDescriptor = descriptorByCardId.get(card.id);

    const candidateMap = new Map();

    for (const feature of cardDescriptor.features) {
      if (
        feature.sourceType !== 'visible-text' &&
        feature.sourceType !== 'visible-combined' &&
        feature.sourceType !== 'frame-payload'
      ) {
        continue;
      }

      for (const row of exactTitleRowsByKey.get(feature.compact) || []) {
        if (!claimedRowKeys.has(row._syncRowKey)) {
          candidateMap.set(row._syncRowKey, row);
        }
      }
    }

    const candidates = [...candidateMap.values()];

    if (!candidates.length) continue;

    const row = chooseBestFreeRow(cardDescriptor, candidates);

    if (row) {
      claim(
        cardDescriptor,
        row,
        exact,
        100,
        row.title,
        "exact-title-row"
      );
    }
  }

  // PASS 4: fuzzy 1:1 matching for only the still-unmatched physical cards and
  // row occurrences.
  const remainingCards = selection
    .filter(card => !usedCardIds.has(card.id))
    .map(card => descriptorByCardId.get(card.id));

  const pairs = [];
  const bestAnyByCard = new Map();

  for (let cardIndex = 0; cardIndex < remainingCards.length; cardIndex++) {
    if (wasStopRequested()) break;

    const cardDescriptor = remainingCards[cardIndex];
    let bestAny = null;

    for (const row of syncRows) {
      const rowDescriptor = rowDescriptors.get(row._syncRowKey);
      const scored = scoreSyncCardToRow(cardDescriptor, rowDescriptor);

      if (!bestAny || scored.score > bestAny.score) {
        bestAny = { ...scored, cardDescriptor, row };
      }

      if (
        !claimedRowKeys.has(row._syncRowKey) &&
        scored.score >= SYNC_REVIEW_THRESHOLD
      ) {
        pairs.push({ ...scored, cardDescriptor, row });
      }
    }

    bestAnyByCard.set(cardDescriptor.nodeId, bestAny);

    if (cardIndex > 0 && cardIndex % 4 === 0) {
      if (!(await cooperativeYield())) break;
    }
  }

  pairs.sort((a, b) => b.score - a.score);

  for (const pair of pairs) {
    if (wasStopRequested()) break;

    if (
      usedCardIds.has(pair.cardDescriptor.nodeId) ||
      claimedRowKeys.has(pair.row._syncRowKey)
    ) {
      continue;
    }

    const bucket =
      pair.score >= SYNC_AUTO_THRESHOLD
        ? auto
        : review;

    const item = syncMakeAssignedItem(
      pair.cardDescriptor,
      pair.row,
      pair.score,
      pair.sourceText,
      pair.score >= SYNC_AUTO_THRESHOLD
        ? "auto-fuzzy-row"
        : "review-fuzzy-row"
    );

    if (bucket === review) {
      item.id = `review-${++fullSyncSessionSeq}`;
      item.confirmed = false;
      item.rejected = false;
    }

    bucket.push(item);
    usedCardIds.add(pair.cardDescriptor.nodeId);
    claimedRowKeys.add(pair.row._syncRowKey);
  }

  // Remaining physical cards are genuine Extra / Duplicate AFTER every row
  // matching opportunity has been exhausted.
  for (const card of selection) {
    if (usedCardIds.has(card.id)) continue;

    const cardDescriptor = descriptorByCardId.get(card.id);
    const bestAny = bestAnyByCard.get(card.id);

    if (bestAny && bestAny.score >= SYNC_AUTO_THRESHOLD) {
      duplicates.push(
        syncMakeAssignedItem(
          cardDescriptor,
          bestAny.row,
          bestAny.score,
          bestAny.sourceText,
          "duplicate-after-row-slots-filled"
        )
      );
    } else {
      extras.push({
        cardId: card.id,
        frameName: card.name,
        bestTitle: bestAny ? bestAny.row.title : "",
        score: bestAny ? bestAny.score : 0
      });
    }
  }

  // Missing = ONLY rows that still have no physical card after all matching.
  const missing = syncRows.filter(
    row => !claimedRowKeys.has(row._syncRowKey)
  );

  // Clone suggestions are now deterministic:
  // exact repeated Identifier only, never fuzzy title similarity.
  const safeAssignedItems = [...exact, ...auto];

  const cloneSuggestions = buildMissingCloneSuggestions(
    missing,
    syncRows,
    safeAssignedItems
  );

  const id = `sync-${Date.now()}-${++fullSyncSessionSeq}`;

  fullSyncSession = {
    id,
    rows: syncRows,
    selectionIds: selection.map(node => node.id),
    descriptorByCardId,
    exact,
    auto,
    review,
    duplicates,
    extras,
    missing,
    cloneSuggestions,
    missingReferenceId: missingReference ? missingReference.id : null,
    missingReferenceName: missingReference ? String(missingReference.name || "") : "",
    aliasCount: Object.keys(aliases).length,
    stopped: wasStopRequested()
  };

  return syncPublicSession(fullSyncSession);
}

async function confirmFullSyncReview(
  sessionId,
  reviewId
) {
  if (
    !fullSyncSession ||
    fullSyncSession.id !== sessionId
  ) {
    return {
      error:
        "Sync session is no longer active. Run Full Sync again."
    };
  }

  const item =
    fullSyncSession.review.find(
      candidate =>
        candidate.id === reviewId
    );

  if (!item) {
    return {
      error: "Review match was not found."
    };
  }

  item.confirmed = true;
  item.rejected = false;

  const cardDescriptor =
    fullSyncSession.descriptorByCardId.get(
      item.cardId
    );

  if (cardDescriptor) {
    const aliases = await loadSyncAliases();

    for (
      const key of syncAliasKeysForCard(
        cardDescriptor,
        item.sourceText
      )
    ) {
      aliases[key] = item.identifier;
    }

    await saveSyncAliases(aliases);
    fullSyncSession.aliasCount =
      Object.keys(aliases).length;
  }

  return {
    sessionId,
    review: syncPublicMatch(item),
    aliasCount: fullSyncSession.aliasCount
  };
}

function rejectFullSyncReview(
  sessionId,
  reviewId
) {
  if (
    !fullSyncSession ||
    fullSyncSession.id !== sessionId
  ) {
    return {
      error:
        "Sync session is no longer active. Run Full Sync again."
    };
  }

  const item =
    fullSyncSession.review.find(
      candidate =>
        candidate.id === reviewId
    );

  if (!item) {
    return {
      error: "Review match was not found."
    };
  }

  item.confirmed = false;
  item.rejected = true;

  return {
    sessionId,
    review: syncPublicMatch(item)
  };
}

async function applyFullSync(sessionId) {
  if (
    !fullSyncSession ||
    fullSyncSession.id !== sessionId
  ) {
    return {
      error:
        "Sync session is no longer active. Run Full Sync again."
    };
  }

  const targets = [
    ...fullSyncSession.exact,
    ...fullSyncSession.auto,
    ...fullSyncSession.duplicates,
    ...fullSyncSession.review.filter(
      item =>
        item.confirmed === true &&
        item.rejected !== true
    )
  ];

  const applied = [];
  const skipped = [];

  for (let i = 0; i < targets.length; i++) {
    if (wasStopRequested()) break;

    const item = targets[i];
    const node =
      await figma.getNodeByIdAsync(
        item.cardId
      );

    if (
      !node ||
      node.type === "DOCUMENT" ||
      node.type === "PAGE"
    ) {
      skipped.push({
        frameName: item.frameName,
        reason: "Figma node is unavailable."
      });

      continue;
    }

    try {
      const oldName = node.name;
      node.name = item.identifier;

      applied.push({
        cardId: item.cardId,
        oldName,
        newName: item.identifier,
        mode: item.mode
      });
    } catch (e) {
      skipped.push({
        frameName: item.frameName,
        reason:
          e && e.message
            ? e.message
            : String(e)
      });
    }

    if (
      i > 0 &&
      i % 8 === 0
    ) {
      if (!(await cooperativeYield())) break;
    }
  }

  return {
    sessionId,
    applied,
    skipped,
    stopped: wasStopRequested()
  };
}

async function resetFullSyncAliases() {
  await saveSyncAliases({});

  if (fullSyncSession) {
    fullSyncSession.aliasCount = 0;
  }

  return {
    aliasCount: 0
  };
}



let stopRequested = false;
let cooperativeYieldCounter = 0;

function resetStopFlag() {
  stopRequested = false;
  cooperativeYieldCounter = 0;
}

function requestStopFlag() {
  stopRequested = true;
}

function wasStopRequested() {
  return stopRequested;
}


const girLoadedFontPromises = new Map();
const girTextWidthCache = new Map();
const girTitleFitRowsCache = new Map();
const GIR_TEXT_WIDTH_CACHE_LIMIT = 8000;
const GIR_TITLE_FIT_ROWS_CACHE_LIMIT = 2500;

function girFontKey(fontName) {
  if (!fontName || fontName === figma.mixed) return "";
  return `${fontName.family}\u0000${fontName.style}`;
}

async function loadFontCached(fontName) {
  if (!fontName || fontName === figma.mixed) return;

  const key = girFontKey(fontName);
  if (!key) return;

  let promise = girLoadedFontPromises.get(key);

  if (!promise) {
    promise = figma.loadFontAsync(fontName);
    girLoadedFontPromises.set(key, promise);
  }

  try {
    await promise;
  } catch (e) {
    girLoadedFontPromises.delete(key);
    throw e;
  }
}

function girCacheWidth(key, width) {
  if (!Number.isFinite(Number(width))) return;

  if (girTextWidthCache.size >= GIR_TEXT_WIDTH_CACHE_LIMIT) {
    const firstKey = girTextWidthCache.keys().next().value;
    if (firstKey !== undefined) girTextWidthCache.delete(firstKey);
  }

  girTextWidthCache.set(key, Number(width));
}

function girLetterSpacingKey(value) {
  if (!value || value === figma.mixed) return "";
  if (typeof value === "object") {
    return `${value.unit || ""}:${Number(value.value) || 0}`;
  }
  return String(value);
}

async function cooperativeYield(force = false) {
  if (wasStopRequested()) return false;

  // Figma's main plugin sandbox does not expose browser timers such as setTimeout.
  // Use a lightweight async Plugin API round-trip. Hot loops call this only at
  // batch boundaries; typography internals keep the older throttled behavior.
  cooperativeYieldCounter++;

  if (!force && cooperativeYieldCounter % 3 !== 0) {
    return !wasStopRequested();
  }

  try {
    await figma.getNodeByIdAsync(figma.currentPage.id);
  } catch (e) {
    // A failed yield must never abort an operation.
  }

  return !wasStopRequested();
}

function girBatchSize(total, small = 16, large = 40) {
  const count = Math.max(0, Number(total) || 0);
  if (count >= 2500) return large;
  if (count >= 750) return Math.max(small, 28);
  if (count >= 200) return Math.max(small, 20);
  return small;
}


function buildSharedIdentifierGroups(syncRows, matched) {
  const rowsByIdentifier = new Map();

  for (const row of syncRows) {
    const identifier = String(row.identifier || "").trim();
    if (!identifier) continue;

    if (!rowsByIdentifier.has(identifier)) {
      rowsByIdentifier.set(identifier, []);
    }

    rowsByIdentifier.get(identifier).push(row);
  }

  const matchedByIdentifier = new Map();

  for (const item of matched) {
    const identifier = String(item.identifier || "").trim();
    if (!identifier) continue;

    if (!matchedByIdentifier.has(identifier)) {
      matchedByIdentifier.set(identifier, []);
    }

    matchedByIdentifier.get(identifier).push(item);
  }

  const groups = [];

  for (const [identifier, rows] of rowsByIdentifier.entries()) {
    if (rows.length < 2) continue;

    const cards = matchedByIdentifier.get(identifier) || [];

    groups.push({
      identifier,
      expectedCount: rows.length,
      assignedCount: cards.length,
      titles: rows.map(row => ({
        rowKey: row._syncRowKey,
        title: row.title
      })),
      cards: cards.map(card => ({
        nodeId: card.nodeId,
        frameName: card.oldName,
        title: card.title,
        rowKey: card.rowKey
      }))
    });
  }

  groups.sort((a, b) => {
    const byCount = b.expectedCount - a.expectedCount;
    if (byCount) return byCount;
    return a.identifier.localeCompare(b.identifier);
  });

  return groups;
}

async function analyze(rows) {
  const selection = [...figma.currentPage.selection];
  const syncRows = prepareSyncRows(rows);
  const context = getRowContext(syncRows);
  const indexes = context.indexes;
  const firstRowByIdentifier = context.firstByIdentifier;
  const rowsByIdentifier = context.rowsByIdentifier;
  const claimedRowKeys = new Set();
  const identifierCursor = new Map();
  const titleCursor = new Map();

  const matched = [];
  const skipped = [];
  const extras = [];
  const duplicates = [];
  const renameTargets = [];

  function takeFirstUnclaimed(list, cursorMap, key) {
    if (!Array.isArray(list) || !list.length) return null;

    let cursor = cursorMap.get(key) || 0;

    while (
      cursor < list.length &&
      claimedRowKeys.has(list[cursor]._syncRowKey)
    ) {
      cursor++;
    }

    cursorMap.set(key, cursor + 1);
    return cursor < list.length ? list[cursor] : null;
  }

  function claimRowForMatch(resultRow) {
    if (!resultRow) return null;

    if (
      resultRow._syncRowKey &&
      !claimedRowKeys.has(resultRow._syncRowKey)
    ) {
      claimedRowKeys.add(resultRow._syncRowKey);
      return resultRow;
    }

    const identifier = String(resultRow.identifier || '').trim();
    const freeByIdentifier = takeFirstUnclaimed(
      rowsByIdentifier.get(identifier) || [],
      identifierCursor,
      identifier
    );

    if (freeByIdentifier) {
      claimedRowKeys.add(freeByIdentifier._syncRowKey);
      return freeByIdentifier;
    }

    const titleKey = strictNormalize(resultRow.title);
    const freeByTitle = takeFirstUnclaimed(
      context.strictTitleRows.get(titleKey) || [],
      titleCursor,
      titleKey
    );

    if (freeByTitle) {
      claimedRowKeys.add(freeByTitle._syncRowKey);
      return freeByTitle;
    }

    return null;
  }

  const batchSize = girBatchSize(selection.length, 18, 48);

  for (let cardIndex = 0; cardIndex < selection.length; cardIndex++) {
    if (wasStopRequested()) break;

    const card = selection[cardIndex];
    const result = matchCard(
      card,
      indexes,
      firstRowByIdentifier
    );

    if (result.status === 'matched') {
      const claimedRow = claimRowForMatch(result.row);

      if (claimedRow) {
        const identifier = String(
          claimedRow.identifier || ''
        ).trim();

        matched.push({
          nodeId: card.id,
          oldName: card.name,
          rowKey: claimedRow._syncRowKey,
          title: claimedRow.title,
          identifier,
          foundText:
            result.text && result.text.characters
              ? result.text.characters
              : '',
          mode: result.mode
        });

        renameTargets.push({
          nodeId: card.id,
          identifier,
          rowKey: claimedRow._syncRowKey,
          duplicate: false
        });
      } else {
        const identifier = String(
          result.row.identifier || ''
        ).trim();

        const texts = getTextNodes(card)
          .map(t => String(t.characters || '').trim())
          .filter(Boolean)
          .slice(0, 8);

        duplicates.push({
          nodeId: card.id,
          frameName: card.name,
          reason:
            `All spreadsheet row occurrences for "${result.row.title}" are already matched by other Figma cards.`,
          texts,
          duplicateIdentifier: identifier,
          targetIdentifier: identifier
        });

        renameTargets.push({
          nodeId: card.id,
          identifier,
          duplicate: true
        });
      }
    } else if (result.status === 'extra') {
      const texts = getTextNodes(card)
        .map(t => String(t.characters || '').trim())
        .filter(Boolean)
        .slice(0, 8);

      extras.push({
        nodeId: card.id,
        frameName: card.name,
        reason: result.reason,
        texts
      });
    } else {
      skipped.push({
        nodeId: card.id,
        frameName: card.name,
        reason: result.reason,
        texts: getTextNodes(card)
          .map(t => t.characters)
          .filter(Boolean)
          .slice(0, 8)
      });
    }

    if (
      cardIndex > 0 &&
      (cardIndex + 1) % batchSize === 0
    ) {
      if (!(await cooperativeYield(true))) break;
    }
  }

  const stopped = wasStopRequested();

  const missing = stopped
    ? []
    : syncRows
        .filter(row => !claimedRowKeys.has(row._syncRowKey))
        .map(row => ({
          rowKey: row._syncRowKey,
          title: row.title,
          identifier: row.identifier
        }));

  const sharedIdentifierGroups = buildSharedIdentifierGroups(
    syncRows,
    matched
  );

  return {
    selection,
    tableRowCount: syncRows.length,
    claimedRowCount: claimedRowKeys.size,
    matched,
    skipped,
    extras,
    duplicates,
    sharedIdentifierGroups,
    renameTargets,
    missing,
    stopped
  };
}

function findMatchedTitleNode(card, rows) {
  const context = getRowContext(rows);
  const indexes = context.indexes;
  const rowsByIdentifier = context.firstByIdentifier;

  // If the frame is already renamed, we know which table row belongs to it.
  let targetRow = rowsByIdentifier.get(String(card.name).trim()) || null;

  const texts = getTextNodes(card);

  // If frame name isn't enough, find the matching row from the text.
  if (!targetRow) {
    const result = matchCard(card, indexes, rowsByIdentifier);
    if (result.status === "matched") targetRow = result.row;
  }

  if (!targetRow) return null;

  // Prefer a single text node that equals the full title.
  for (const t of texts) {
    if (strictNormalize(t.characters) === strictNormalize(targetRow.title) ||
        looseNormalize(t.characters) === looseNormalize(targetRow.title)) {
      return { node: t, row: targetRow };
    }
  }

  // If title is split across layers (AUTO + ROULETTE), select the group of adjacent
  // text nodes whose combined text equals the table title. For normalization we return
  // all title nodes so their typography can be changed together and their group can move.
  for (let i = 0; i < texts.length; i++) {
    let joined = "";
    const group = [];
    for (let j = i; j < Math.min(texts.length, i + 5); j++) {
      const s = String(texts[j].characters || "").trim();
      if (!s) continue;
      group.push(texts[j]);
      joined = joined ? `${joined} ${s}` : s;

      if (strictNormalize(joined) === strictNormalize(targetRow.title) ||
          looseNormalize(joined) === looseNormalize(targetRow.title)) {
        return { nodes: group, row: targetRow };
      }
    }
  }

  return null;
}

function getAbsBox(node) {
  const b = node.absoluteBoundingBox;
  if (!b) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function unionBoxes(nodes) {
  const boxes = nodes.map(getAbsBox).filter(Boolean);
  if (!boxes.length) return null;
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.width));
  const maxY = Math.max(...boxes.map(b => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function getTitleNodes(match) {
  if (!match) return [];
  if (match.nodes) return match.nodes;
  if (match.node) return [match.node];
  return [];
}


function isCanonicalTitleFrame(node) {
  return !!node &&
    node.type === "FRAME" &&
    String(node.name || "").trim().toLocaleLowerCase() === "title" &&
    node.layoutMode === "VERTICAL";
}

function canonicalTitleLines(frame) {
  if (!isCanonicalTitleFrame(frame)) return [];

  return frame.children
    .filter(node => node.type === "TEXT")
    .sort((a, b) => {
      const ai = Number(String(a.name || "").match(/(\d+)/)?.[1] || 999);
      const bi = Number(String(b.name || "").match(/(\d+)/)?.[1] || 999);
      return ai - bi;
    });
}

function findCanonicalTitleFrame(card) {
  if (!card || !("children" in card)) return null;

  for (const child of card.children) {
    if (isCanonicalTitleFrame(child) && canonicalTitleLines(child).length) {
      return child;
    }
  }

  let found = null;

  function walk(node, depth) {
    if (found || depth > 3 || !node || !("children" in node)) return;

    for (const child of node.children) {
      if (isCanonicalTitleFrame(child) && canonicalTitleLines(child).length) {
        found = child;
        return;
      }
      walk(child, depth + 1);
      if (found) return;
    }
  }

  walk(card, 0);
  return found;
}

function combinedCanonicalTitle(frame) {
  return canonicalTitleLines(frame)
    .map(node => String(node.characters || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

function rowForCanonicalTitle(card, frame, rows) {
  const cleanRows = Array.isArray(rows) ? rows : [];

  const byIdentifier = cleanRows.find(
    row => String(row.identifier || "").trim() === String(card.name || "").trim()
  );
  if (byIdentifier) return byIdentifier;

  const combined = combinedCanonicalTitle(frame);

  if (combined) {
    const exact = cleanRows.find(row =>
      strictNormalize(row.title) === strictNormalize(combined) ||
      looseNormalize(row.title) === looseNormalize(combined)
    );
    if (exact) return exact;
  }

  return {
    title: combined || String(card.name || ""),
    identifier: String(card.name || "")
  };
}

function titleContainerFromMatch(match) {
  if (!match) return null;

  if (match.container && isCanonicalTitleFrame(match.container)) {
    return match.container;
  }

  const nodes = getTitleNodes(match);
  if (!nodes.length) return null;

  const parent = nodes[0].parent;

  if (
    parent &&
    isCanonicalTitleFrame(parent) &&
    nodes.every(node => node.parent && node.parent.id === parent.id)
  ) {
    return parent;
  }

  return null;
}

function renameCanonicalLines(frame) {
  const lines = canonicalTitleLines(frame);
  for (let i = 0; i < lines.length; i++) {
    lines[i].name = `строка ${i + 1}`;
  }
}

function configureCanonicalTitleFrame(frame, gap) {
  frame.name = "title";
  frame.layoutMode = "VERTICAL";
  frame.primaryAxisAlignItems = "MIN";
  frame.counterAxisAlignItems = "CENTER";
  frame.itemSpacing = Math.max(0, Math.min(40, Number(gap) || 0));
  frame.paddingTop = 0;
  frame.paddingRight = 0;
  frame.paddingBottom = 0;
  frame.paddingLeft = 0;
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;

  try { frame.layoutSizingHorizontal = "HUG"; } catch (e) {}
  try { frame.layoutSizingVertical = "HUG"; } catch (e) {}
  try { frame.setPluginData("girTitleStructure", "v2"); } catch (e) {}
}


async function applyCapHeightBaseline(node) {
  if (!node || node.type !== "TEXT") return false;

  try {
    await loadAllFontsInTextNode(node);
  } catch (e) {}

  try {
    node.leadingTrim = { type: "CAP_HEIGHT" };

    // Read-back when available. This keeps the helper explicit and makes
    // failures non-fatal on older hosts.
    try {
      return !!node.leadingTrim &&
        node.leadingTrim !== figma.mixed &&
        node.leadingTrim.type === "CAP_HEIGHT";
    } catch (e) {
      return true;
    }
  } catch (e) {
    return false;
  }
}


async function enforceFastTitleRowGeometry(node) {
  if (!node || node.type !== "TEXT") return false;

  try { await loadAllFontsInTextNode(node); } catch (e) {}

  try { node.textAutoResize = "WIDTH_AND_HEIGHT"; } catch (e) {}
  try { node.lineHeight = { unit: "AUTO" }; } catch (e) {}
  try { node.paragraphSpacing = 0; } catch (e) {}
  try { node.listSpacing = 0; } catch (e) {}
  try { node.textAlignVertical = "TOP"; } catch (e) {}
  try { node.leadingTrim = { type: "CAP_HEIGHT" }; } catch (e) {}
  try { node.layoutSizingHorizontal = "HUG"; } catch (e) {}
  try { node.layoutSizingVertical = "HUG"; } catch (e) {}

  return true;
}

async function measureBareGlyphBounds(node) {
  if (!node || node.type !== "TEXT" || !node.characters.length) return null;

  let clone = null;

  try {
    clone = node.clone();
    figma.currentPage.appendChild(clone);

    try { clone.x = -100000; } catch (e) {}
    try { clone.y = -100000; } catch (e) {}
    try { clone.visible = true; } catch (e) {}
    try { clone.opacity = 1; } catch (e) {}
    try { clone.effects = []; } catch (e) {}
    try { clone.strokes = []; } catch (e) {}
    try { clone.strokeWeight = 0; } catch (e) {}

    await loadAllFontsInTextNode(clone);

    try { clone.textAutoResize = "WIDTH_AND_HEIGHT"; } catch (e) {}
    try { clone.lineHeight = { unit: "AUTO" }; } catch (e) {}
    try { clone.paragraphSpacing = 0; } catch (e) {}
    try { clone.listSpacing = 0; } catch (e) {}
    try { clone.textAlignVertical = "TOP"; } catch (e) {}
    await applyCapHeightBaseline(clone);

    const render = clone.absoluteRenderBounds;
    const box = clone.absoluteBoundingBox;

    if (!render || !box) return null;

    return {
      width: Math.max(1, render.width),
      height: Math.max(1, render.height),
      topInset: render.y - box.y,
      bottomInset: (box.y + box.height) - (render.y + render.height)
    };
  } catch (e) {
    return null;
  } finally {
    if (clone) {
      try { clone.remove(); } catch (e) {}
    }
  }
}

async function enforceTightCapHeightRow(node) {
  if (!node || node.type !== "TEXT") return false;

  try {
    await loadAllFontsInTextNode(node);
  } catch (e) {}

  // First use Figma's native tight-text settings.
  try { node.textAutoResize = "WIDTH_AND_HEIGHT"; } catch (e) {}
  try { node.lineHeight = { unit: "AUTO" }; } catch (e) {}
  try { node.paragraphSpacing = 0; } catch (e) {}
  try { node.listSpacing = 0; } catch (e) {}
  try { node.textAlignVertical = "TOP"; } catch (e) {}

  await applyCapHeightBaseline(node);

  // Then calibrate the TextNode's own height against the actual glyph render
  // bounds. This removes any residual font-internal top/bottom whitespace, so
  // each `строка N` behaves like the user's ALMIGHTY reference layer.
  const glyph = await measureBareGlyphBounds(node);

  if (glyph && Number.isFinite(glyph.height) && glyph.height > 0) {
    let requestedLineHeight = glyph.height;

    for (let i = 0; i < 4; i++) {
      try {
        node.lineHeight = {
          unit: "PIXELS",
          value: Math.max(1, requestedLineHeight)
        };
      } catch (e) {
        break;
      }

      await applyCapHeightBaseline(node);

      const box = node.absoluteBoundingBox;
      if (!box || !Number.isFinite(box.height)) break;

      const error = glyph.height - box.height;

      if (Math.abs(error) <= 0.15) break;

      requestedLineHeight = Math.max(1, requestedLineHeight + error);
    }
  }

  // Re-apply after calibration.
  await applyCapHeightBaseline(node);

  try { node.layoutSizingHorizontal = "HUG"; } catch (e) {}
  try { node.layoutSizingVertical = "HUG"; } catch (e) {}

  return true;
}


async function applyCapHeightBaselineToTitle(frame) {
  const lines = canonicalTitleLines(frame);

  for (const line of lines) {
    if (wasStopRequested()) return false;
    await applyCapHeightBaseline(line);

    if (!(await cooperativeYield())) return false;
  }

  return true;
}




function getMaxFontSize(node) {
  if (!node || node.type !== "TEXT" || !node.characters.length) return 0;
  let max = 0;
  for (let i = 0; i < node.characters.length; i++) {
    const size = node.getRangeFontSize(i, i + 1);
    if (size !== figma.mixed && typeof size === "number") max = Math.max(max, size);
  }
  return max;
}


function getNodeMaxFontSize(node) {
  if (!node || node.type !== "TEXT") return 0;

  // Fast path for a uniform-size TextNode.
  try {
    if (
      node.fontSize !== figma.mixed &&
      typeof node.fontSize === "number"
    ) {
      return node.fontSize;
    }
  } catch (e) {}

  // Mixed-size fallback.
  return getMaxFontSize(node);
}

function findTitleHeuristically(card) {
  const texts = getTextNodes(card).filter(t =>
    String(t.characters || "").trim().length
  );

  if (!texts.length) return null;

  const cardBox = getAbsBox(card);

  const ranked = texts
    .map(t => {
      const box = getAbsBox(t);
      const size = getNodeMaxFontSize(t);
      const chars = String(t.characters || "").trim();

      if (!box) return null;

      let score = size * 10;

      if (cardBox) {
        const centerY = box.y + box.height / 2;
        const relY = (centerY - cardBox.y) / Math.max(1, cardBox.height);

        // Game titles in these banners are usually around the lower-middle area.
        if (relY >= 0.48 && relY <= 0.88) score += 140;
        else if (relY > 0.88) score -= 50;
      }

      // Provider labels / tiny captions should almost never win.
      if (size <= 18) score -= 180;
      if (chars.length <= 2) score -= 60;

      // A multi-word display title is more likely than a small provider label.
      if (/\s/.test(chars)) score += 30;

      return { node: t, size, box, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return null;

  const top = ranked[0];
  const topSize = top.size;

  if (!topSize) {
    return {
      nodes: [top.node],
      row: { title: top.node.characters, identifier: card.name }
    };
  }

  // Legacy cards can already have 2–3 separate title Text Layers. Keep nearby
  // layers with comparable display size as one title.
  const threshold = topSize * 0.68;
  const candidates = ranked.filter(x => x.size >= threshold);

  const anchorBox = top.box;
  const centerX = anchorBox.x + anchorBox.width / 2;

  const nearby = candidates.filter(x => {
    const b = x.box;
    const cx = b.x + b.width / 2;

    const horizontalNear =
      Math.abs(cx - centerX) <= Math.max(anchorBox.width, b.width) * 0.85 + 42;

    const verticalNear =
      Math.abs(b.y - anchorBox.y) <= 180;

    return horizontalNear && verticalNear;
  });

  const nodes = (nearby.length ? nearby : [top])
    .sort((a, b) => a.box.y - b.box.y)
    .map(x => x.node);

  const title = nodes
    .map(n => String(n.characters || "").trim())
    .filter(Boolean)
    .join(" ");

  return {
    nodes,
    row: {
      title,
      identifier: card.name
    }
  };
}

function findTitleForNormalize(card, rows) {
  const canonical = findCanonicalTitleFrame(card);

  if (canonical) {
    return {
      nodes: canonicalTitleLines(canonical),
      container: canonical,
      row: rowForCanonicalTitle(card, canonical, rows)
    };
  }

  if (rows && rows.length) {
    const matched = findMatchedTitleNode(card, rows);
    if (matched) return matched;
  }

  return findTitleHeuristically(card);
}

async function getReferenceFontName(titleNodes) {
  for (const node of titleNodes) {
    if (node.characters.length > 0) {
      const fn = node.getRangeFontName(0, 1);
      if (fn !== figma.mixed) return fn;
    }
  }
  return null;
}

function getReferenceLetterSpacing(titleNodes) {
  for (const node of titleNodes) {
    if (node.characters.length > 0) {
      const ls = node.getRangeLetterSpacing(0, 1);
      if (ls !== figma.mixed) return ls;
    }
  }
  return null;
}

function applyLetterSpacing(node, letterSpacing) {
  if (!node.characters.length || !letterSpacing) return;
  node.setRangeLetterSpacing(0, node.characters.length, letterSpacing);
}

async function applyFontNamePreservingSizes(node, fontName) {
  if (!node.characters.length || !fontName) return;
  await loadFontCached(fontName);
  // This changes family/style only; per-character font sizes remain untouched.
  node.setRangeFontName(0, node.characters.length, fontName);
}

function moveNodesBy(nodes, dx, dy) {
  for (const node of nodes) {
    // x/y translation preserves each text node's size and all character-level font sizes.
    node.x += dx;
    node.y += dy;
  }
}


function scaleCardToReferenceSize(card, width, height) {
  if (!card) {
    return {
      ok: false,
      reason: "Card is unavailable."
    };
  }

  const targetWidth = Math.max(0.01, Number(width) || 0.01);
  const targetHeight = Math.max(0.01, Number(height) || 0.01);

  const currentBox = getAbsBox(card);

  if (
    !currentBox ||
    currentBox.width <= 0 ||
    currentBox.height <= 0
  ) {
    return {
      ok: false,
      reason: "Could not read the current card size."
    };
  }

  if (typeof card.rescale !== "function") {
    return {
      ok: false,
      reason: "This card type does not support Figma Scale."
    };
  }

  const scaleX = targetWidth / currentBox.width;
  const scaleY = targetHeight / currentBox.height;

  // Uniform scale preserves all internal proportions: text, strokes, effects,
  // images, gradients, corner radii, gaps, offsets, etc.
  //
  // If aspect ratios differ, an exact W×H match is impossible without
  // distortion. Use FIT so the scaled card stays inside the reference bounds.
  const aspectDifference =
    Math.abs(scaleX - scaleY) /
    Math.max(scaleX, scaleY, 0.0001);

  const sameAspectRatio = aspectDifference <= 0.01;

  const scale = sameAspectRatio
    ? scaleX
    : Math.min(scaleX, scaleY);

  if (!Number.isFinite(scale) || scale <= 0) {
    return {
      ok: false,
      reason: "Could not calculate a valid scale factor."
    };
  }

  const originalX =
    typeof card.x === "number"
      ? card.x
      : null;

  const originalY =
    typeof card.y === "number"
      ? card.y
      : null;

  try {
    // Equivalent to using Figma's Scale Tool.
    card.rescale(scale);

    // Keep the card anchored at its original top-left position.
    if (originalX !== null) {
      try { card.x = originalX; } catch (e) {}
    }

    if (originalY !== null) {
      try { card.y = originalY; } catch (e) {}
    }

    const finalBox = getAbsBox(card);

    return {
      ok: true,
      scale,
      sameAspectRatio,
      aspectDifference,
      targetWidth,
      targetHeight,
      finalWidth: finalBox ? finalBox.width : currentBox.width * scale,
      finalHeight: finalBox ? finalBox.height : currentBox.height * scale
    };
  } catch (e) {
    return {
      ok: false,
      reason:
        e && e.message
          ? e.message
          : String(e)
    };
  }
}

function normalizeHorizontalHost(card, container, titleNodes) {
  // Center the title in the frame that directly contains it, rather than
  // copying the reference card's X offset.
  if (container && container.parent && container.parent.type !== "PAGE" && container.parent.type !== "DOCUMENT") {
    const box = getAbsBox(container.parent);
    if (box) return { node: container.parent, box };
  }

  const nodes = Array.isArray(titleNodes) ? titleNodes.filter(Boolean) : [];
  if (nodes.length) {
    const parent = nodes[0].parent;
    const sameParent = parent && nodes.every(node => node.parent && node.parent.id === parent.id);

    if (sameParent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
      const box = getAbsBox(parent);
      if (box) return { node: parent, box };
    }
  }

  const cardBox = getAbsBox(card);
  return cardBox ? { node: card, box: cardBox } : null;
}

async function normalizeTitles(rows, settings) {
  if (!normalizeReferenceId) {
    return { error: "Set a reference card first." };
  }

  const refCard = await figma.getNodeByIdAsync(normalizeReferenceId);
  if (!refCard || refCard.type === "DOCUMENT" || refCard.type === "PAGE") {
    return { error: "Reference card is no longer available. Set it again." };
  }

  const refMatch = findTitleForNormalize(refCard, rows);
  if (!refMatch) {
    return { error: "Could not find the game-title text inside the reference card." };
  }

  const refTitleNodes = getTitleNodes(refMatch);
  const refContainer = titleContainerFromMatch(refMatch);
  const refCardBox = getAbsBox(refCard);
  const refTitleBox = refContainer ? getAbsBox(refContainer) : unionBoxes(refTitleNodes);

  if (!refCardBox || !refTitleBox) {
    return { error: "Could not read reference card/title bounds." };
  }

  const refFrameWidth = refCardBox.width;
  const refFrameHeight = refCardBox.height;

  const refBottomOffset =
    (refCardBox.y + refCardBox.height) -
    (refTitleBox.y + refTitleBox.height);

  const refFontName =
    settings.copyFont
      ? await getReferenceFontName(refTitleNodes)
      : null;

  const refLetterSpacing =
    settings.copyLetterSpacing
      ? getReferenceLetterSpacing(refTitleNodes)
      : null;

  const refGap =
    settings.copyGap && refContainer
      ? refContainer.itemSpacing
      : null;

  const resolved = resolveSelectedCards(rows);
  const selection = resolved.cards;

  const changed = [];
  let changedCount = 0;
  const skipped = resolved.unresolved.map(item => ({
    frameName: item.nodeName,
    reason: `Could not resolve ${item.nodeType} to a card frame.`
  }));

  const batchSize = girBatchSize(selection.length, 14, 36);
  const progressStep = Math.max(12, Math.min(60, batchSize * 2));

  for (let cardIndex = 0; cardIndex < selection.length; cardIndex++) {
    if (wasStopRequested()) break;

    const card = selection[cardIndex];

    if (card.id === normalizeReferenceId) {
      continue;
    }

    const match = findTitleForNormalize(card, rows);

    if (!match) {
      skipped.push({ frameName: card.name, reason: "Title layer not found." });
      continue;
    }

    const titleNodes = getTitleNodes(match);
    const container = titleContainerFromMatch(match);

    try {
      let frameResized = false;
      let frameScale = null;
      let frameScaleExact = null;
      let frameScaleAspectDifference = null;

      if (settings.copyFrameSize) {
        const scaleResult = scaleCardToReferenceSize(
          card,
          refFrameWidth,
          refFrameHeight
        );

        if (!scaleResult.ok) {
          skipped.push({
            frameName: card.name,
            reason:
              scaleResult.reason ||
              "Could not scale the card frame to the reference size."
          });
          continue;
        }

        frameResized = true;
        frameScale = scaleResult.scale;
        frameScaleExact = scaleResult.sameAspectRatio;
        frameScaleAspectDifference = scaleResult.aspectDifference;
      }

      if (settings.copyFont && refFontName) {
        for (const node of titleNodes) {
          await applyFontNamePreservingSizes(node, refFontName);
        }
      }

      if (settings.copyLetterSpacing && refLetterSpacing) {
        for (const node of titleNodes) {
          applyLetterSpacing(node, refLetterSpacing);
        }
      }

      // Canonical row metric: cap height → baseline on every row.
      for (const node of titleNodes) {
        await applyCapHeightBaseline(node);
      }

      if (settings.copyGap && container && refGap !== null) {
        container.itemSpacing = refGap;
      }

      const cardBox = getAbsBox(card);
      const titleBox = container ? getAbsBox(container) : unionBoxes(titleNodes);

      if (!cardBox || !titleBox) {
        skipped.push({ frameName: card.name, reason: "Could not read title bounds." });
        continue;
      }

      let dx = 0;
      let dy = 0;

      if (settings.alignCenter) {
        // Text content itself should also be centered inside its own Text box.
        for (const node of titleNodes) {
          try { node.textAlignHorizontal = "CENTER"; } catch (e) {}
        }

        // Canonical `title` Auto Layout keeps every row centered internally.
        if (container) {
          try { container.counterAxisAlignItems = "CENTER"; } catch (e) {}
        }

        // Position the title group at the exact horizontal center of the frame
        // that contains it. This deliberately does NOT inherit the reference
        // card's horizontal offset.
        const horizontalHost = normalizeHorizontalHost(card, container, titleNodes);
        const currentTitleBox = container ? getAbsBox(container) : unionBoxes(titleNodes);

        if (horizontalHost && currentTitleBox) {
          const desiredCenterX = horizontalHost.box.x + horizontalHost.box.width / 2;
          const currentCenterX = currentTitleBox.x + currentTitleBox.width / 2;
          dx = desiredCenterX - currentCenterX;
        }
      }

      if (settings.alignBottom) {
        const desiredBottomY = cardBox.y + cardBox.height - refBottomOffset;
        const currentBottomY = titleBox.y + titleBox.height;
        dy = desiredBottomY - currentBottomY;
      }

      if (dx || dy) {
        if (container) {
          container.x += dx;
          container.y += dy;
        } else {
          moveNodesBy(titleNodes, dx, dy);
        }
      }

      const normalizedCardBox = getAbsBox(card);

      changedCount++;

      if (changed.length < 8) {
        changed.push({
          frameName: card.name,
          title: match.row.title,
          identifier: match.row.identifier,
          lines: titleNodes.length,
          gap: container ? container.itemSpacing : null,
          frameResized,
          frameScale,
          frameScaleExact,
          frameScaleAspectDifference,
          frameWidth: normalizedCardBox ? normalizedCardBox.width : null,
          frameHeight: normalizedCardBox ? normalizedCardBox.height : null
        });
      }
    } catch (err) {
      skipped.push({
        frameName: card.name,
        reason: err && err.message ? err.message : String(err)
      });
    }

    if (
      cardIndex === 0 ||
      (cardIndex + 1) % progressStep === 0 ||
      cardIndex === selection.length - 1
    ) {
      figma.ui.postMessage({
        type: 'normalize-progress',
        processed: cardIndex + 1,
        total: selection.length,
        changed: changedCount,
        skipped: skipped.length
      });
    }

    if (
      cardIndex > 0 &&
      (cardIndex + 1) % batchSize === 0
    ) {
      if (!(await cooperativeYield(true))) break;
    }
  }

  return {
    reference: {
      frameName: refCard.name,
      title: refMatch.row.title,
      lines: refTitleNodes.length,
      gap: refContainer ? refContainer.itemSpacing : null,
      frameWidth: refFrameWidth,
      frameHeight: refFrameHeight
    },
    changed,
    changedCount,
    skipped,
    stopped: wasStopRequested(),
    selectedNodes: resolved.rawSelection.length,
    resolvedCards: selection.length
  };
}


function cloneLineHeight(value) {
  if (!value || value === figma.mixed) return null;
  if (value.unit === "AUTO") return { unit: "AUTO" };
  return { unit: value.unit, value: value.value };
}

function getAutoFitLineRanges(text) {
  const ranges = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      if (i > start) ranges.push({ start, end: i });
      start = i + 1;
    }
  }
  return ranges;
}

function getRangeMaxFontSize(node, start, end) {
  let max = 0;
  for (let i = start; i < end; i++) {
    const size = node.getRangeFontSize(i, i + 1);
    if (size !== figma.mixed && typeof size === "number") max = Math.max(max, size);
  }
  return max;
}

function captureAutoFitTextState(node) {
  const box = getAbsBox(node);
  const ranges = getAutoFitLineRanges(node.characters).map(r => ({
    start: r.start,
    end: r.end,
    fontSize: getRangeMaxFontSize(node, r.start, r.end),
    lineHeight: cloneLineHeight(node.getRangeLineHeight(r.start, r.end))
  }));
  return { node, box, ranges };
}

function restoreAutoFitLineHeights(node, state) {
  for (const r of state.ranges) {
    if (!r.lineHeight) continue;
    try { node.setRangeLineHeight(r.start, r.end, r.lineHeight); } catch (e) {}
  }
}


function setLineHeightPixels(node, range, value) {
  const lineHeight = {
    unit: "PIXELS",
    value: Math.max(1, value)
  };

  const endWithBreak =
    range.end < node.characters.length && node.characters[range.end] === "\n"
      ? range.end + 1
      : range.end;

  try {
    node.setRangeLineHeight(range.start, endWithBreak, lineHeight);
  } catch (e) {
    try {
      node.setRangeLineHeight(range.start, range.end, lineHeight);
    } catch (e2) {}
  }
}

function applyProportionalLineHeight(node, percent) {
  if (!node || node.type !== "TEXT" || !node.characters.length) return;

  const ranges = getAutoFitLineRanges(node.characters);
  if (!ranges.length) return;

  const ratio = Math.max(0.7, Math.min(1.6, (Number(percent) || 100) / 100));

  for (const range of ranges) {
    const size = getRangeMaxFontSize(node, range.start, range.end) || 1;
    setLineHeightPixels(node, range, size * ratio);
  }
}


function availableTitleWidth(card, paddingPercent) {
  const box = getAbsBox(card);
  if (!box) return null;
  const p = Math.max(0, Math.min(45, Number(paddingPercent) || 0)) / 100;
  return box.width * (1 - p * 2);
}

function preserveSeparateLayerGaps(states) {
  const ordered = states.filter(s => s.box).sort((a,b) => a.box.y - b.box.y);
  const gaps = [];
  for (let i=0; i<ordered.length-1; i++) {
    gaps.push(ordered[i+1].box.y - (ordered[i].box.y + ordered[i].box.height));
  }
  return { ordered, gaps };
}

function restoreSeparateLayerGaps(ordered, gaps) {
  for (let i=1; i<ordered.length; i++) {
    const prev = ordered[i-1].node.absoluteBoundingBox;
    const cur = ordered[i].node.absoluteBoundingBox;
    if (!prev || !cur) continue;
    const desiredY = prev.y + prev.height + gaps[i-1];
    ordered[i].node.y += desiredY - cur.y;
  }
}


async function measureRangeWidth(node, start, end, fontSize) {
  if (end <= start) return 0;

  const chars = node.characters.slice(start, end);
  if (!chars) return 0;

  // Read the source font first.
  const fontName = node.getRangeFontName(start, Math.min(start + 1, end));
  if (fontName === figma.mixed) return null;

  // IMPORTANT:
  // figma.createText() starts with Figma's default font (usually Inter Regular).
  // Figma requires that CURRENT font to be loaded before changing properties such as
  // textAutoResize. Then we load and assign the actual source font.
  const temp = figma.createText();

  try {
    const defaultFont = temp.fontName;
    if (defaultFont !== figma.mixed) {
      await loadFontCached(defaultFont);
    }

    await loadFontCached(fontName);

    temp.fontName = fontName;
    temp.fontSize = fontSize;

    const ls = node.getRangeLetterSpacing(start, Math.min(start + 1, end));
    if (ls !== figma.mixed) temp.letterSpacing = ls;

    // Critical: measure the same visual case as the real title.
    // Without this, "Power Combo" was measured while Figma displayed
    // "POWER COMBO", causing long uppercase rows to overflow.
    try {
      if (node.textCase !== figma.mixed) {
        temp.textCase = node.textCase;
      }
    } catch (e) {}

    temp.textAutoResize = "WIDTH_AND_HEIGHT";
    temp.characters = chars;
    temp.opacity = 0;
    temp.visible = false;

    return temp.width;
  } finally {
    temp.remove();
  }
}

async function fitRangeToWidth(node, start, end, targetWidth, minFont, maxFont) {
  const current = getRangeMaxFontSize(node, start, end);
  if (!current) return;

  const minSize = Math.max(1, Number(minFont) || 1);
  const maxSize = Math.max(minSize, Number(maxFont) || minSize);

  let low = minSize;
  let high = maxSize;

  // Safe starting value: minimum, never the current oversized font.
  let best = minSize;

  // Check the minimum explicitly first.
  const minWidth = await measureRangeWidth(node, start, end, minSize);

  if (minWidth === null || wasStopRequested()) return;

  // If even Min Font cannot fit, we still must never clip. Treat Min Font as
  // a soft preference and emergency-shrink below it until the row fits.
  if (minWidth > targetWidth) {
    let emergency = Math.max(
      1,
      minSize * (targetWidth / Math.max(1, minWidth)) * 0.985
    );

    for (let i = 0; i < 4; i++) {
      const width = await measureRangeWidth(node, start, end, emergency);
      if (width === null || wasStopRequested()) return;

      if (width <= targetWidth + 0.25) break;

      emergency = Math.max(
        1,
        emergency * (targetWidth / Math.max(1, width)) * 0.985
      );
    }

    node.setRangeFontSize(
      start,
      end,
      Math.round(emergency * 10) / 10
    );
    return;
  }

  for (let i = 0; i < 11; i++) {
    if (wasStopRequested()) return;

    const mid = (low + high) / 2;
    const width = await measureRangeWidth(node, start, end, mid);

    if (width === null || wasStopRequested()) return;

    if (width <= targetWidth) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }

    if (!(await cooperativeYield())) return;
  }

  if (wasStopRequested()) return;

  node.setRangeFontSize(
    start,
    end,
    Math.round(best * 10) / 10
  );
}

async function fitTextNodeWhole(node, targetWidth, minFont, maxFont) {
  if (!node.characters.length) return;
  await fitRangeToWidth(node, 0, node.characters.length, targetWidth, minFont, maxFont);
}



async function maximizeTitleRowToWidth(
  node,
  targetWidth,
  minFontSize,
  maxFontSize
) {
  if (!node || node.type !== "TEXT" || !node.characters.length) {
    return { changed: false, fontSize: null, width: null };
  }

  try { await loadAllFontsInTextNode(node); } catch (e) {}

  const safeWidth = Math.max(1, Number(targetWidth) || 1);
  const preferredMin = Math.max(1, Number(minFontSize) || 1);
  const preferredMax = Math.max(preferredMin, Number(maxFontSize) || preferredMin);

  try { node.textAlignHorizontal = "CENTER"; } catch (e) {}

  let size = preferredMax;

  try {
    node.setRangeFontSize(0, node.characters.length, Math.round(size * 10) / 10);
  } catch (e) {}

  await enforceFastTitleRowGeometry(node);

  // Real TextNode width scales almost linearly with font size. One proportional
  // correction is normally sufficient; two extra checks cover metric rounding.
  for (let pass = 0; pass < 3; pass++) {
    const actualWidth = Number(node.width);
    if (!Number.isFinite(actualWidth)) break;

    if (actualWidth <= safeWidth + 0.25) break;

    const currentSize = getNodeMaxFontSize(node) || size;
    const scale = (safeWidth / Math.max(1, actualWidth)) * 0.975;
    size = Math.max(1, currentSize * scale);

    try {
      node.setRangeFontSize(
        0,
        node.characters.length,
        Math.round(size * 10) / 10
      );
    } catch (e) {
      break;
    }

    await enforceFastTitleRowGeometry(node);
  }

  // Expensive glyph-bound calibration happens ONCE at the final size.
  await enforceTightCapHeightRow(node);

  // Tight calibration can slightly change width. One lightweight emergency
  // correction is enough in practice.
  const finalWidth = Number(node.width);
  if (Number.isFinite(finalWidth) && finalWidth > safeWidth + 0.5) {
    const currentSize = getNodeMaxFontSize(node) || size;
    const nextSize = Math.max(
      1,
      currentSize * (safeWidth / Math.max(1, finalWidth)) * 0.97
    );

    try {
      node.setRangeFontSize(
        0,
        node.characters.length,
        Math.round(nextSize * 10) / 10
      );
    } catch (e) {}

    await enforceTightCapHeightRow(node);
  }

  return {
    changed: true,
    fontSize: getNodeMaxFontSize(node) || size,
    width: Number(node.width) || null
  };
}

async function guaranteeTitleRowWidth(node, targetWidth, preferredMinFont) {
  if (!node || node.type !== "TEXT" || !node.characters.length) return false;

  const safeWidth = Math.max(1, Number(targetWidth) || 1);
  let changed = false;

  for (let pass = 0; pass < 3; pass++) {
    const actualWidth = Number(node.width);
    if (!Number.isFinite(actualWidth) || actualWidth <= safeWidth + 0.25) break;

    const currentSize =
      getNodeMaxFontSize(node) ||
      Number(preferredMinFont) ||
      16;

    const nextSize = Math.max(
      1,
      currentSize * (safeWidth / Math.max(1, actualWidth)) * 0.97
    );

    try {
      node.setRangeFontSize(
        0,
        node.characters.length,
        Math.round(nextSize * 10) / 10
      );
    } catch (e) {
      break;
    }

    await enforceFastTitleRowGeometry(node);
    changed = true;
  }

  if (changed) {
    await enforceTightCapHeightRow(node);
  }

  return changed;
}

function forceTitleFrameToTargetWidth(titleFrame, targetWidth) {
  if (!titleFrame || !Number.isFinite(Number(targetWidth))) return false;

  const width = Math.max(1, Number(targetWidth));

  try {
    // Vertical Auto Layout:
    // counter axis = horizontal width.
    titleFrame.counterAxisSizingMode = "FIXED";
  } catch (e) {}

  try {
    titleFrame.resizeWithoutConstraints(
      width,
      Math.max(1, titleFrame.height)
    );
  } catch (e) {
    try {
      titleFrame.resize(
        width,
        Math.max(1, titleFrame.height)
      );
    } catch (e2) {
      return false;
    }
  }

  try {
    titleFrame.counterAxisAlignItems = "CENTER";
  } catch (e) {}

  return true;
}


async function fitTitleAutoLayoutToCard(
  titleFrame,
  targetWidth,
  preferredMinFont,
  preferredMaxFont = 48
) {
  if (!titleFrame || !Number.isFinite(Number(targetWidth))) {
    return {
      changed: false,
      targetWidth: null,
      finalWidth: null
    };
  }

  const safeTargetWidth = Math.max(1, Number(targetWidth));
  let changed = false;

  for (const row of canonicalTitleLines(titleFrame)) {
    const before = Number(row.width);

    await guaranteeTitleRowWidth(
      row,
      safeTargetWidth,
      preferredMinFont
    );

    const after = Number(row.width);

    if (
      Number.isFinite(before) &&
      Number.isFinite(after) &&
      Math.abs(before - after) > 0.25
    ) {
      changed = true;
    }
  }

  forceTitleFrameToTargetWidth(
    titleFrame,
    safeTargetWidth
  );

  await cooperativeYield();

  return {
    changed,
    targetWidth: safeTargetWidth,
    finalWidth: Number(titleFrame.width) || safeTargetWidth
  };
}

async function fitTextNodeByLines(node, targetWidth, minFont, maxFont) {
  const state = captureAutoFitTextState(node);
  const lines = getAutoFitLineRanges(node.characters);

  for (const r of lines) {
    if (wasStopRequested()) return;

    await fitRangeToWidth(node, r.start, r.end, targetWidth, minFont, maxFont);

    if (!(await cooperativeYield())) return;
  }

  if (!wasStopRequested()) {
    restoreAutoFitLineHeights(node, state);
  }
}


async function autoFitTitles(rows, options) {
  const resolved = resolveSelectedCards(rows);
  const selection = resolved.cards;

  if (!resolved.rawSelection.length) {
    return { error: "Select target cards or title layers first." };
  }

  if (!selection.length) {
    return { error: "Could not resolve selected layers to card frames." };
  }

  const changed = [];
  const skipped = resolved.unresolved.map(item => ({
    frameName: item.nodeName,
    reason: `Could not resolve ${item.nodeType} to a card frame.`
  }));

  for (const card of selection) {
    if (wasStopRequested()) break;

    let canonical = findCanonicalTitleFrame(card);

    if (!canonical) {
      const converted = await convertCardTitleToAutoLayout(card, rows, {
        maxLines: options.maxLines || 3,
        rowCount: options.rowCount || options.maxLines || 3,
        exactRows: true,
        paddingPercent: options.paddingPercent,
        gap: options.gap,
        minFontSize: options.minFontSize,
        maxFontSize: options.maxFontSize,
        forceRebuild: false
      });

      if (converted.error) {
        skipped.push({ frameName: card.name, reason: converted.error });
        continue;
      }

      canonical = findCanonicalTitleFrame(card);
    }

    if (!canonical) {
      skipped.push({
        frameName: card.name,
        reason: "Canonical title Auto Layout not found."
      });
      continue;
    }

    const lines = canonicalTitleLines(canonical);
    const targetWidth = availableTitleWidth(card, options.paddingPercent);

    if (!lines.length || !targetWidth) {
      skipped.push({
        frameName: card.name,
        reason: "Could not read title/card bounds."
      });
      continue;
    }

    const beforeBox = getAbsBox(canonical);

    try {
      configureCanonicalTitleFrame(
        canonical,
        Number.isFinite(Number(options.gap))
          ? Number(options.gap)
          : canonical.itemSpacing
      );

      for (const line of lines) {
        if (wasStopRequested()) break;

        await fitTextNodeWhole(
          line,
          targetWidth,
          options.minFontSize,
          options.maxFontSize
        );

        try {
          line.lineHeight = { unit: "PERCENT", value: 100 };
        } catch (e) {}

        await applyCapHeightBaseline(line);

        if (!(await cooperativeYield())) break;
      }

      renameCanonicalLines(canonical);

      if (options.preserveBottom !== false && beforeBox) {
        positionTitleFrameLikeOriginal(canonical, beforeBox);
      }

      changed.push({
        frameName: card.name,
        title: combinedCanonicalTitle(canonical),
        identifier: card.name,
        lines: canonicalTitleLines(canonical).length,
        gap: canonical.itemSpacing
      });
    } catch (err) {
      skipped.push({
        frameName: card.name,
        reason: err && err.message ? err.message : String(err)
      });
    }

    if (!(await cooperativeYield())) break;
  }

  return {
    changed,
    skipped,
    stopped: wasStopRequested(),
    selectedNodes: resolved.rawSelection.length,
    resolvedCards: selection.length
  };
}



async function loadAllFontsInTextNode(node) {
  if (!node || node.type !== "TEXT") return;

  const length = node.characters.length;
  if (!length) return;

  // Fast API path: one call returns all fonts in the range.
  try {
    if (typeof node.getRangeAllFontNames === "function") {
      const fonts = node.getRangeAllFontNames(0, length);
      for (const fontName of fonts) {
        await loadFontCached(fontName);
      }
      return;
    }
  } catch (e) {}

  // Compatibility fallback.
  const seen = new Set();

  for (let i = 0; i < length; i++) {
    const fontName = node.getRangeFontName(i, i + 1);
    if (fontName === figma.mixed) continue;

    const key = girFontKey(fontName);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    await loadFontCached(fontName);
  }
}

async function measureLiteralWidthUsingRangeStyle(node, start, end, literal, fontSize) {
  if (!literal) return 0;
  if (end <= start) end = Math.min(node.characters.length, start + 1);
  if (end <= start) return null;

  const fontName = node.getRangeFontName(start, end);
  if (fontName === figma.mixed) return null;

  const ls = node.getRangeLetterSpacing(start, end);
  let textCase = null;

  try {
    textCase = node.textCase !== figma.mixed ? node.textCase : null;
  } catch (e) {}

  const cacheKey = [
    girFontKey(fontName),
    Number(fontSize) || 0,
    girLetterSpacingKey(ls),
    textCase || "",
    literal
  ].join("\u0001");

  if (girTextWidthCache.has(cacheKey)) {
    return girTextWidthCache.get(cacheKey);
  }

  const temp = figma.createText();

  try {
    const defaultFont = temp.fontName;
    if (defaultFont !== figma.mixed) await loadFontCached(defaultFont);
    await loadFontCached(fontName);

    temp.fontName = fontName;
    temp.fontSize = fontSize;

    if (ls !== figma.mixed) temp.letterSpacing = ls;
    if (textCase) {
      try { temp.textCase = textCase; } catch (e) {}
    }

    temp.textAutoResize = "WIDTH_AND_HEIGHT";
    temp.characters = literal;
    temp.visible = false;

    const width = temp.width;
    girCacheWidth(cacheKey, width);

    return width;
  } finally {
    temp.remove();
  }
}

function getSmartWords(node) {
  const words = [];
  const re = /\S+/g;
  let match;

  while ((match = re.exec(node.characters)) !== null) {
    words.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length
    });
  }

  return words;
}

async function measureSmartWords(node, words) {
  if (!node || !Array.isArray(words) || !words.length) return [];

  const measured = [];
  const temp = figma.createText();

  try {
    const first = words[0];
    const firstEnd = Math.min(first.end, first.start + 1);
    const fontName = node.getRangeFontName(first.start, firstEnd);

    if (fontName === figma.mixed) return null;

    const size =
      getRangeMaxFontSize(node, first.start, first.end) ||
      getNodeMaxFontSize(node) ||
      32;

    const ls = node.getRangeLetterSpacing(first.start, firstEnd);

    const defaultFont = temp.fontName;
    if (defaultFont !== figma.mixed) await loadFontCached(defaultFont);
    await loadFontCached(fontName);

    temp.fontName = fontName;
    temp.fontSize = size;
    if (ls !== figma.mixed) temp.letterSpacing = ls;

    try {
      if (node.textCase !== figma.mixed) {
        temp.textCase = node.textCase;
      }
    } catch (e) {}

    temp.textAutoResize = "WIDTH_AND_HEIGHT";
    temp.visible = false;

    temp.characters = " ";
    const spaceWidth = temp.width;

    for (let i = 0; i < words.length; i++) {
      if (wasStopRequested()) return null;

      const word = words[i];
      temp.characters = word.text;

      measured.push({
        ...word,
        width: temp.width,
        spaceWidth
      });

      // Keep Stop responsive without an async round-trip for every word.
      if (i > 0 && i % 8 === 0) {
        if (!(await cooperativeYield())) return null;
      }
    }

    return measured;
  } finally {
    temp.remove();
  }
}

function smartLineCountRange(wordCount, preferredLines) {
  if (wordCount <= 1) return [1];
  if (wordCount === 2) return [2];

  // IMPORTANT:
  // Older versions forced all 3-4 word titles into exactly 2 lines.
  // That is why titles like:
  //   SANTA'S CHRISTMAS FORTUNE
  // could become:
  //   SANTA'S CHRISTMAS
  //   FORTUNE
  // even when the first line was wider than the available card area.
  //
  // Now we evaluate several possible line counts and let the rendered width
  // decide whether 2, 3, or (when enabled) 4 lines are better.
  const maxLines = Math.min(
    wordCount,
    Math.max(2, Math.min(4, Number(preferredLines) || 3))
  );

  const counts = [];
  for (let n = 2; n <= maxLines; n++) counts.push(n);
  return counts;
}

function enumeratePartitions(wordCount, lineCount) {
  const results = [];

  function walk(startWord, linesLeft, cuts) {
    if (linesLeft === 1) {
      results.push([...cuts, wordCount]);
      return;
    }

    const maxCut = wordCount - (linesLeft - 1);
    for (let cut = startWord + 1; cut <= maxCut; cut++) {
      cuts.push(cut);
      walk(cut, linesLeft - 1, cuts);
      cuts.pop();
    }
  }

  walk(0, lineCount, []);
  return results;
}

function partitionWidths(words, cuts) {
  const widths = [];
  let start = 0;

  for (const cut of cuts) {
    let width = 0;

    for (let i = start; i < cut; i++) {
      width += words[i].width;
      if (i < cut - 1) width += words[i].spaceWidth;
    }

    widths.push(width);
    start = cut;
  }

  return widths;
}

function scoreSmartPartition(widths, targetWidth) {
  if (!widths.length) return Infinity;

  const mean = widths.reduce((a, b) => a + b, 0) / widths.length;
  if (!mean) return Infinity;

  let balance = 0;
  let overflow = 0;
  let tinyLinePenalty = 0;

  for (const width of widths) {
    const diff = (width - mean) / mean;
    balance += diff * diff;

    if (width > targetWidth) {
      const over = (width - targetWidth) / targetWidth;
      overflow += over * over * 500;
    }

    if (width < mean * 0.42) {
      tinyLinePenalty += (0.42 - width / mean) * 4;
    }
  }

  // Prefer arrangements that use the available width without forcing overflow.
  const maxWidth = Math.max(...widths);
  const underfill = maxWidth < targetWidth * 0.58
    ? (targetWidth * 0.58 - maxWidth) / targetWidth
    : 0;

  return overflow + balance + tinyLinePenalty + underfill * 0.6;
}


function chooseExactSmartBreaks(words, targetWidth, requestedLines) {
  if (!words || !words.length) return null;

  const lineCount = Math.max(
    1,
    Math.min(Number(requestedLines) || 1, words.length)
  );

  if (lineCount === 1) {
    return {
      cuts: [words.length],
      widths: [
        words.reduce(
          (sum, word, i) =>
            sum + word.width + (i ? words[i - 1].spaceWidth : 0),
          0
        )
      ],
      lineCount: 1,
      score: 0
    };
  }

  const candidates = enumeratePartitions(words.length, lineCount);
  let best = null;

  for (const cuts of candidates) {
    const widths = partitionWidths(words, cuts);
    let score = scoreSmartPartition(widths, targetWidth);

    const overflowCount = widths.filter(width => width > targetWidth).length;
    const maxOverflow = widths.length
      ? Math.max(...widths.map(width => Math.max(0, width - targetWidth)))
      : 0;

    if (overflowCount) {
      score += overflowCount * 250 + (maxOverflow / targetWidth) * 500;
    }

    if (!best || score < best.score) {
      best = { cuts, widths, score, lineCount };
    }
  }

  return best;
}

function chooseSmartBreaks(words, targetWidth, preferredLines) {
  const lineCounts = smartLineCountRange(words.length, preferredLines);

  if (lineCounts.length === 1 && lineCounts[0] === 1) {
    return {
      cuts: [words.length],
      widths: [words.reduce((s, w, i) => s + w.width + (i ? words[i - 1].spaceWidth : 0), 0)],
      lineCount: 1
    };
  }

  let best = null;
  const minLines = Math.min(...lineCounts);

  for (const lineCount of lineCounts) {
    const candidates = enumeratePartitions(words.length, lineCount);

    for (const cuts of candidates) {
      const widths = partitionWidths(words, cuts);
      let score = scoreSmartPartition(widths, targetWidth);

      // Prefer fewer lines when both variants fit well,
      // but NEVER at the cost of a line overflowing the safe width.
      score += (lineCount - minLines) * 0.75;

      const overflowCount = widths.filter(w => w > targetWidth).length;
      const maxOverflow = widths.length
        ? Math.max(...widths.map(w => Math.max(0, w - targetWidth)))
        : 0;

      // Extra hard penalty makes a 3-line layout beat a clipped 2-line layout.
      if (overflowCount) {
        score += overflowCount * 250 + (maxOverflow / targetWidth) * 500;
      }

      if (!best || score < best.score) {
        best = { cuts, widths, score, lineCount };
      }
    }
  }

  return best;
}

function buildSmartText(words, cuts) {
  const lines = [];
  let start = 0;

  for (const cut of cuts) {
    lines.push(words.slice(start, cut).map(w => w.text).join(" "));
    start = cut;
  }

  return lines.join("\n");
}

async function replaceSmartSeparators(node, words, cuts) {
  const breakAfter = new Set(cuts.slice(0, -1).map(cut => cut - 1));

  await loadAllFontsInTextNode(node);

  // Replace whitespace gaps from the end so earlier indices remain valid.
  for (let i = words.length - 2; i >= 0; i--) {
    const left = words[i];
    const right = words[i + 1];
    const gapStart = left.end;
    const gapEnd = right.start;
    const desired = breakAfter.has(i) ? "\n" : " ";

    if (gapEnd > gapStart) {
      node.deleteCharacters(gapStart, gapEnd);
    }

    node.insertCharacters(gapStart, desired, "BEFORE");
  }
}

async function smartLineBreakTitles(rows, options) {
  const selection = [...figma.currentPage.selection];
  if (!selection.length) return { error: "Select target cards first." };

  const changed = [];
  const skipped = [];

  for (const card of selection) {
    if (wasStopRequested()) break;

    const match = findTitleForNormalize(card, rows);

    if (!match) {
      skipped.push({ frameName: card.name, reason: "Title layer not found." });
      continue;
    }

    const titleNodes = getTitleNodes(match);

    // Reflowing multiple separate text layers would require merging them and could
    // damage custom typography, so v5.13 handles the safe case: one title TextNode.
    if (titleNodes.length !== 1) {
      skipped.push({
        frameName: card.name,
        reason: "Smart Line Breaks requires the title to be in one Text Layer."
      });
      continue;
    }

    const node = titleNodes[0];
    const words = getSmartWords(node);

    if (words.length <= 1) {
      changed.push({
        frameName: card.name,
        title: match.row.title,
        identifier: match.row.identifier,
        before: node.characters,
        after: node.characters
      });
      continue;
    }

    const targetWidth = availableTitleWidth(card, options.paddingPercent);
    if (!targetWidth) {
      skipped.push({ frameName: card.name, reason: "Could not read title/card bounds." });
      continue;
    }

    try {
      const beforeBox = getAbsBox(node);
      const beforeText = node.characters;
      const measuredWords = await measureSmartWords(node, words);

      if (!measuredWords) {
        skipped.push({ frameName: card.name, reason: "Could not measure title text." });
        continue;
      }

      const best = chooseSmartBreaks(measuredWords, targetWidth, options.preferredLines);
      if (!best || !best.cuts) {
        skipped.push({ frameName: card.name, reason: "Could not calculate line breaks." });
        continue;
      }

      const afterText = buildSmartText(measuredWords, best.cuts);

      // Capture uniform line-height before editing so line spacing stays intact.
      const originalLineHeight =
        node.characters.length && node.lineHeight !== figma.mixed
          ? cloneLineHeight(node.lineHeight)
          : null;

      await replaceSmartSeparators(node, words, best.cuts);

      if (originalLineHeight && node.characters.length) {
        try {
          node.setRangeLineHeight(0, node.characters.length, originalLineHeight);
        } catch (e) {}
      }

      // Optional: immediately run the existing Auto Fit on the new lines.
      if (options.autoFitAfter) {
        await fitTextNodeByLines(
          node,
          targetWidth,
          options.minFontSize,
          options.maxFontSize
        );
      }

      if (options.proportionalLineHeight) {
        applyProportionalLineHeight(node, options.lineHeightPercent);
      }

      if (options.preserveBottom && beforeBox) {
        const afterBox = getAbsBox(node);
        if (afterBox) {
          const dy = (beforeBox.y + beforeBox.height) - (afterBox.y + afterBox.height);
          node.y += dy;
        }
      }

      changed.push({
        frameName: card.name,
        title: match.row.title,
        identifier: match.row.identifier,
        before: beforeText,
        after: node.characters
      });
    } catch (e) {
      skipped.push({
        frameName: card.name,
        reason: e && e.message ? e.message : String(e)
      });
    }

    if (!(await cooperativeYield())) break;
  }

  return { changed, skipped, stopped: wasStopRequested() };
}



function isInsideInstance(node, stopAt) {
  let current = node;

  while (current) {
    if (current.type === "INSTANCE") return true;
    if (current === stopAt) break;
    current = current.parent;
  }

  return false;
}


async function hideLegacyTitleNode(node) {
  if (!node || node.type !== "TEXT") return false;

  // Visibility overrides are the cleanest option inside an Instance.
  try {
    node.visible = false;
    if (node.visible === false) return true;
  } catch (e) {}

  // Fallback: opacity is also overrideable for many scene nodes.
  try {
    node.opacity = 0;
    if (node.opacity === 0) return true;
  } catch (e) {}

  // Final fallback for instance text: an empty text override. This is only used
  // if visibility/opacity cannot be overridden.
  try {
    await loadAllFontsInTextNode(node);
    node.characters = "";
    return true;
  } catch (e) {}

  return false;
}

async function retireLegacyTitleNodes(titleNodes, card) {
  for (const node of titleNodes) {
    if (!node || node.type !== "TEXT") continue;

    if (isInsideInstance(node, card)) {
      const hidden = await hideLegacyTitleNode(node);

      if (!hidden) {
        return {
          ok: false,
          reason: "Could not hide the legacy title inside its nested Instance."
        };
      }

      continue;
    }

    try {
      node.remove();
    } catch (e) {
      // If structural removal unexpectedly fails, try the same safe hiding path.
      const hidden = await hideLegacyTitleNode(node);

      if (!hidden) {
        return {
          ok: false,
          reason: "Could not retire the original title layer."
        };
      }
    }
  }

  return { ok: true };
}


function canHostAutoLayoutTitle(card) {
  if (!card) return false;
  if (card.type === "INSTANCE") return false;
  return "appendChild" in card;
}


async function prepareTitleFitHost(card) {
  if (!card) return { error: "Selected card is unavailable." };

  if (card.type !== "INSTANCE") {
    if (!canHostAutoLayoutTitle(card)) {
      return { error: "Selected card cannot contain the title Auto Layout." };
    }

    return {
      host: card,
      originalCard: card,
      wrappedInstance: false,
      stableBox: getAbsBox(card)
    };
  }

  const parent = card.parent;

  if (!parent || !("appendChild" in parent)) {
    return {
      error: "The selected card is an Instance and cannot be wrapped in its current parent."
    };
  }

  const box = getAbsBox(card);
  if (!box) {
    return { error: "Could not read the selected Instance bounds." };
  }

  const originalName = String(card.name || "card");
  const oldParent = parent;
  const oldIndex =
    "children" in oldParent
      ? oldParent.children.findIndex(child => child.id === card.id)
      : -1;

  const wrapper = figma.createFrame();
  wrapper.name = originalName;
  wrapper.fills = [];
  wrapper.strokes = [];
  wrapper.clipsContent = false;

  try {
    wrapper.resizeWithoutConstraints(
      Math.max(1, card.width),
      Math.max(1, card.height)
    );
  } catch (e) {
    try {
      wrapper.resize(
        Math.max(1, card.width),
        Math.max(1, card.height)
      );
    } catch (e2) {
      try { wrapper.remove(); } catch (e3) {}
      return { error: "Could not create a wrapper for the selected Instance." };
    }
  }

  try {
    if (oldIndex >= 0 && typeof oldParent.insertChild === "function") {
      oldParent.insertChild(oldIndex, wrapper);
    } else {
      oldParent.appendChild(wrapper);
    }
  } catch (e) {
    try { wrapper.remove(); } catch (e2) {}
    return { error: "Could not insert the wrapper frame." };
  }

  // Preserve canvas position before reparenting.
  try {
    wrapper.x = card.x;
    wrapper.y = card.y;
  } catch (e) {}

  // Preserve common Auto Layout child behavior where possible.
  for (const prop of [
    "layoutAlign",
    "layoutGrow",
    "layoutPositioning"
  ]) {
    try {
      wrapper[prop] = card[prop];
    } catch (e) {}
  }

  try {
    wrapper.appendChild(card);
  } catch (e) {
    try { wrapper.remove(); } catch (e2) {}
    return { error: "Could not move the Instance into its wrapper frame." };
  }

  try {
    card.x = 0;
    card.y = 0;
  } catch (e) {}

  // The wrapper owns the identifier; keep the nested instance name less
  // ambiguous but do not detach or modify the component structure.
  try {
    if (String(card.name || "") === originalName) {
      card.name = "Slot";
    }
  } catch (e) {}

  return {
    host: wrapper,
    originalCard: card,
    wrappedInstance: true,
    stableBox: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      source: "frame"
    }
  };
}


function isSceneContainer(node) {
  return !!node &&
    node.type !== "DOCUMENT" &&
    node.type !== "PAGE" &&
    node.type !== "TEXT" &&
    "children" in node;
}

function rowIdentifierSet(rows) {
  return new Set(
    (Array.isArray(rows) ? rows : [])
      .map(row => String(row.identifier || "").trim())
      .filter(Boolean)
  );
}

function directChildNameScore(node) {
  if (!node || !("children" in node)) return 0;

  let score = 0;

  for (const child of node.children) {
    const name = String(child.name || "").trim().toLocaleLowerCase();

    if (name === "gradient" || name === "градиент") score += 80;
    if (name === "background") score += 70;
    if (name === "object") score += 45;
    if (name === "slot") score += 30;
    if (name === "title") score += 80;
  }

  return score;
}

function cardCandidateScore(node, identifiers, distance) {
  if (!isSceneContainer(node)) return -Infinity;

  let score = 0;
  const name = String(node.name || "").trim();

  if (identifiers.has(name)) score += 2000;

  // Imported game-card identifiers can use either the older underscore
  // format or the newer provider:GameName namespace format.
  // Examples:
  // mg_slots_..., ntn_..., hsg_...
  // bgmng:GoldMagnate
  if (/^[a-z0-9]+_[a-z0-9_]+$/i.test(name)) score += 180;
  if (/^[a-z0-9][a-z0-9_-]{1,31}:[a-z0-9][a-z0-9._:-]*$/i.test(name)) score += 180;
  if (/_slots_|_live_|_table_/i.test(name)) score += 140;

  if (node.type === "FRAME") score += 60;
  if (node.type === "COMPONENT") score += 45;
  if (node.type === "INSTANCE") score += 20;

  if (findCanonicalTitleFrame(node)) score += 300;

  score += directChildNameScore(node);

  // Prefer the nearest good ancestor when scores are otherwise similar.
  score -= Math.max(0, distance) * 5;

  return score;
}

function resolveOwningCard(node, rows, identifierSetOverride = null) {
  if (!node) return null;

  const identifiers =
    identifierSetOverride ||
    getRowContext(rows).identifierSet;

  // Existing canonical structure:
  // card -> title -> строка N
  if (node.type === "TEXT" && node.parent && isCanonicalTitleFrame(node.parent)) {
    const parentCard = node.parent.parent;
    if (parentCard && isSceneContainer(parentCard)) return parentCard;
  }

  if (isCanonicalTitleFrame(node)) {
    const parentCard = node.parent;
    if (parentCard && isSceneContainer(parentCard)) return parentCard;
  }

  // If a real card/root frame itself is selected, prefer it immediately when
  // its identifier is present in the table or it clearly looks like a card.
  if (isSceneContainer(node)) {
    const ownScore = cardCandidateScore(node, identifiers, 0);
    if (ownScore >= 200) return node;
  }

  // Walk upward from selected text/group/etc. and choose the strongest card
  // ancestor. This is what makes selecting title text layers work.
  let current = node.parent;
  let distance = 1;
  let best = null;
  let bestScore = -Infinity;
  let nearestContainer = null;

  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (isSceneContainer(current)) {
      if (!nearestContainer) nearestContainer = current;

      const score = cardCandidateScore(current, identifiers, distance);
      if (score > bestScore) {
        best = current;
        bestScore = score;
      }
    }

    current = current.parent;
    distance++;
  }

  // A score >= 100 means we found strong card evidence.
  // Otherwise the nearest frame/group is safer than treating the selected
  // TextNode itself as a card.
  return bestScore >= 100 ? best : nearestContainer;
}

function resolveSelectedCards(rows) {
  const rawSelection = [...figma.currentPage.selection];
  const cards = [];
  const seen = new Set();
  const unresolved = [];
  const identifiers = getRowContext(rows).identifierSet;

  for (const selected of rawSelection) {
    const card = resolveOwningCard(selected, rows, identifiers);

    if (!card) {
      unresolved.push({
        nodeId: selected.id,
        nodeName: selected.name,
        nodeType: selected.type
      });
      continue;
    }

    if (seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
  }

  return {
    rawSelection,
    cards,
    unresolved
  };
}


function isDirectSortableCardNode(node) {
  if (!node) return false;

  return (
    node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE" ||
    node.type === "GROUP" ||
    node.type === "SECTION" ||
    node.type === "COMPONENT_SET"
  ) && "x" in node && "y" in node && !!node.parent;
}

function resolveSortTargets(rows) {
  const rawSelection = [...figma.currentPage.selection];
  const targets = [];
  const unresolved = [];
  const seen = new Set();
  const identifiers = getRowContext(rows).identifierSet;

  for (const selected of rawSelection) {
    let target = null;

    if (isDirectSortableCardNode(selected)) {
      target = selected;
    } else {
      target = resolveOwningCard(selected, rows, identifiers);
    }

    if (!target || !("x" in target) || !("y" in target) || !target.parent) {
      unresolved.push({
        nodeId: selected.id,
        nodeName: selected.name,
        nodeType: selected.type
      });
      continue;
    }

    if (seen.has(target.id)) continue;
    seen.add(target.id);
    targets.push(target);
  }

  return { rawSelection, targets, unresolved };
}

function medianFiniteNumbers(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!nums.length) return 0;

  const mid = Math.floor(nums.length / 2);
  return nums.length % 2
    ? nums[mid]
    : (nums[mid - 1] + nums[mid]) / 2;
}

function alphabeticalFrameCompare(a, b) {
  return String(a.name || "").localeCompare(
    String(b.name || ""),
    undefined,
    { numeric: true, sensitivity: "base" }
  );
}

function canvasSlotsInReadingOrder(nodes) {
  const slots = nodes.map(node => ({
    x: Number(node.x) || 0,
    y: Number(node.y) || 0,
    width: Number(node.width) || 0,
    height: Number(node.height) || 0
  }));

  if (slots.length <= 1) return slots;

  const medianHeight = medianFiniteNumbers(slots.map(slot => slot.height));
  const rowTolerance = Math.max(8, medianHeight * 0.28);

  const byY = [...slots].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const rows = [];

  for (const slot of byY) {
    let bestRow = null;
    let bestDistance = Infinity;

    for (const row of rows) {
      const distance = Math.abs(slot.y - row.meanY);
      if (distance <= rowTolerance && distance < bestDistance) {
        bestRow = row;
        bestDistance = distance;
      }
    }

    if (!bestRow) {
      rows.push({ meanY: slot.y, items: [slot] });
      continue;
    }

    bestRow.items.push(slot);
    bestRow.meanY =
      bestRow.items.reduce((sum, item) => sum + item.y, 0) /
      bestRow.items.length;
  }

  rows.sort((a, b) => a.meanY - b.meanY);

  const ordered = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    ordered.push(...row.items);
  }

  return ordered;
}


function groupCanvasSlotsIntoRows(nodes) {
  const slots = nodes.map(node => ({
    node,
    x: Number(node.x) || 0,
    y: Number(node.y) || 0,
    width: Number(node.width) || 0,
    height: Number(node.height) || 0
  }));

  if (!slots.length) return [];

  const medianHeight = medianFiniteNumbers(slots.map(slot => slot.height)) || 1;
  const rowTolerance = Math.max(8, medianHeight * 0.28);
  const byY = [...slots].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const rows = [];

  for (const slot of byY) {
    let bestRow = null;
    let bestDistance = Infinity;

    for (const row of rows) {
      const distance = Math.abs(slot.y - row.meanY);
      if (distance <= rowTolerance && distance < bestDistance) {
        bestRow = row;
        bestDistance = distance;
      }
    }

    if (!bestRow) {
      rows.push({ meanY: slot.y, items: [slot] });
      continue;
    }

    bestRow.items.push(slot);
    bestRow.meanY =
      bestRow.items.reduce((sum, item) => sum + item.y, 0) /
      bestRow.items.length;
  }

  rows.sort((a, b) => a.meanY - b.meanY);
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);

  return rows;
}

function inferCompactGapX(rows, medianWidth) {
  const gaps = [];
  const reasonableMax = Math.max(80, medianWidth * 0.75);

  for (const row of rows) {
    for (let i = 0; i < row.items.length - 1; i++) {
      const a = row.items[i];
      const b = row.items[i + 1];
      const gap = b.x - (a.x + a.width);

      if (Number.isFinite(gap) && gap >= 0 && gap <= reasonableMax) {
        gaps.push(gap);
      }
    }
  }

  const detected = medianFiniteNumbers(gaps);
  return detected === null || detected === undefined
    ? 24
    : Math.max(0, Math.min(120, detected));
}

function inferCompactGapY(rows, medianHeight) {
  if (rows.length < 2) return 24;

  const gaps = [];
  const reasonableMax = Math.max(80, medianHeight * 0.75);

  for (let i = 0; i < rows.length - 1; i++) {
    const current = rows[i].items;
    const next = rows[i + 1].items;

    if (!current.length || !next.length) continue;

    const currentBottom = Math.max(...current.map(item => item.y + item.height));
    const nextTop = Math.min(...next.map(item => item.y));
    const gap = nextTop - currentBottom;

    if (Number.isFinite(gap) && gap >= 0 && gap <= reasonableMax) {
      gaps.push(gap);
    }
  }

  const detected = medianFiniteNumbers(gaps);
  return detected === null || detected === undefined
    ? 24
    : Math.max(0, Math.min(120, detected));
}

function compactGridPlan(nodes, settings = {}) {
  const rows = groupCanvasSlotsIntoRows(nodes);
  const slots = rows.flatMap(row => row.items);

  if (!slots.length) {
    return {
      columns: 1,
      anchorX: 0,
      anchorY: 0,
      cellWidth: 1,
      cellHeight: 1,
      gapX: 24,
      gapY: 24
    };
  }

  const widths = slots.map(slot => slot.width).filter(Number.isFinite);
  const heights = slots.map(slot => slot.height).filter(Number.isFinite);

  const medianWidth = medianFiniteNumbers(widths) || 1;
  const medianHeight = medianFiniteNumbers(heights) || 1;
  const cellWidth = Math.max(...widths, medianWidth);
  const cellHeight = Math.max(...heights, medianHeight);

  // Preserve existing row capacity in Auto mode, or use the explicit number
  // of columns requested in the Rename sorting settings.
  const requestedColumns = Math.max(0, Math.floor(Number(settings.columns) || 0));
  let columns = requestedColumns
    ? Math.max(1, Math.min(slots.length, requestedColumns))
    : Math.max(1, ...rows.map(row => row.items.length));

  if (!requestedColumns && columns === 1 && slots.length >= 4) {
    columns = Math.ceil(Math.sqrt(slots.length));
  }

  const requestedGapX = Number(settings.gapX);
  const requestedGapY = Number(settings.gapY);

  return {
    columns,
    anchorX: Math.min(...slots.map(slot => slot.x)),
    anchorY: Math.min(...slots.map(slot => slot.y)),
    cellWidth,
    cellHeight,
    gapX: Number.isFinite(requestedGapX)
      ? Math.max(0, Math.min(1000, requestedGapX))
      : inferCompactGapX(rows, medianWidth),
    gapY: Number.isFinite(requestedGapY)
      ? Math.max(0, Math.min(1000, requestedGapY))
      : inferCompactGapY(rows, medianHeight)
  };
}

async function packOrderedNodesIntoCompactGrid(nodes, orderedNodes, settings = {}) {
  if (!Array.isArray(nodes) || nodes.length < 2) {
    return { moved: 0, chunks: 0 };
  }

  const ordered = Array.isArray(orderedNodes) && orderedNodes.length
    ? orderedNodes
    : [...nodes].sort(alphabeticalFrameCompare);

  const slots = nodes
    .map(node => {
      const box = getAbsBox(node);
      if (!box) return null;
      return {
        node,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height
      };
    })
    .filter(Boolean);

  if (!slots.length) return { moved: 0, chunks: 0 };

  const cellWidth = Math.max(...slots.map(slot => slot.width));
  const cellHeight = Math.max(...slots.map(slot => slot.height));

  const chunkCols = Math.max(
    1,
    Math.min(100, Math.floor(Number(settings.chunkCols) || 10))
  );

  const chunkRows = Math.max(
    1,
    Math.min(100, Math.floor(Number(settings.chunkRows) || 10))
  );

  const cardGap = Math.max(
    0,
    Math.min(1000, Number(settings.cardGap) || 0)
  );

  const chunkGap = Math.max(
    0,
    Math.min(5000, Number(settings.chunkGap) || 0)
  );

  const chunksPerRow = Math.max(
    1,
    Math.min(100, Math.floor(Number(settings.chunksPerRow) || 5))
  );

  const chunkCapacity = chunkCols * chunkRows;

  const chunkWidth =
    chunkCols * cellWidth +
    Math.max(0, chunkCols - 1) * cardGap;

  const chunkHeight =
    chunkRows * cellHeight +
    Math.max(0, chunkRows - 1) * cardGap;

  const anchorX = Math.min(...slots.map(slot => slot.x));
  const anchorY = Math.min(...slots.map(slot => slot.y));

  let moved = 0;

  for (let i = 0; i < ordered.length; i++) {
    if (wasStopRequested()) break;

    const node = ordered[i];

    const chunkIndex = Math.floor(i / chunkCapacity);
    const insideChunk = i % chunkCapacity;

    const chunkCol = chunkIndex % chunksPerRow;
    const chunkRow = Math.floor(chunkIndex / chunksPerRow);

    const localCol = insideChunk % chunkCols;
    const localRow = Math.floor(insideChunk / chunkCols);

    const x =
      anchorX +
      chunkCol * (chunkWidth + chunkGap) +
      localCol * (cellWidth + cardGap);

    const y =
      anchorY +
      chunkRow * (chunkHeight + chunkGap) +
      localRow * (cellHeight + cardGap);

    try {
      node.x = x;
      node.y = y;
      moved++;
    } catch (e) {}

    if (!(await cooperativeYield())) break;
  }

  return {
    moved,
    chunks: Math.ceil(ordered.length / chunkCapacity),
    chunkCols,
    chunkRows,
    chunksPerRow,
    cardGap,
    chunkGap
  };
}

function parentUsesAutoLayout(parent) {
  try {
    return !!parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
  } catch (e) {
    return false;
  }
}

function reorderSelectedChildrenByOrder(parent, nodes, orderedNodes) {
  if (!parent || !("children" in parent) || typeof parent.insertChild !== "function") {
    return false;
  }

  const selectedIds = new Set(nodes.map(node => node.id));
  const ordered = Array.isArray(orderedNodes) ? orderedNodes : nodes;
  const desired = [...parent.children];
  let orderedIndex = 0;

  for (let i = 0; i < desired.length; i++) {
    if (selectedIds.has(desired[i].id)) {
      desired[i] = ordered[orderedIndex++];
    }
  }

  for (let i = 0; i < desired.length; i++) {
    const current = parent.children[i];
    const wanted = desired[i];

    if (!current || !wanted || current.id === wanted.id) continue;

    try {
      parent.insertChild(i, wanted);
    } catch (e) {
      return false;
    }
  }

  return true;
}

function buildTableSortContext(rows) {
  const cleanRows = Array.isArray(rows) ? rows : [];
  const orderByIdentifier = new Map();
  const orderByStrictTitle = new Map();
  const orderByLooseTitle = new Map();
  const indexes = buildIndexes(cleanRows);
  const rowsByIdentifier = new Map();

  for (let i = 0; i < cleanRows.length; i++) {
    const row = cleanRows[i];
    const identifier = String(row.identifier || "").trim();
    const title = String(row.title || "").trim();

    if (identifier && !orderByIdentifier.has(identifier)) {
      orderByIdentifier.set(identifier, i);
      rowsByIdentifier.set(identifier, row);
    }

    const strict = strictNormalize(title);
    const loose = looseNormalize(title);

    if (strict && !orderByStrictTitle.has(strict)) orderByStrictTitle.set(strict, i);
    if (loose && !orderByLooseTitle.has(loose)) orderByLooseTitle.set(loose, i);
  }

  return {
    rows: cleanRows,
    orderByIdentifier,
    orderByStrictTitle,
    orderByLooseTitle,
    indexes,
    rowsByIdentifier
  };
}

function tableOrderIndexForNode(node, context) {
  if (!node || !context) return Infinity;

  const nodeName = String(node.name || "").trim();
  if (context.orderByIdentifier.has(nodeName)) {
    return context.orderByIdentifier.get(nodeName);
  }

  // Reuse the Rename matcher so cards that have not been renamed yet can still
  // follow the table order based on their visible game title.
  try {
    const matched = matchCard(node, context.indexes, context.rowsByIdentifier);
    if (
      matched &&
      matched.status === "matched" &&
      matched.row &&
      context.orderByIdentifier.has(String(matched.row.identifier || "").trim())
    ) {
      return context.orderByIdentifier.get(String(matched.row.identifier || "").trim());
    }
  } catch (e) {}

  // Canonical `title` fallback.
  try {
    const canonical = findCanonicalTitleFrame(node);
    if (canonical) {
      const title = combinedCanonicalTitle(canonical);
      const strict = strictNormalize(title);
      const loose = looseNormalize(title);

      if (context.orderByStrictTitle.has(strict)) {
        return context.orderByStrictTitle.get(strict);
      }
      if (context.orderByLooseTitle.has(loose)) {
        return context.orderByLooseTitle.get(loose);
      }
    }
  } catch (e) {}

  return Infinity;
}

function orderedSortNodes(nodes, mode, rows) {
  if (mode !== "table") {
    return {
      ordered: [...nodes].sort(alphabeticalFrameCompare),
      notInTable: 0
    };
  }

  const context = buildTableSortContext(rows);
  const enriched = nodes.map(node => ({
    node,
    tableIndex: tableOrderIndexForNode(node, context)
  }));

  const notInTable = enriched.filter(item => !Number.isFinite(item.tableIndex)).length;

  enriched.sort((a, b) => {
    const aFound = Number.isFinite(a.tableIndex);
    const bFound = Number.isFinite(b.tableIndex);

    if (aFound && bFound && a.tableIndex !== b.tableIndex) {
      return a.tableIndex - b.tableIndex;
    }
    if (aFound !== bFound) return aFound ? -1 : 1;
    return alphabeticalFrameCompare(a.node, b.node);
  });

  return {
    ordered: enriched.map(item => item.node),
    notInTable
  };
}

async function sortSelectedFrames(rows, settings = {}) {
  const resolved = resolveSortTargets(rows);

  if (!resolved.rawSelection.length) {
    return { error: "Select two or more frames first." };
  }

  if (resolved.targets.length < 2) {
    return { error: "Select at least two sortable frames." };
  }

  const mode = settings.order === "table" ? "table" : "alpha";

  if (mode === "table" && (!Array.isArray(rows) || !rows.length)) {
    return { error: "Paste a table before sorting by table order." };
  }

  const byParent = new Map();

  for (const node of resolved.targets) {
    const parent = node.parent;
    if (!parent) continue;

    const key = parent.id;
    if (!byParent.has(key)) byParent.set(key, { parent, nodes: [] });
    byParent.get(key).nodes.push(node);
  }

  let sorted = 0;
  let groups = 0;
  let notInTable = 0;
  let chunks = 0;

  for (const { parent, nodes } of byParent.values()) {
    if (wasStopRequested()) break;
    if (nodes.length < 2) continue;

    groups++;

    const orderedResult = orderedSortNodes(nodes, mode, rows);
    const ordered = orderedResult.ordered;
    notInTable += orderedResult.notInTable;

    if (parentUsesAutoLayout(parent)) {
      if (reorderSelectedChildrenByOrder(parent, nodes, ordered)) {
        sorted += nodes.length;
      }
    } else {
      const packed = await packOrderedNodesIntoCompactGrid(nodes, ordered, settings);
      sorted += packed.moved;
      chunks += packed.chunks || 0;
    }

    if (!(await cooperativeYield())) break;
  }

  return {
    sorted,
    groups,
    unresolved: resolved.unresolved.length,
    stopped: wasStopRequested(),
    compacted: true,
    order: mode,
    notInTable,
    chunks
  };
}


function titleNodesInVisualOrder(nodes) {
  return [...nodes].sort((a, b) => {
    const ab = getAbsBox(a);
    const bb = getAbsBox(b);

    if (!ab && !bb) return 0;
    if (!ab) return 1;
    if (!bb) return -1;

    return (ab.y - bb.y) || (ab.x - bb.x);
  });
}

function getExistingLineTexts(titleNodes, maxLines) {
  const ordered = titleNodesInVisualOrder(titleNodes);

  if (ordered.length > 1 && ordered.length <= maxLines) {
    const lines = ordered
      .map(node => String(node.characters || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (lines.length > 1) return lines;
  }

  if (ordered.length === 1) {
    const chars = String(ordered[0].characters || "");
    if (chars.includes("\n")) {
      const lines = chars
        .split(/\n+/)
        .map(s => s.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      if (lines.length > 1 && lines.length <= maxLines) return lines;
    }
  }

  return null;
}

function getTemplateFontName(node) {
  if (!node || node.type !== "TEXT" || !node.characters.length) return null;

  for (let i = 0; i < node.characters.length; i++) {
    const fontName = node.getRangeFontName(i, i + 1);
    if (fontName !== figma.mixed) return fontName;
  }

  return null;
}

function getTemplateLetterSpacing(node) {
  if (!node || node.type !== "TEXT" || !node.characters.length) return null;

  for (let i = 0; i < node.characters.length; i++) {
    const value = node.getRangeLetterSpacing(i, i + 1);
    if (value !== figma.mixed) return value;
  }

  return null;
}

function safeAssign(target, key, value) {
  try {
    if (value !== undefined && value !== null && value !== figma.mixed) {
      target[key] = value;
    }
  } catch (e) {}
}

async function createTextLineFromTemplate(template, text) {
  const node = figma.createText();

  // Figma requires the current/default font to be loaded before some text props
  // are changed.
  try {
    const defaultFont = node.fontName;
    if (defaultFont !== figma.mixed) await loadFontCached(defaultFont);
  } catch (e) {}

  const fontName = getTemplateFontName(template);
  if (fontName) {
    await loadFontCached(fontName);
    node.fontName = fontName;
  }

  const baseSize = getNodeMaxFontSize(template) || getMaxFontSize(template) || 32;
  node.fontSize = baseSize;

  const letterSpacing = getTemplateLetterSpacing(template);
  if (letterSpacing) safeAssign(node, "letterSpacing", letterSpacing);

  // Copy the visual text treatment that matters for these banner titles.
  safeAssign(node, "fills", template.fills);
  safeAssign(node, "strokes", template.strokes);
  safeAssign(node, "strokeWeight", template.strokeWeight);
  safeAssign(node, "strokeAlign", template.strokeAlign);
  safeAssign(node, "effects", template.effects);
  safeAssign(node, "opacity", template.opacity);
  safeAssign(node, "blendMode", template.blendMode);
  safeAssign(node, "textCase", template.textCase);
  safeAssign(node, "textDecoration", template.textDecoration);

  node.textAutoResize = "WIDTH_AND_HEIGHT";
  node.characters = text;
  node.textAlignHorizontal = "CENTER";

  // With one line per TextNode, line-height no longer controls spacing between
  // title rows. Auto Layout itemSpacing does.
  try {
    node.lineHeight = { unit: "PERCENT", value: 100 };
  } catch (e) {}

  await applyCapHeightBaseline(node);

  try { node.layoutSizingHorizontal = "HUG"; } catch (e) {}
  try { node.layoutSizingVertical = "HUG"; } catch (e) {}

  return node;
}

async function makeMeasurementNode(template, text) {
  const node = figma.createText();

  try {
    const defaultFont = node.fontName;
    if (defaultFont !== figma.mixed) await loadFontCached(defaultFont);
  } catch (e) {}

  const fontName = getTemplateFontName(template);
  if (fontName) {
    await loadFontCached(fontName);
    node.fontName = fontName;
  }

  node.fontSize = getNodeMaxFontSize(template) || getMaxFontSize(template) || 32;

  const letterSpacing = getTemplateLetterSpacing(template);
  if (letterSpacing) safeAssign(node, "letterSpacing", letterSpacing);

  node.textAutoResize = "WIDTH_AND_HEIGHT";
  node.characters = text;
  node.visible = false;

  return node;
}

async function calculateAutoLayoutLines(
  titleNodes,
  fullTitle,
  targetWidth,
  rowCount,
  forceRebuild = false,
  exactRows = false
) {
  const existing =
    forceRebuild
      ? null
      : getExistingLineTexts(titleNodes, rowCount);

  if (existing && titleNodes.length > 1) return existing;
  if (existing && !exactRows) return existing;

  const cleanTitle = String(fullTitle || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanTitle) return [];

  const template = titleNodesInVisualOrder(titleNodes)[0];
  const temp = await makeMeasurementNode(template, cleanTitle);

  try {
    const words = getSmartWords(temp);

    if (words.length <= 1) return [cleanTitle];

    const measured = await measureSmartWords(temp, words);
    if (!measured) return [];

    const best =
      exactRows
        ? chooseExactSmartBreaks(measured, targetWidth, rowCount)
        : chooseSmartBreaks(measured, targetWidth, rowCount);

    if (!best || !best.cuts) return [];

    const resultLines = buildSmartText(measured, best.cuts)
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);

    girCacheTitleFitRows(cacheKey, resultLines);
    return resultLines;
  } finally {
    temp.remove();
  }
}

function findExistingTitleAutoLayout(titleNodes) {
  if (!titleNodes.length) return null;

  const parent = titleNodes[0].parent;

  if (
    parent &&
    isCanonicalTitleFrame(parent) &&
    titleNodes.every(node => node.parent && node.parent.id === parent.id)
  ) {
    return parent;
  }

  return null;
}

function retireOriginalTitleNodes(titleNodes, card, reusableFrame) {
  for (const node of titleNodes) {
    // Never remove freshly created lines inside the reusable frame.
    if (reusableFrame && node.parent && node.parent.id !== reusableFrame.id) continue;

    try {
      node.remove();
    } catch (e) {
      // Structural edits inside an Instance are not allowed. We reject those
      // earlier, but keep this as a defensive fallback.
      try { node.visible = false; } catch (e2) {}
    }
  }
}

function positionTitleFrameLikeOriginal(frame, beforeBox) {
  if (!frame || !beforeBox) return;

  const after = getAbsBox(frame);
  if (!after) return;

  const beforeCenterX = beforeBox.x + beforeBox.width / 2;
  const beforeBottom = beforeBox.y + beforeBox.height;
  const afterCenterX = after.x + after.width / 2;
  const afterBottom = after.y + after.height;

  frame.x += beforeCenterX - afterCenterX;
  frame.y += beforeBottom - afterBottom;
}

async function convertCardTitleToAutoLayout(card, rows, options) {
  if (!canHostAutoLayoutTitle(card)) {
    return {
      error: card && card.type === "INSTANCE"
        ? "Card is an Instance. Auto Layout structure cannot be added inside an Instance."
        : "Selected card cannot contain an Auto Layout title."
    };
  }

  const match = findTitleForNormalize(card, rows);
  if (!match) return { error: "Title layer not found." };

  const titleNodes = getTitleNodes(match).filter(node => node && node.type === "TEXT");
  if (!titleNodes.length) return { error: "Title layer not found." };

  const sourceInsideInstance = titleNodes.some(node => isInsideInstance(node, card));

  const currentContainer = titleContainerFromMatch(match);
  const beforeBox = currentContainer ? getAbsBox(currentContainer) : unionBoxes(titleNodes);
  if (!beforeBox) return { error: "Could not read title bounds." };

  const targetWidth = availableTitleWidth(card, options.paddingPercent);
  if (!targetWidth) return { error: "Could not read title/card bounds." };

  const ordered = titleNodesInVisualOrder(titleNodes);
  const template = ordered[0];

  const fullTitle =
    (match.row && match.row.title)
      ? match.row.title
      : ordered.map(n => String(n.characters || "").trim()).filter(Boolean).join(" ");

  const sourceIsSingleTextLayer = titleNodes.length === 1;

  const lines = await calculateAutoLayoutLines(
    titleNodes,
    fullTitle,
    targetWidth,
    options.rowCount || options.maxLines,
    options.forceRebuild === true,
    options.exactRows === true && sourceIsSingleTextLayer
  );

  if (!lines.length) return { error: "Could not calculate title lines." };

  const existingFrame = findExistingTitleAutoLayout(titleNodes);
  const titleFrame = existingFrame || figma.createFrame();

  if (!existingFrame) {
    titleFrame.name = "title";
    titleFrame.fills = [];
    titleFrame.strokes = [];
    titleFrame.clipsContent = false;

    card.appendChild(titleFrame);

    // Banner cards often use Auto Layout at the card level while title text is
    // positioned as an overlay. Keep the new Title block absolute in that case.
    try {
      if ("layoutMode" in card && card.layoutMode !== "NONE") {
        titleFrame.layoutPositioning = "ABSOLUTE";
      }
    } catch (e) {}
  }

  configureCanonicalTitleFrame(titleFrame, options.gap);

  const newLineNodes = [];

  try {
    for (let i = 0; i < lines.length; i++) {
      if (wasStopRequested()) throw new Error("Operation stopped.");

      const lineText = lines[i];
      const line = await createTextLineFromTemplate(template, lineText);
      line.name = `строка ${i + 1}`;

      titleFrame.appendChild(line);

      await fitTextNodeWhole(
        line,
        targetWidth,
        options.minFontSize,
        options.maxFontSize
      );

      try {
        line.lineHeight = { unit: "PERCENT", value: 100 };
      } catch (e) {}

      newLineNodes.push(line);

      if (!(await cooperativeYield())) throw new Error("Operation stopped.");
    }

    // Retire the legacy source only AFTER all replacement lines were built.
    //
    // For a normal card child, remove it.
    // For card -> nested Instance -> Text, keep the Instance attached and hide
    // the old text via an override.
    const sourceNodes = titleNodes.filter(
      oldNode => !newLineNodes.some(newNode => newNode.id === oldNode.id)
    );

    const retired = await retireLegacyTitleNodes(sourceNodes, card);

    if (!retired.ok) {
      throw new Error(retired.reason);
    }

    renameCanonicalLines(titleFrame);
    await applyCapHeightBaselineToTitle(titleFrame);
    positionTitleFrameLikeOriginal(titleFrame, beforeBox);

    return {
      title: fullTitle,
      identifier: match.row ? match.row.identifier : card.name,
      lines,
      frameId: titleFrame.id,
      sourceInsideInstance
    };
  } catch (e) {
    // If this was a newly-created Title frame and conversion failed, remove it
    // rather than leaving a half-built duplicate.
    if (!existingFrame) {
      try { titleFrame.remove(); } catch (e2) {}
    } else {
      // In a reusable frame, remove newly-created children only.
      for (const node of newLineNodes) {
        try { node.remove(); } catch (e2) {}
      }
    }

    return {
      error: e && e.message ? e.message : String(e)
    };
  }
}

async function smartFitTitlesToAutoLayout(rows, options) {
  const resolved = resolveSelectedCards(rows);
  const selection = resolved.cards;

  if (!resolved.rawSelection.length) {
    return { error: "Select target cards or title layers first." };
  }

  if (!selection.length) {
    return { error: "Could not resolve selected layers to card frames." };
  }

  const converted = [];
  const skipped = resolved.unresolved.map(item => ({
    frameName: item.nodeName,
    reason: `Could not resolve ${item.nodeType} to a card frame.`
  }));

  for (const card of selection) {
    if (wasStopRequested()) break;

    const result = await convertCardTitleToAutoLayout(card, rows, options);

    if (result.error) {
      skipped.push({
        frameName: card.name,
        reason: result.error
      });
    } else {
      converted.push({
        frameName: card.name,
        title: result.title,
        identifier: result.identifier,
        lines: result.lines,
        rowCount: result.lines.length,
        sourceInsideInstance: result.sourceInsideInstance === true
      });
    }

    if (!(await cooperativeYield())) break;
  }

  return {
    converted,
    skipped,
    stopped: wasStopRequested(),
    selectedNodes: resolved.rawSelection.length,
    resolvedCards: selection.length
  };
}



function clonePluginValue(value) {
  if (value === undefined || value === null || value === figma.mixed) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return null;
  }
}

function firstRangeValue(node, getterName) {
  if (!node || node.type !== "TEXT" || !node.characters.length) return null;

  for (let i = 0; i < node.characters.length; i++) {
    try {
      const value = node[getterName](i, i + 1);
      if (value !== figma.mixed) return value;
    } catch (e) {}
  }

  return null;
}

async function loadTitleFitTemplate() {
  if (titleFitTemplate) return titleFitTemplate;

  try {
    titleFitTemplate = await figma.clientStorage.getAsync(TITLE_FIT_TEMPLATE_KEY);
  } catch (e) {
    titleFitTemplate = null;
  }

  return titleFitTemplate;
}

async function saveTitleFitTemplate(template) {
  titleFitTemplate = template;

  try {
    await figma.clientStorage.setAsync(TITLE_FIT_TEMPLATE_KEY, template);
  } catch (e) {}

  return template;
}


function medianNumber(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!nums.length) return null;

  const mid = Math.floor(nums.length / 2);

  return nums.length % 2
    ? nums[mid]
    : (nums[mid - 1] + nums[mid]) / 2;
}

function fontSizeForTextNode(node) {
  if (!node || node.type !== "TEXT") return null;

  const range = firstRangeValue(node, "getRangeFontSize");
  const direct = node.fontSize !== figma.mixed ? node.fontSize : null;

  const value = Number(range || direct || getNodeMaxFontSize(node));

  return Number.isFinite(value) && value > 0 ? value : null;
}

function referenceOpticalGapRatio(layoutTarget, sourceText) {
  // Best case: the reference already has multiple separate title rows.
  // Measure the actual vertical space between their boxes and normalize it by
  // the reference font size so the spacing scales with future fitted rows.
  if (layoutTarget && isCanonicalTitleFrame(layoutTarget)) {
    const lines = canonicalTitleLines(layoutTarget)
      .map(node => ({ node, box: getAbsBox(node), size: fontSizeForTextNode(node) }))
      .filter(x => x.box)
      .sort((a, b) => a.box.y - b.box.y);

    if (lines.length >= 2) {
      const gaps = [];

      for (let i = 0; i < lines.length - 1; i++) {
        const a = lines[i].box;
        const b = lines[i + 1].box;
        gaps.push(Math.max(0, b.y - (a.y + a.height)));
      }

      const gap = medianNumber(gaps);
      const size = medianNumber(lines.map(x => x.size));

      if (gap !== null && size) {
        return Math.max(0, Math.min(0.35, gap / size));
      }
    }
  }

  // Second-best case: multiline reference text. Infer a conservative optical
  // spacing ratio from its line-height. This is only a hint, not the final box
  // height, because generated rows use CAP_HEIGHT leading trim.
  if (sourceText && sourceText.type === "TEXT") {
    const size = fontSizeForTextNode(sourceText);
    const lh = firstRangeValue(sourceText, "getRangeLineHeight") ||
      (sourceText.lineHeight !== figma.mixed ? sourceText.lineHeight : null);

    if (size && lh && typeof lh === "object") {
      if (lh.unit === "PIXELS" && Number.isFinite(Number(lh.value))) {
        const extra = Math.max(0, Number(lh.value) - size);
        return Math.max(0, Math.min(0.18, extra / size));
      }

      if (lh.unit === "PERCENT" && Number.isFinite(Number(lh.value))) {
        const extraRatio = Math.max(0, Number(lh.value) / 100 - 1);
        return Math.max(0, Math.min(0.18, extraRatio));
      }
    }
  }

  // Fallback tuned for tight title stacks like:
  // ALOHA!
  // CLUSTER
  // PAYS
  // It produces about 1.5px at 48px and scales with fitted text.
  return 0.032;
}

function medianFinite(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!nums.length) return null;

  const mid = Math.floor(nums.length / 2);
  return nums.length % 2
    ? nums[mid]
    : (nums[mid - 1] + nums[mid]) / 2;
}

async function textVisualInsets(node) {
  if (!node || node.type !== "TEXT") return null;

  let clone = null;

  try {
    clone = node.clone();

    // Remove effects/strokes so render bounds describe the glyphs, not shadows.
    try { clone.effects = []; } catch (e) {}
    try { clone.strokes = []; } catch (e) {}
    try { clone.strokeWeight = 0; } catch (e) {}
    try { clone.opacity = 1; } catch (e) {}
    try { clone.visible = true; } catch (e) {}

    // Move the temporary node away from the artwork.
    try { clone.x = -100000; } catch (e) {}
    try { clone.y = -100000; } catch (e) {}

    await enforceTightCapHeightRow(clone);

    const box = clone.absoluteBoundingBox;
    const render = clone.absoluteRenderBounds;

    if (!box || !render) return null;

    return {
      top: render.y - box.y,
      bottom: (box.y + box.height) - (render.y + render.height)
    };
  } catch (e) {
    return null;
  } finally {
    if (clone) {
      try { clone.remove(); } catch (e) {}
    }
  }
}

async function calibrateTitleVisualGap(titleFrame, desiredVisualGap) {
  const lines = canonicalTitleLines(titleFrame);
  const target = Math.max(0, Math.min(40, Number(desiredVisualGap) || 0));

  if (lines.length < 2) {
    try { titleFrame.itemSpacing = target; } catch (e) {}
    return target;
  }

  const insets = [];

  for (const line of lines) {
    if (wasStopRequested()) return target;

    insets.push(await textVisualInsets(line));

    if (!(await cooperativeYield())) return target;
  }

  const residuals = [];

  for (let i = 0; i < insets.length - 1; i++) {
    const a = insets[i];
    const b = insets[i + 1];

    if (!a || !b) continue;

    residuals.push(
      Math.max(-40, Math.min(80, Number(a.bottom) + Number(b.top)))
    );
  }

  const residual = medianFinite(residuals);

  // Figma Auto Layout allows negative itemSpacing. This lets us compensate
  // for any remaining font-internal whitespace so the visible glyph gap,
  // not just the text-box gap, matches the requested value.
  const itemSpacing =
    residual === null
      ? target
      : Math.max(-40, Math.min(40, target - residual));

  try { titleFrame.itemSpacing = itemSpacing; } catch (e) {}

  return itemSpacing;
}

function finalTitleFitGap(titleFrame, template, overridePx) {
  const explicit = Number(overridePx);

  // Positive override = user wants an exact px gap.
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(0, Math.min(40, explicit));
  }

  const lines = canonicalTitleLines(titleFrame);
  const sizes = lines
    .map(fontSizeForTextNode)
    .filter(Number.isFinite);

  const medianSize = medianNumber(sizes) || Number(template.fontSize) || 32;
  const ratio = Number.isFinite(Number(template.opticalGapRatio))
    ? Number(template.opticalGapRatio)
    : 0.032;

  // Keep it visually tight. With typical 36–50px title rows this lands
  // around 1–2px, matching the supplied reference.
  return Math.max(0, Math.min(6, Math.round(medianSize * ratio * 10) / 10));
}

function titleFitTemplateSummary(template) {
  if (!template) return null;

  return {
    fontFamily: template.fontName ? template.fontName.family : "",
    fontStyle: template.fontName ? template.fontName.style : "",
    fontSize: template.fontSize,
    letterSpacing: template.letterSpacing,
    lineHeight: template.lineHeight,
    referenceText: template.referenceText,
    bottomOffset: template.bottomOffset,
    centerOffsetX: template.centerOffsetX,
    leftOffset: template.leftOffset,
    opticalGapRatio: template.opticalGapRatio
  };
}

async function captureTitleFitTemplateFromSelection(rows) {
  const selection = [...figma.currentPage.selection];

  if (selection.length !== 1) {
    return { error: "Select exactly one reference text layer or one reference card." };
  }

  const selected = selection[0];
  const card = resolveOwningCard(selected, rows);

  if (!card) {
    return { error: "Could not resolve the reference selection to a card." };
  }

  let sourceText = null;
  let layoutTarget = null;

  if (selected.type === "TEXT") {
    sourceText = selected;

    if (selected.parent && isCanonicalTitleFrame(selected.parent)) {
      layoutTarget = selected.parent;
    } else {
      layoutTarget = selected;
    }
  } else if (isCanonicalTitleFrame(selected)) {
    const lines = canonicalTitleLines(selected);
    sourceText = lines[0] || null;
    layoutTarget = selected;
  } else {
    const match = findTitleForNormalize(card, rows);

    if (match) {
      const nodes = getTitleNodes(match);
      sourceText = nodes[0] || null;
      layoutTarget = titleContainerFromMatch(match) || sourceText;
    }
  }

  if (!sourceText || sourceText.type !== "TEXT") {
    return { error: "Could not find a reference title text layer." };
  }

  try {
    await loadAllFontsInTextNode(sourceText);
  } catch (e) {}

  const cardBox = getAbsBox(card);
  const targetBox = getAbsBox(layoutTarget || sourceText);

  if (!cardBox || !targetBox) {
    return { error: "Could not read reference bounds." };
  }

  const fontName = firstRangeValue(sourceText, "getRangeFontName") || sourceText.fontName;
  const fontSize =
    Number(firstRangeValue(sourceText, "getRangeFontSize")) ||
    Number(getNodeMaxFontSize(sourceText)) ||
    32;

  const letterSpacing =
    firstRangeValue(sourceText, "getRangeLetterSpacing") ||
    (sourceText.letterSpacing !== figma.mixed ? sourceText.letterSpacing : null);

  const lineHeight =
    firstRangeValue(sourceText, "getRangeLineHeight") ||
    (sourceText.lineHeight !== figma.mixed ? sourceText.lineHeight : null);

  const template = {
    version: 2,
    referenceText: String(sourceText.characters || "").replace(/\s+/g, " ").trim(),
    opticalGapRatio: referenceOpticalGapRatio(layoutTarget, sourceText),
    fontName: clonePluginValue(fontName),
    fontSize,
    letterSpacing: clonePluginValue(letterSpacing),
    lineHeight: clonePluginValue(lineHeight),
    fills: clonePluginValue(sourceText.fills),
    strokes: clonePluginValue(sourceText.strokes),
    strokeWeight: clonePluginValue(sourceText.strokeWeight),
    strokeAlign: clonePluginValue(sourceText.strokeAlign),
    effects: clonePluginValue(sourceText.effects),
    opacity: Number(sourceText.opacity),
    blendMode: sourceText.blendMode,
    textCase: sourceText.textCase,
    textDecoration: sourceText.textDecoration,
    textAlignHorizontal: sourceText.textAlignHorizontal,
    centerOffsetX:
      (targetBox.x + targetBox.width / 2) - cardBox.x,
    leftOffset:
      targetBox.x - cardBox.x,
    bottomOffset:
      (cardBox.y + cardBox.height) - (targetBox.y + targetBox.height)
  };

  await saveTitleFitTemplate(template);

  return {
    template,
    summary: titleFitTemplateSummary(template),
    cardName: card.name
  };
}

async function applySavedTitleFitStyle(node, template, text) {
  if (!node || node.type !== "TEXT") return;

  try {
    const defaultFont = node.fontName;
    if (defaultFont !== figma.mixed) await loadFontCached(defaultFont);
  } catch (e) {}

  if (template.fontName) {
    try {
      await loadFontCached(template.fontName);
      node.fontName = template.fontName;
    } catch (e) {
      throw new Error(
        `Could not load template font ${template.fontName.family} ${template.fontName.style}.`
      );
    }
  }

  node.fontSize = Number(template.fontSize) || 32;
  node.textAutoResize = "WIDTH_AND_HEIGHT";
  node.characters = String(text || "");

  // All title rows are center aligned. The title frame centers its children,
  // so shorter rows stay visually centered under the longest row.
  node.textAlignHorizontal = "CENTER";

  if (template.letterSpacing) safeAssign(node, "letterSpacing", template.letterSpacing);

  // Row height is intentionally NOT copied from the reference line-height.
  // Every generated row must hug from Cap Height to Baseline, like the
  // user's Figma reference. Inter-row spacing is handled only by Auto Layout Gap.
  try { node.lineHeight = { unit: "AUTO" }; } catch (e) {}

  safeAssign(node, "fills", template.fills);
  safeAssign(node, "strokes", template.strokes);
  safeAssign(node, "strokeWeight", template.strokeWeight);
  safeAssign(node, "strokeAlign", template.strokeAlign);
  safeAssign(node, "effects", template.effects);
  safeAssign(node, "opacity", template.opacity);
  safeAssign(node, "blendMode", template.blendMode);
  safeAssign(node, "textCase", template.textCase);
  safeAssign(node, "textDecoration", template.textDecoration);

  // Fast setup only. Full glyph-bound calibration is deferred until the final
  // font size is known, avoiding repeated clone/render-bound measurements.
  await enforceFastTitleRowGeometry(node);
}

async function makeTitleFitMeasurementNode(template, text) {
  const node = figma.createText();

  await applySavedTitleFitStyle(node, template, text);
  node.visible = false;

  return node;
}

function findCardBackgroundNode(card) {
  if (!card || !("children" in card)) return null;

  // Direct Background is the canonical structure used in these cards.
  for (const child of card.children) {
    const name = String(child.name || "").trim().toLocaleLowerCase();

    if (
      name === "background" ||
      name === "bg" ||
      name === "фон"
    ) {
      const box = getAbsBox(child);
      if (box && box.width > 1 && box.height > 1) return child;
    }
  }

  // Fallback: inspect only a shallow nested level. Avoid using the title itself.
  for (const child of card.children) {
    if (!child || !("children" in child)) continue;
    if (String(child.name || "").trim().toLocaleLowerCase() === "title") continue;

    for (const nested of child.children) {
      const name = String(nested.name || "").trim().toLocaleLowerCase();

      if (
        name === "background" ||
        name === "bg" ||
        name === "фон"
      ) {
        const box = getAbsBox(nested);
        if (box && box.width > 1 && box.height > 1) return nested;
      }
    }
  }

  return null;
}

function getCardVisualBoundaryBox(card) {
  if (!card) return null;

  const box = getAbsBox(card);
  if (!box) return null;

  // IMPORTANT:
  // Background / artwork may intentionally extend outside the card frame.
  // Title Fit must always follow the actual CARD FRAME bounds.
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    source: "frame"
  };
}

function availableTitleWidthPx(card, sidePadding) {
  const box = getCardVisualBoundaryBox(card);
  if (!box) return null;

  const padding = Math.max(0, Number(sidePadding) || 0);
  return Math.max(1, box.width - padding * 2);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function partitionLineMeta(words, cuts) {
  const result = [];
  let start = 0;

  for (const cut of cuts) {
    const slice = words.slice(start, cut);
    result.push({
      words: slice,
      text: slice.map(w => w.text).join(" "),
      wordCount: slice.length,
      charCount: slice.reduce((sum, w) => sum + String(w.text || "").length, 0)
    });
    start = cut;
  }

  return result;
}

function adaptiveCandidateStats(candidate, maxFontSize) {
  const fitted = Array.isArray(candidate && candidate.fittedSizes)
    ? candidate.fittedSizes.filter(n => Number.isFinite(n))
    : [];
  const fills = Array.isArray(candidate && candidate.fillRatios)
    ? candidate.fillRatios.filter(n => Number.isFinite(n))
    : [];

  const meanSize = fitted.length
    ? fitted.reduce((a, b) => a + b, 0) / fitted.length
    : 0;
  const minSize = fitted.length ? Math.min(...fitted) : 0;
  const meanFill = fills.length
    ? fills.reduce((a, b) => a + b, 0) / fills.length
    : 0;
  const minFill = fills.length ? Math.min(...fills) : 0;

  return {
    meanSize,
    minSize,
    meanFill,
    minFill,
    sizeRatio: maxFontSize > 0 ? meanSize / maxFontSize : 0
  };
}

function pickPreferredAdaptiveCandidate(bestByLineCount, words, maxFontSize) {
  const one = bestByLineCount.get(1) || null;
  const two = bestByLineCount.get(2) || null;
  const three = bestByLineCount.get(3) || null;

  if (!Array.isArray(words) || !words.length) {
    return one || two || three || null;
  }

  // One actual word stays on one row and can grow up to Max Font.
  if (words.length === 1) {
    return one || null;
  }

  // Reference-style rule:
  // any multi-word title should use at least 2 rows.
  // This is intentional for short titles such as:
  // TIKI TIKI BOOM, DRAGON SHIP, FIRE JOKER, AUTO ROULETTE.
  if (words.length === 2) {
    return two || one || null;
  }

  // 3+ words: start from the best 2-row composition.
  let best = two || three || one || null;

  if (!three || !two) {
    return best;
  }

  const s2 = adaptiveCandidateStats(two, maxFontSize);
  const s3 = adaptiveCandidateStats(three, maxFontSize);

  const totalChars = words.reduce(
    (sum, word) => sum + String(word.text || "").length,
    0
  );

  const sizeGain =
    s2.meanSize > 0
      ? s3.meanSize / s2.meanSize
      : 1;

  const minSizeGain =
    s2.minSize > 0
      ? s3.minSize / s2.minSize
      : 1;

  const twoNeedsTooSmallText =
    s2.minSize < maxFontSize * 0.58;

  const threeIsUsable =
    s3.minFill >= 0.38 &&
    s3.meanFill >= 0.58;

  const clearlyBetterInThree =
    sizeGain >= 1.16 ||
    minSizeGain >= 1.22;

  const longTitleBenefitsFromThree =
    totalChars >= 24 &&
    sizeGain >= 1.09;

  // Move to 3 rows only when it clearly improves readability.
  // Otherwise keep the cleaner 2-row layout.
  if (
    threeIsUsable &&
    (
      (twoNeedsTooSmallText && sizeGain >= 1.06) ||
      clearlyBetterInThree ||
      longTitleBenefitsFromThree
    )
  ) {
    best = three;
  }

  return best;
}

function estimateAdaptivePartitionScore(
  words,
  cuts,
  widths,
  targetWidth,
  baseFontSize,
  minFontSize,
  maxFontSize
) {
  const lines = partitionLineMeta(words, cuts);
  const fittedSizes = [];
  const fillRatios = [];
  const projectedWidths = [];

  let score = 0;

  for (let i = 0; i < widths.length; i++) {
    const width = Math.max(0.001, widths[i]);
    const required = baseFontSize * (targetWidth / width);
    const fitted = clampNumber(required, minFontSize, maxFontSize);
    const projectedWidth = width * (fitted / baseFontSize);
    const fill = projectedWidth / targetWidth;

    fittedSizes.push(fitted);
    fillRatios.push(fill);
    projectedWidths.push(projectedWidth);

    if (required < minFontSize) {
      const overflow = Math.max(0, projectedWidth - targetWidth) / targetWidth;
      score += 2200 + overflow * overflow * 6000;
    }

    const idealFill = 0.94;
    if (fill < idealFill) {
      const underfill = idealFill - Math.max(0, fill);
      score += underfill * underfill * 430;
    }

    const meta = lines[i];
    const text = String(meta.text || '').trim();
    const isNumericOnly = /^\d+[.,]?\d*$/.test(text);
    const isLast = i === widths.length - 1;

    if (meta.wordCount === 1 && !isNumericOnly) {
      // Single-word rows are acceptable and common in the target style.
      // Only penalize extremely tiny 1–2 character orphan rows.
      if (meta.charCount <= 2 && fill < 0.32) {
        score += 180;
      }
    }

    if (isLast && !isNumericOnly) {
      // The reference intentionally allows short last rows when they can
      // become larger (e.g. SHIP, TOAD, GEMS, REWIND).
      if (meta.wordCount === 1 && meta.charCount <= 2 && fill < 0.28) {
        score += 120;
      }
    }
  }

  const meanSize = fittedSizes.reduce((a, b) => a + b, 0) / fittedSizes.length;
  const minSize = Math.min(...fittedSizes);
  const maxSize = Math.max(...fittedSizes);
  const minFill = Math.min(...fillRatios);
  const meanFill = fillRatios.reduce((a, b) => a + b, 0) / fillRatios.length;

  score += (1 - clampNumber(minSize / maxFontSize, 0, 1)) * 220;
  score += (1 - clampNumber(meanSize / maxFontSize, 0, 1)) * 110;

  if (fittedSizes.length > 1 && meanSize > 0) {
    const lowerTail = fittedSizes
      .map(size => Math.max(0, (meanSize - size) / meanSize))
      .reduce((sum, x) => sum + x * x, 0);
    score += lowerTail * 240;
  }

  if (fittedSizes.length > 1 && minSize > 0) {
    const spreadRatio = maxSize / minSize;
    if (spreadRatio > 1.32) {
      score += (spreadRatio - 1.32) * 180;
    }
  }

  score +=
    fillRatios.reduce((sum, fill) => sum + (fill - meanFill) * (fill - meanFill), 0) *
    78;

  if (minFill < 0.5) {
    score += (0.5 - minFill) * 220;
  }

  score += widths.length * 14;
  score -= clampNumber(meanFill, 0, 1.05) * 22;

  return {
    score,
    fittedSizes,
    fillRatios,
    projectedWidths,
    lines
  };
}


function existingTitleRowCount(source) {
  if (!source) return 0;

  if (source.container && isCanonicalTitleFrame(source.container)) {
    const rows = canonicalTitleLines(source.container);
    if (rows.length) return rows.length;
  }

  const nodes = Array.isArray(source.titleNodes)
    ? source.titleNodes.filter(node => node && node.type === "TEXT")
    : [];

  if (nodes.length > 1) return nodes.length;

  if (nodes.length === 1) {
    const text = String(nodes[0].characters || "");
    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    return Math.max(1, lines.length);
  }

  return 0;
}

function girTitleFitTemplateKey(template) {
  if (!template) return '';

  let fontName = '';
  try { fontName = girFontKey(template.fontName); } catch (e) {}

  let letterSpacing = '';
  try { letterSpacing = girLetterSpacingKey(template.letterSpacing); } catch (e) {}

  return [
    fontName,
    Number(template.fontSize) || 0,
    letterSpacing,
    String(template.textCase || '')
  ].join('\u0002');
}

function girTitleFitRowsCacheKey(
  cleanTitle,
  template,
  targetWidth,
  minFontSize,
  maxFontSize,
  maxRowsLimit,
  forceExactRows
) {
  return [
    cleanTitle,
    girTitleFitTemplateKey(template),
    Math.round((Number(targetWidth) || 0) * 2) / 2,
    Number(minFontSize) || 0,
    Number(maxFontSize) || 0,
    Number(maxRowsLimit) || 3,
    forceExactRows ? 1 : 0
  ].join('\u0001');
}

function girCacheTitleFitRows(key, lines) {
  if (!key || !Array.isArray(lines)) return;

  if (girTitleFitRowsCache.size >= GIR_TITLE_FIT_ROWS_CACHE_LIMIT) {
    const firstKey = girTitleFitRowsCache.keys().next().value;
    if (firstKey !== undefined) girTitleFitRowsCache.delete(firstKey);
  }

  girTitleFitRowsCache.set(key, [...lines]);
}

async function calculateTitleFitRows(
  fullTitle,
  template,
  targetWidth,
  minFontSize,
  maxFontSize,
  maxRowsLimit = 3,
  forceExactRows = false
) {
  const cleanTitle = String(fullTitle || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanTitle) return [];

  const cacheKey = girTitleFitRowsCacheKey(
    cleanTitle,
    template,
    targetWidth,
    minFontSize,
    maxFontSize,
    maxRowsLimit,
    forceExactRows
  );

  const cachedLines = girTitleFitRowsCache.get(cacheKey);
  if (cachedLines) return [...cachedLines];

  const temp = await makeTitleFitMeasurementNode(template, cleanTitle);

  try {
    const words = getSmartWords(temp);

    if (!words.length) return [];
    if (words.length === 1) {
      girCacheTitleFitRows(cacheKey, [cleanTitle]);
      return [cleanTitle];
    }

    const measured = await measureSmartWords(temp, words);
    if (!measured) return [];

    const baseFontSize =
      Number(template.fontSize) ||
      Number(getNodeMaxFontSize(temp)) ||
      32;

    const minFont = Math.max(1, Number(minFontSize) || 16);
    const maxFont = Math.max(minFont, Number(maxFontSize) || 48);

    const configuredMaxRows = 3;

    // Normally choose the best layout automatically up to Max Rows.
    // But when an existing title already violates the selected maximum,
    // HARD-ENFORCE the selected value so Apply always visibly fixes it.
    const maxRows = Math.min(configuredMaxRows, measured.length);

    const lineCounts =
      forceExactRows
        ? [maxRows]
        : Array.from({ length: maxRows }, (_, i) => i + 1);

    let best = null;
    const bestByLineCount = new Map();

    for (const lineCount of lineCounts) {
      const candidates =
        lineCount === 1
          ? [[measured.length]]
          : enumeratePartitions(measured.length, lineCount);

      for (const cuts of candidates) {
        const widths = partitionWidths(measured, cuts);

        const evaluated = estimateAdaptivePartitionScore(
          measured,
          cuts,
          widths,
          targetWidth,
          baseFontSize,
          minFont,
          maxFont
        );

        const candidate = {
          ...evaluated,
          cuts,
          lineCount
        };

        const currentForCount = bestByLineCount.get(lineCount);

        if (!currentForCount || candidate.score < currentForCount.score) {
          bestByLineCount.set(lineCount, candidate);
        }

        if (!best || candidate.score < best.score) {
          best = candidate;
        }
      }
    }

    if (!forceExactRows) {
      const preferred = pickPreferredAdaptiveCandidate(
        bestByLineCount,
        measured,
        maxFont
      );

      if (preferred && preferred.cuts) {
        best = preferred;
      }
    }

    if (!best || !best.cuts) return [];

    return buildSmartText(measured, best.cuts)
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);
  } finally {
    try { temp.remove(); } catch (e) {}
  }
}

function titleFitSourceForCard(card, rows) {
  let match = findTitleForNormalize(card, rows);

  const cleanRows = Array.isArray(rows) ? rows : [];
  const byIdentifier =
    getRowContext(cleanRows).firstByIdentifier.get(
      String(card.name || '').trim()
    ) || null;

  if (!match) {
    const heuristic = findTitleHeuristically(card);

    match = heuristic || {
      nodes: [],
      row: byIdentifier || {
        title: String(card.name || ""),
        identifier: String(card.name || "")
      }
    };
  }

  let titleNodes = getTitleNodes(match)
    .filter(node => node && node.type === "TEXT");

  // If the exact/table matcher returned no physical nodes, still try to find
  // the visible legacy title so it can be hidden after the new title is built.
  if (!titleNodes.length) {
    const heuristic = findTitleHeuristically(card);
    if (heuristic) {
      titleNodes = getTitleNodes(heuristic)
        .filter(node => node && node.type === "TEXT");
    }
  }

  const fullTitle =
    (byIdentifier && byIdentifier.title)
      ? String(byIdentifier.title).replace(/\s+/g, " ").trim()
      : match.row && match.row.title
        ? String(match.row.title).replace(/\s+/g, " ").trim()
        : titleNodes
            .map(node => String(node.characters || "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .join(" ");

  if (!fullTitle) return null;

  return {
    match,
    titleNodes,
    container: titleContainerFromMatch(match),
    fullTitle
  };
}

function positionTitleFitFrame(
  frame,
  card,
  template,
  fallbackBox,
  stableCardBox = null
) {
  const cardBox = stableCardBox || getCardVisualBoundaryBox(card);
  const afterBox = getAbsBox(frame);

  if (!cardBox || !afterBox) return;

  const desiredCenterX = cardBox.x + cardBox.width / 2;
  const currentCenterX = afterBox.x + afterBox.width / 2;

  frame.x += desiredCenterX - currentCenterX;

  let desiredBottom = null;

  if (template && Number.isFinite(Number(template.bottomOffset))) {
    desiredBottom =
      cardBox.y +
      cardBox.height -
      Number(template.bottomOffset);
  }

  if (desiredBottom === null && fallbackBox) {
    desiredBottom = fallbackBox.y + fallbackBox.height;
  }

  const updatedBox = getAbsBox(frame);

  if (desiredBottom !== null && updatedBox) {
    frame.y += desiredBottom - (updatedBox.y + updatedBox.height);
  }
}


async function retireTitleFitSource(source, card, newFrame) {
  if (!source) return { ok: true };

  if (!Array.isArray(source.titleNodes) || !source.titleNodes.length) {
    return { ok: true };
  }

  const oldContainer = source.container;

  if (oldContainer && oldContainer.id !== newFrame.id) {
    try {
      oldContainer.remove();
      return { ok: true };
    } catch (e) {}
  }

  const nodes = source.titleNodes.filter(
    node => !node.parent || node.parent.id !== newFrame.id
  );

  return retireLegacyTitleNodes(nodes, card);
}

async function buildTitleFitForCard(card, rows, options, template, previewOnly = false) {
  // Preview must not mutate the file, so for a selected Instance we can use its
  // own dimensions/text directly. Apply will safely wrap it.
  let host = card;
  let wrappedInstance = false;
  let stableCardBox = getAbsBox(card);

  if (!previewOnly) {
    const prepared = await prepareTitleFitHost(card);

    if (prepared.error) {
      return { error: prepared.error };
    }

    host = prepared.host;
    wrappedInstance = prepared.wrappedInstance === true;
    stableCardBox = prepared.stableBox || getAbsBox(host);
  }

  if (!stableCardBox) {
    return { error: "Could not read the card frame bounds." };
  }

  // Resolve the source from the host. For a newly wrapped Instance this still
  // finds the old title inside the nested Instance.
  const source = titleFitSourceForCard(host, rows);

  if (!source) {
    return { error: "Could not determine the game title for this card." };
  }

  const targetWidth = Math.max(
    1,
    stableCardBox.width - Math.max(0, Number(options.sidePadding) || 0) * 2
  );

  const currentRowCount = existingTitleRowCount(source);
  const selectedMaxRows = 3;

  // If the current title has 3 rows and Max Rows = 2, Apply MUST rebuild it
  // to 2 rows. This closes the gap where the setting existed in UI but an
  // already-built title could remain visually unchanged.
  const forceExactRows =
    currentRowCount > selectedMaxRows;

  const lines = await calculateTitleFitRows(
    source.fullTitle,
    template,
    targetWidth,
    options.minFontSize,
    options.maxFontSize,
    selectedMaxRows,
    forceExactRows
  );

  if (!lines.length) {
    return { error: "Could not split the title into rows." };
  }

  if (previewOnly) {
    return {
      title: source.fullTitle,
      lines,
      beforeRows: currentRowCount,
      afterRows: lines.length,
      forcedByMaxRows: forceExactRows,
      gap: Math.max(
        0,
        Math.min(
          40,
          Number.isFinite(Number(options.visualGap))
            ? Number(options.visualGap)
            : 0
        )
      )
    };
  }

  const fallbackBox =
    source.container
      ? getAbsBox(source.container)
      : unionBoxes(source.titleNodes);

  const titleFrame = figma.createFrame();

  titleFrame.name = "title";
  titleFrame.fills = [];
  titleFrame.strokes = [];
  titleFrame.clipsContent = false;

  host.appendChild(titleFrame);

  try {
    if ("layoutMode" in host && host.layoutMode !== "NONE") {
      titleFrame.layoutPositioning = "ABSOLUTE";
    }
  } catch (e) {}

  // Start with zero gap while rows are being built. After font fitting we
  // calculate the final optical gap from the reference/template.
  configureCanonicalTitleFrame(titleFrame, 0);

  // All rows share the same left edge, like:
  // 12 SKULLS
  // OF THE
  // DEAD
  try { titleFrame.counterAxisAlignItems = "CENTER"; } catch (e) {}

  // `title` itself must hug the tight row boxes. No vertical padding:
  // Gap is the only distance between baselines/cap-height row boxes.
  try { titleFrame.paddingTop = 0; } catch (e) {}
  try { titleFrame.paddingBottom = 0; } catch (e) {}
  try { titleFrame.paddingLeft = 0; } catch (e) {}
  try { titleFrame.paddingRight = 0; } catch (e) {}
  try { titleFrame.primaryAxisSizingMode = "AUTO"; } catch (e) {}
  // Horizontal sizing is finalized later to the exact available card width.
  try { titleFrame.counterAxisSizingMode = "AUTO"; } catch (e) {}

  const created = [];

  try {
    for (let i = 0; i < lines.length; i++) {
      if (wasStopRequested()) throw new Error("Operation stopped.");

      const node = figma.createText();
      await applySavedTitleFitStyle(node, template, lines[i]);

      node.name = `строка ${i + 1}`;
      titleFrame.appendChild(node);

      // Keep the v8.1 line-break logic, but force a REAL visual refresh:
      // every new row starts at Max Font and shrinks only if its actual
      // Figma TextNode.width exceeds the available width.
      await maximizeTitleRowToWidth(
        node,
        targetWidth,
        options.minFontSize,
        options.maxFontSize
      );

      created.push(node);

      if (i > 0 && i % 4 === 0) {
        if (!(await cooperativeYield())) {
          throw new Error("Operation stopped.");
        }
      }
    }

    renameCanonicalLines(titleFrame);

    for (const row of canonicalTitleLines(titleFrame)) {
      try { row.textAlignHorizontal = "CENTER"; } catch (e) {}
      // Row is already fitted/tight from the creation pass.
      // Only verify overflow after Auto Layout reflow.
      await guaranteeTitleRowWidth(
        row,
        targetWidth,
        options.minFontSize
      );
    }

    try { titleFrame.counterAxisAlignItems = "CENTER"; } catch (e) {}

    // Every row has already been calibrated to its glyph bounds.
    // Therefore Auto Layout Gap can now be literal and predictable:
    // 0px = rows touch, 4px = exactly 4px between the tight row boxes.
    const literalGap = Math.max(
      0,
      Math.min(40, Number(options.visualGap) || 0)
    );

    try { titleFrame.itemSpacing = literalGap; } catch (e) {}

    // Absolute final safeguard:
    // compare the REAL `title` Auto Layout width to the REAL card frame width.
    // If title is wider, shrink all rows together until the whole Auto Layout
    // fits inside the frame boundaries.
    const frameFit = await fitTitleAutoLayoutToCard(
      titleFrame,
      targetWidth,
      options.minFontSize,
      options.maxFontSize
    );

    positionTitleFitFrame(
      titleFrame,
      host,
      template,
      fallbackBox,
      stableCardBox
    );

    const retired = await retireTitleFitSource(source, host, titleFrame);

    if (!retired.ok) {
      throw new Error(retired.reason || "Could not retire the original title.");
    }

    return {
      title: source.fullTitle,
      lines,
      beforeRows: currentRowCount,
      afterRows: lines.length,
      forcedByMaxRows: forceExactRows,
      cardName: host.name,
      visualGap: Math.max(
        0,
        Math.min(
          40,
          Number.isFinite(Number(options.visualGap))
            ? Number(options.visualGap)
            : 0
        )
      ),
      itemSpacing: (() => {
        try { return titleFrame.itemSpacing; } catch (e) { return 0; }
      })(),
      targetWidth: frameFit ? frameFit.targetWidth : null,
      finalTitleWidth: frameFit ? frameFit.finalWidth : null,
      rowFontSizes: canonicalTitleLines(titleFrame).map(row => ({
        name: row.name,
        size: getNodeMaxFontSize(row)
      })),
      boundarySource: "frame",
      wrappedInstance
    };
  } catch (e) {
    try { titleFrame.remove(); } catch (e2) {}

    return {
      error: e && e.message ? e.message : String(e)
    };
  }
}

async function previewTitleFit(rows, options) {
  const template = await loadTitleFitTemplate();

  if (!template) {
    return { error: 'Title Fit template is not set.' };
  }

  const resolved = resolveSelectedCards(rows);

  if (!resolved.rawSelection.length) {
    return { error: 'Select cards or title text layers first.' };
  }

  if (!resolved.cards.length) {
    return { error: 'Could not resolve selected layers to card frames.' };
  }

  const previewLimit = 5;
  const previewCards = resolved.cards.slice(0, previewLimit);
  const items = [];
  const skipped = [];

  for (let i = 0; i < previewCards.length; i++) {
    if (wasStopRequested()) break;

    const card = previewCards[i];
    const result = await buildTitleFitPreviewImage(
      card,
      rows,
      options,
      template
    );

    if (result.error) {
      skipped.push({ cardName: card.name, reason: result.error });
    } else {
      items.push({
        cardName: card.name,
        before: result.title,
        after: result.lines,
        beforeRows: result.beforeRows,
        afterRows: result.afterRows,
        forcedByMaxRows: result.forcedByMaxRows,
        visualGap: result.visualGap,
        previewBytes: result.previewBytes
      });
    }

    figma.ui.postMessage({
      type: 'titlefit-preview-progress',
      done: i + 1,
      total: previewCards.length,
      selected: resolved.cards.length
    });

    if (!(await cooperativeYield(true))) break;
  }

  return {
    items,
    skipped,
    previewLimit,
    previewedCount: items.length,
    resolvedCards: resolved.cards.length,
    selectedNodes: resolved.rawSelection.length
  };
}

async function applyTitleFit(rows, options) {
  const template = await loadTitleFitTemplate();

  if (!template) {
    return { error: 'Title Fit template is not set.' };
  }

  const resolved = resolveSelectedCards(rows);

  if (!resolved.rawSelection.length) {
    return { error: 'Select cards or title text layers first.' };
  }

  if (!resolved.cards.length) {
    return { error: 'Could not resolve selected layers to card frames.' };
  }

  const changed = [];
  let changedCount = 0;
  const skipped = resolved.unresolved.map(item => ({
    cardName: item.nodeName,
    reason: `Could not resolve ${item.nodeType} to a card.`
  }));
  const batchSize = girBatchSize(resolved.cards.length, 10, 24);
  const progressStep = Math.max(10, Math.min(50, batchSize * 2));

  for (let cardIndex = 0; cardIndex < resolved.cards.length; cardIndex++) {
    if (wasStopRequested()) break;

    const card = resolved.cards[cardIndex];

    const result = await buildTitleFitForCard(
      card,
      rows,
      options,
      template,
      false
    );

    if (result.error) {
      skipped.push({ cardName: card.name, reason: result.error });
    } else {
      changedCount++;

      // UI only needs a few examples. Do not serialize thousands of large
      // result objects back to the browser UI.
      if (changed.length < 8) changed.push(result);
    }

    if (
      cardIndex === 0 ||
      (cardIndex + 1) % progressStep === 0 ||
      cardIndex === resolved.cards.length - 1
    ) {
      figma.ui.postMessage({
        type: 'titlefit-apply-progress',
        processed: cardIndex + 1,
        total: resolved.cards.length,
        changed: changedCount,
        skipped: skipped.length
      });
    }

    if (
      cardIndex > 0 &&
      (cardIndex + 1) % batchSize === 0
    ) {
      if (!(await cooperativeYield(true))) break;
    }
  }

  return {
    changed,
    changedCount,
    skipped,
    stopped: wasStopRequested(),
    resolvedCards: resolved.cards.length,
    selectedNodes: resolved.rawSelection.length
  };
}


function uiLang(msg) {
  return msg && msg.lang === "ru" ? "ru" : "en";
}

function notifyLocalized(msg, ru, en) {
  figma.notify(uiLang(msg) === "ru" ? ru : en);
}


function collectTextDescendants(node, result, seen) {
  if (!node || !result || !seen) return;

  if (node.type === "TEXT") {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      result.push(node);
    }
    return;
  }

  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectTextDescendants(child, result, seen);
    }
  }
}


function normalizeStylePath(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/\\/g, "/")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

function styleMatchesPrefix(styleName, prefix) {
  const name = normalizeStylePath(styleName);
  const p = normalizeStylePath(prefix);
  if (!p) return false;
  return name === p || name.startsWith(p + "/");
}

function hasFillStyleSupport(node) {
  return !!node &&
    "fillStyleId" in node &&
    typeof node.setFillStyleIdAsync === "function";
}

function nodeArea(node) {
  try {
    const box = node.absoluteBoundingBox;
    return box ? Math.max(0, box.width) * Math.max(0, box.height) : 0;
  } catch (e) {
    return 0;
  }
}

function isGradientName(value) {
  const name = String(value || "").trim().toLocaleLowerCase();
  return (
    name === "gradient" ||
    name === "градиент" ||
    name.includes("gradient") ||
    name.includes("градиент")
  );
}

function isContainerNode(node) {
  return !!node && "children" in node && Array.isArray(node.children) && node.children.length > 0;
}

function gradientTargetScore(node, styleIds, insideGradientContainer) {
  if (!hasFillStyleSupport(node)) return -Infinity;

  let score = 0;
  const nameMatches = isGradientName(node.name);
  const styleId = typeof node.fillStyleId === "string" ? node.fillStyleId : "";
  const styleMatches = !!styleId && styleIds.has(styleId);
  const container = isContainerNode(node);

  // The user's structure is commonly:
  //
  // gradient (COMPONENT / INSTANCE / FRAME)
  //   └─ gradient (RECTANGLE)  <-- apply Paint Style HERE
  //
  // Prefer the actual paintable leaf rectangle over its parent container.
  if (node.type === "RECTANGLE") score += 1200;
  else if (!container) score += 450;

  if (insideGradientContainer) score += 900;
  if (nameMatches) score += 650;
  if (styleMatches) score += 750;

  // Strongly de-prioritize components/frames/instances that merely CONTAIN
  // the real gradient rectangle.
  if (container) score -= 1000;

  // We still allow a container as a last-resort target if it is the only
  // fill-capable gradient node in an unusual file structure.
  return score;
}

function collectGradientCandidates(root, styleIds) {
  const candidates = [];

  function walk(node, insideGradientContainer = false, depth = 0) {
    if (!node) return;

    const nodeIsGradientContainer = isGradientName(node.name) && isContainerNode(node);
    const inside = insideGradientContainer || nodeIsGradientContainer;

    if (hasFillStyleSupport(node)) {
      const styleId = typeof node.fillStyleId === "string" ? node.fillStyleId : "";
      const styleMatches = !!styleId && styleIds.has(styleId);
      const nameMatches = isGradientName(node.name);

      // Candidate when:
      // 1) it already uses one of gradient/slots styles;
      // 2) it is named gradient;
      // 3) it is a fillable descendant inside a gradient component/container.
      if (styleMatches || nameMatches || insideGradientContainer) {
        candidates.push({
          node,
          score: gradientTargetScore(node, styleIds, insideGradientContainer),
          depth,
          area: nodeArea(node)
        });
      }
    }

    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child, inside, depth + 1);
      }
    }
  }

  walk(root);

  if (!candidates.length) return [];

  // Priority:
  // - highest semantic score;
  // - then deeper descendants (rectangle inside component);
  // - then larger area.
  candidates.sort((a, b) =>
    (b.score - a.score) ||
    (b.depth - a.depth) ||
    (b.area - a.area)
  );

  return candidates.map(item => item.node);
}

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createBalancedStylePicker(styles, avoidSame) {
  let bag = [];

  function refill() {
    bag = shuffleArray(styles);
  }

  return function pick(currentStyleId) {
    if (!bag.length) refill();

    if (avoidSame && styles.length > 1 && currentStyleId) {
      const index = bag.findIndex(style => style.id !== currentStyleId);
      if (index > 0) {
        [bag[0], bag[index]] = [bag[index], bag[0]];
      } else if (index === -1) {
        refill();
        const nextIndex = bag.findIndex(style => style.id !== currentStyleId);
        if (nextIndex > 0) [bag[0], bag[nextIndex]] = [bag[nextIndex], bag[0]];
      }
    }

    return bag.shift();
  };
}


const gradientColorAnalysisPending = new Map();
let gradientColorAnalysisSeq = 0;

function rgb01ToHsv(color) {
  const r = Math.max(0, Math.min(1, Number(color.r) || 0));
  const g = Math.max(0, Math.min(1, Number(color.g) || 0));
  const b = Math.max(0, Math.min(1, Number(color.b) || 0));

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;

  if (delta > 0.00001) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;

    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max <= 0 ? 0 : delta / max;

  return {
    h,
    s,
    v: max
  };
}

function colorToHex(color) {
  const to255 = value =>
    Math.max(0, Math.min(255, Math.round((Number(value) || 0) * 255)));

  const r = to255(color.r).toString(16).padStart(2, "0");
  const g = to255(color.g).toString(16).padStart(2, "0");
  const b = to255(color.b).toString(16).padStart(2, "0");

  return `#${r}${g}${b}`.toUpperCase();
}

function paintColorCandidates(paint) {
  if (!paint || paint.visible === false) return [];

  if (paint.type === "SOLID" && paint.color) {
    return [{
      color: paint.color,
      alpha:
        Number.isFinite(Number(paint.opacity))
          ? Number(paint.opacity)
          : 1
    }];
  }

  if (
    (
      paint.type === "GRADIENT_LINEAR" ||
      paint.type === "GRADIENT_RADIAL" ||
      paint.type === "GRADIENT_ANGULAR" ||
      paint.type === "GRADIENT_DIAMOND"
    ) &&
    Array.isArray(paint.gradientStops)
  ) {
    return paint.gradientStops.map(stop => ({
      color: stop.color,
      alpha:
        stop.color && Number.isFinite(Number(stop.color.a))
          ? Number(stop.color.a)
          : 1
    }));
  }

  return [];
}

function representativeStyleColor(style) {
  const candidates = [];

  for (const paint of Array.isArray(style.paints) ? style.paints : []) {
    for (const item of paintColorCandidates(paint)) {
      if (!item.color) continue;

      const hsv = rgb01ToHsv(item.color);

      // Prefer the strong chromatic stop of the gradient. A transparent black
      // stop should not become the representative style color.
      const weight =
        0.12 +
        hsv.s * 1.9 +
        hsv.v * 0.45 +
        Math.max(0, Math.min(1, item.alpha)) * 0.15;

      candidates.push({
        color: item.color,
        hsv,
        weight
      });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.weight - a.weight);

  const best = candidates[0];

  return {
    r: best.color.r,
    g: best.color.g,
    b: best.color.b,
    h: best.hsv.h,
    s: best.hsv.s,
    v: best.hsv.v,
    hex: colorToHex(best.color)
  };
}

function hueDistanceDegrees(a, b) {
  const diff = Math.abs(Number(a) - Number(b)) % 360;
  return Math.min(diff, 360 - diff);
}

function gradientColorDistance(source, target) {
  if (!source || !target) return Infinity;

  const hueDistance = hueDistanceDegrees(source.h, target.h) / 180;
  const satDistance = Math.abs(source.s - target.s);
  const valueDistance = Math.abs(source.v - target.v);

  // Hue should drive the choice. Saturation/value then select a closer shade.
  return (
    hueDistance * 3.4 +
    satDistance * 0.8 +
    valueDistance * 0.55
  );
}

function buildGradientStyleColorIndex(styles) {
  return styles
    .map(style => ({
      style,
      representative: representativeStyleColor(style)
    }))
    .filter(item => !!item.representative);
}

function pickClosestGradientStyle(sourceColor, styleIndex) {
  let best = null;

  for (const item of styleIndex) {
    const distance = gradientColorDistance(
      sourceColor,
      item.representative
    );

    if (!best || distance < best.distance) {
      best = {
        ...item,
        distance
      };
    }
  }

  return best;
}

function requestGradientBannerColor(bytes, topPercent) {
  const requestId = `gradient-color-${++gradientColorAnalysisSeq}`;

  return new Promise(resolve => {
    gradientColorAnalysisPending.set(requestId, resolve);

    figma.ui.postMessage({
      type: "gradient-color-analyze-request",
      requestId,
      bytes,
      topPercent
    });
  });
}

async function exportCardForColorAnalysis(card) {
  // A small export is enough for dominant-color detection and makes processing
  // hundreds of cards much faster than full-resolution PNG exports.
  return await card.exportAsync({
    format: "PNG",
    constraint: {
      type: "SCALE",
      value: 0.22
    }
  });
}

async function autoMatchGradientStyles(options) {
  const selection = [...figma.currentPage.selection];

  if (!selection.length) {
    return { error: "Select one or more cards first." };
  }

  const prefix = String(options.prefix || "gradient/slots").trim();
  const styles = await getGradientStyles(prefix);

  if (!styles.length) {
    return {
      error: `No local Paint Styles found under "${prefix}".`,
      stylesFound: 0
    };
  }

  const styleIndex = buildGradientStyleColorIndex(styles);

  if (!styleIndex.length) {
    return {
      error: `No color-readable Paint Styles found under "${prefix}".`,
      stylesFound: styles.length
    };
  }

  const styleIds = new Set(styles.map(style => style.id));
  const topPercent = Math.max(
    35,
    Math.min(95, Number(options.topPercent) || 70)
  );

  const applied = [];
  const skipped = [];

  // Small batches are much faster on hundreds of cards without putting too
  // much export/decode work into one event-loop turn.
  const batchSize = 6;

  for (
    let batchStart = 0;
    batchStart < selection.length;
    batchStart += batchSize
  ) {
    if (wasStopRequested()) break;

    const batch = selection.slice(
      batchStart,
      batchStart + batchSize
    );

    const analyzed = await Promise.all(
      batch.map(async card => {
        if (card.type === "TEXT") {
          return {
            card,
            error: "Selected node is not a card."
          };
        }

        const candidates = collectGradientCandidates(
          card,
          styleIds
        );
        const target = candidates[0];

        if (!target) {
          return {
            card,
            error:
              `No gradient rectangle found inside the card. Expected a layer using "${prefix}" or a Rectangle inside a Gradient component.`
          };
        }

        try {
          const bytes = await exportCardForColorAnalysis(card);
          const colorResult = await requestGradientBannerColor(
            bytes,
            topPercent
          );

          if (
            !colorResult ||
            colorResult.error ||
            !colorResult.color
          ) {
            return {
              card,
              target,
              error:
                colorResult && colorResult.error
                  ? colorResult.error
                  : "Could not detect a banner color."
            };
          }

          return {
            card,
            target,
            color: colorResult.color,
            confidence: colorResult.confidence || 0
          };
        } catch (e) {
          return {
            card,
            target,
            error: e && e.message ? e.message : String(e)
          };
        }
      })
    );

    for (const item of analyzed) {
      if (item.error) {
        skipped.push({
          cardName: item.card ? item.card.name : "Unknown",
          reason: item.error
        });
        continue;
      }

      const matched = pickClosestGradientStyle(
        item.color,
        styleIndex
      );

      if (!matched) {
        skipped.push({
          cardName: item.card.name,
          reason: "No suitable gradient style match was found."
        });
        continue;
      }

      try {
        await item.target.setFillStyleIdAsync(
          matched.style.id
        );

        applied.push({
          cardName: item.card.name,
          layerName: item.target.name,
          styleName: matched.style.name,
          bannerColor: colorToHex(item.color),
          styleColor: matched.representative.hex,
          confidence: item.confidence,
          distance: matched.distance
        });
      } catch (e) {
        skipped.push({
          cardName: item.card.name,
          reason: e && e.message ? e.message : String(e)
        });
      }
    }

    if (!(await cooperativeYield())) break;
  }

  return {
    applied,
    skipped,
    stylesFound: styles.length,
    stopped: wasStopRequested()
  };
}

async function getGradientStyles(prefix) {
  const styles = await figma.getLocalPaintStylesAsync();

  return styles
    .filter(style => styleMatchesPrefix(style.name, prefix))
    .sort((a, b) => {
      const aName = String(a.name);
      const bName = String(b.name);
      const aNum = Number(aName.match(/(\d+)\s*$/)?.[1] || NaN);
      const bNum = Number(bName.match(/(\d+)\s*$/)?.[1] || NaN);

      if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
      return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: "base" });
    });
}

async function randomizeGradientStyles(options) {
  const selection = [...figma.currentPage.selection];
  if (!selection.length) {
    return { error: "Select one or more cards first." };
  }

  const prefix = String(options.prefix || "gradient/slots").trim();
  const styles = await getGradientStyles(prefix);

  if (!styles.length) {
    return {
      error: `No local Paint Styles found under "${prefix}".`,
      stylesFound: 0
    };
  }

  const styleIds = new Set(styles.map(style => style.id));
  const pickStyle = createBalancedStylePicker(styles, options.avoidSame !== false);

  const applied = [];
  const skipped = [];

  for (const card of selection) {
    if (wasStopRequested()) break;

    if (card.type === "TEXT") {
      skipped.push({
        cardName: card.name,
        reason: "Selected node is not a card."
      });
      continue;
    }

    const candidates = collectGradientCandidates(card, styleIds);
    const target = candidates[0];

    if (!target) {
      skipped.push({
        cardName: card.name,
        reason: `No gradient rectangle found inside the card. Expected a layer using "${prefix}" or a Rectangle inside a Gradient component.`
      });
      continue;
    }

    try {
      const currentStyleId =
        typeof target.fillStyleId === "string" ? target.fillStyleId : "";

      const style = pickStyle(currentStyleId);
      if (!style) {
        skipped.push({
          cardName: card.name,
          reason: "No gradient style available."
        });
        continue;
      }

      await target.setFillStyleIdAsync(style.id);

      applied.push({
        cardName: card.name,
        layerName: target.name,
        styleName: style.name
      });
    } catch (e) {
      skipped.push({
        cardName: card.name,
        reason: e && e.message ? e.message : String(e)
      });
    }

    if (!(await cooperativeYield())) break;
  }

  return {
    applied,
    skipped,
    stylesFound: styles.length,
    stopped: wasStopRequested()
  };
}


async function captureGeneratorTitleTemplate(reference, rows) {
  if (!reference) {
    return { error: "Reference card is unavailable." };
  }

  let match = findTitleForNormalize(reference, rows);

  if (!match) {
    match = findTitleHeuristically(reference);
  }

  if (!match) {
    return { error: "Could not find a title in the reference card." };
  }

  const titleNodes = getTitleNodes(match)
    .filter(node => node && node.type === "TEXT");

  const sourceText = titleNodes[0] || null;
  const layoutTarget =
    titleContainerFromMatch(match) ||
    sourceText;

  if (!sourceText || sourceText.type !== "TEXT") {
    return { error: "Could not find a reference title text layer." };
  }

  try {
    await loadAllFontsInTextNode(sourceText);
  } catch (e) {}

  const cardBox = getAbsBox(reference);
  const targetBox = getAbsBox(layoutTarget || sourceText);

  if (!cardBox || !targetBox) {
    return { error: "Could not read reference title bounds." };
  }

  const fontName =
    firstRangeValue(sourceText, "getRangeFontName") ||
    sourceText.fontName;

  const fontSize =
    Number(firstRangeValue(sourceText, "getRangeFontSize")) ||
    Number(getNodeMaxFontSize(sourceText)) ||
    32;

  const letterSpacing =
    firstRangeValue(sourceText, "getRangeLetterSpacing") ||
    (
      sourceText.letterSpacing !== figma.mixed
        ? sourceText.letterSpacing
        : null
    );

  const lineHeight =
    firstRangeValue(sourceText, "getRangeLineHeight") ||
    (
      sourceText.lineHeight !== figma.mixed
        ? sourceText.lineHeight
        : null
    );

  return {
    template: {
      version: 2,
      referenceText:
        String(sourceText.characters || "")
          .replace(/\s+/g, " ")
          .trim(),
      opticalGapRatio:
        referenceOpticalGapRatio(
          layoutTarget,
          sourceText
        ),
      fontName: clonePluginValue(fontName),
      fontSize,
      letterSpacing: clonePluginValue(letterSpacing),
      lineHeight: clonePluginValue(lineHeight),
      fills: clonePluginValue(sourceText.fills),
      strokes: clonePluginValue(sourceText.strokes),
      strokeWeight: clonePluginValue(sourceText.strokeWeight),
      strokeAlign: clonePluginValue(sourceText.strokeAlign),
      effects: clonePluginValue(sourceText.effects),
      opacity: Number(sourceText.opacity),
      blendMode: sourceText.blendMode,
      textCase: sourceText.textCase,
      textDecoration: sourceText.textDecoration,
      textAlignHorizontal: sourceText.textAlignHorizontal,
      centerOffsetX:
        (targetBox.x + targetBox.width / 2) -
        cardBox.x,
      leftOffset:
        targetBox.x - cardBox.x,
      bottomOffset:
        (cardBox.y + cardBox.height) -
        (targetBox.y + targetBox.height)
    }
  };
}

async function setGeneratedTitleFallback(card, title) {
  let match = findTitleForNormalize(card, []);
  if (!match) match = findTitleHeuristically(card);
  if (!match) {
    return { error: "Could not find a title layer in the generated card." };
  }

  const nodes = getTitleNodes(match)
    .filter(node => node && node.type === "TEXT");

  if (!nodes.length) {
    return { error: "Could not find a title Text Layer in the generated card." };
  }

  try {
    await loadAllFontsInTextNode(nodes[0]);
    nodes[0].characters = String(title || "");
  } catch (e) {
    return {
      error:
        e && e.message
          ? e.message
          : "Could not update the generated title."
    };
  }

  for (let i = 1; i < nodes.length; i++) {
    try {
      await loadAllFontsInTextNode(nodes[i]);
      nodes[i].characters = "";
    } catch (e) {
      try { nodes[i].visible = false; } catch (e2) {}
    }
  }

  return { ok: true };
}

function generatorOutputNode(clone, titleResult) {
  if (
    titleResult &&
    titleResult.wrappedInstance === true &&
    clone.parent &&
    clone.parent.type !== "PAGE" &&
    clone.parent.type !== "DOCUMENT"
  ) {
    return clone.parent;
  }

  return clone;
}

async function generateCardsFromTable(rows, options) {
  const cleanRows = prepareSyncRows(rows);

  // Rename page stays reference-free.
  // If a shared reference has never been set, adopt the single selected card
  // automatically when Create from table starts.
  if (!sharedReferenceId) {
    const adopted =
      await setSharedReferenceFromSelection(
        cleanRows
      );

    if (adopted.error) {
      return {
        error:
          "Select exactly one reference card before generating, or set the shared reference in Normalize / Title Fit."
      };
    }
  }

  const reference = await figma.getNodeByIdAsync(sharedReferenceId);

  if (
    !reference ||
    reference.type === "TEXT" ||
    reference.type === "PAGE" ||
    reference.type === "DOCUMENT" ||
    typeof reference.clone !== "function"
  ) {
    sharedReferenceId = null;
    normalizeReferenceId = null;

    return {
      error: "Shared reference is no longer available. Set it again."
    };
  }

  if (!cleanRows.length) {
    return {
      error: "No valid title + identifier rows."
    };
  }

  const templateResult =
    await captureGeneratorTitleTemplate(
      reference,
      cleanRows
    );

  if (templateResult.error) {
    return {
      error: templateResult.error
    };
  }

  const template = templateResult.template;

  const columns = Math.max(
    1,
    Math.min(
      100,
      Number(options.columns) || 8
    )
  );

  const gap = Math.max(
    0,
    Math.min(
      2000,
      Number(options.gap) || 24
    )
  );

  const titleOptions = {
    sidePadding: Math.max(
      0,
      Math.min(
        200,
        Number(options.sidePadding) || 12
      )
    ),
    visualGap: Math.max(
      0,
      Math.min(
        40,
        Number.isFinite(Number(options.visualGap))
          ? Number(options.visualGap)
          : 0
      )
    ),
    minFontSize: Math.max(
      1,
      Number(options.minFontSize) || 16
    ),
    maxFontSize: Math.max(
      1,
      Number(options.maxFontSize) || 48
    )
  };

  if (titleOptions.maxFontSize < titleOptions.minFontSize) {
    titleOptions.maxFontSize = titleOptions.minFontSize;
  }

  const parent = reference.parent;

  if (!parent || !("appendChild" in parent)) {
    return {
      error: "Reference card parent cannot contain generated cards."
    };
  }

  const parentUsesAutoLayout =
    "layoutMode" in parent &&
    parent.layoutMode !== "NONE";

  const referenceIndex =
    "children" in parent
      ? parent.children.findIndex(
          child => child.id === reference.id
        )
      : -1;

  const createdNodes = [];
  const failed = [];
  let titleFallbacks = 0;
  const generatorBatch = girBatchSize(cleanRows.length, 8, 22);
  const generatorProgressStep =
    cleanRows.length >= 1500
      ? 50
      : cleanRows.length >= 400
        ? 25
        : 10;

  for (let i = 0; i < cleanRows.length; i++) {
    if (wasStopRequested()) break;

    const row = cleanRows[i];
    let clone = null;

    try {
      clone = reference.clone();

      if (
        referenceIndex >= 0 &&
        typeof parent.insertChild === "function"
      ) {
        const desiredIndex = Math.min(
          parent.children.length - 1,
          referenceIndex + i + 1
        );

        try {
          parent.insertChild(
            desiredIndex,
            clone
          );
        } catch (e) {}
      }

      clone.name =
        String(row.identifier || "").trim();

      if (!parentUsesAutoLayout) {
        const col = i % columns;
        const gridRow =
          Math.floor(i / columns);

        try {
          clone.x =
            reference.x +
            reference.width +
            gap +
            col * (reference.width + gap);

          clone.y =
            reference.y +
            gridRow * (reference.height + gap);
        } catch (e) {}
      }

      const titleResult =
        await buildTitleFitForCard(
          clone,
          [row],
          titleOptions,
          template,
          false
        );

      if (titleResult.error) {
        const fallback =
          await setGeneratedTitleFallback(
            clone,
            row.title
          );

        if (fallback.error) {
          failed.push({
            title: row.title,
            identifier: row.identifier,
            reason:
              `Card was cloned, but title update failed: ${fallback.error}`
          });
        } else {
          titleFallbacks++;
        }
      }

      const output =
        generatorOutputNode(
          clone,
          titleResult
        );

      // If an Instance was wrapped, make sure the outer generated card keeps
      // the table Identifier.
      try {
        output.name =
          String(row.identifier || "").trim();
      } catch (e) {}

      createdNodes.push(output);

    } catch (e) {
      if (clone) {
        try {
          const candidate =
            clone.parent &&
            clone.parent.type === "FRAME" &&
            clone.parent.name ===
              String(row.identifier || "").trim()
              ? clone.parent
              : clone;

          candidate.remove();
        } catch (e2) {}
      }

      failed.push({
        title: row.title,
        identifier: row.identifier,
        reason:
          e && e.message
            ? e.message
            : String(e)
      });
    }

    if (
      i === 0 ||
      (i + 1) % generatorProgressStep === 0 ||
      i === cleanRows.length - 1
    ) {
      figma.ui.postMessage({
        type: "table-generator-progress",
        created: createdNodes.length,
        total: cleanRows.length,
        referenceName: reference.name
      });
    }

    if (
      i > 0 &&
      (i + 1) % generatorBatch === 0
    ) {
      if (!(await cooperativeYield(true))) break;
    }
  }

  if (createdNodes.length) {
    figma.currentPage.selection =
      createdNodes;

    try {
      figma.viewport.scrollAndZoomIntoView(
        createdNodes.slice(0, 40)
      );
    } catch (e) {}
  }

  return {
    referenceName: reference.name,
    total: cleanRows.length,
    created: createdNodes.length,
    titleFallbacks,
    failed,
    stopped: wasStopRequested()
  };
}


async function exportSharedReferencePreview(card) {
  try {
    const bytes = await card.exportAsync({
      format: "PNG",
      constraint: {
        type: "WIDTH",
        value: 280
      }
    });

    return Array.from(bytes);
  } catch (e) {
    return null;
  }
}

async function exportNodePreviewBytes(node, width = 144) {
  try {
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: {
        type: "WIDTH",
        value: Math.max(80, Math.round(width || 180))
      }
    });

    return Array.from(bytes);
  } catch (e) {
    return null;
  }
}

async function buildTitleFitPreviewImage(card, rows, options, template) {
  if (!card || typeof card.clone !== 'function') {
    return { previewBytes: null, error: 'Preview image is not available for this card.' };
  }

  let previewHost = null;
  let clone = null;

  try {
    // Work inside a short-lived off-canvas frame. This avoids disturbing an
    // Auto Layout parent and keeps preview rendering consistent across systems.
    previewHost = figma.createFrame();
    previewHost.name = '__SlotMasterPreview';
    previewHost.fills = [];
    previewHost.strokes = [];
    previewHost.clipsContent = false;

    try {
      previewHost.resizeWithoutConstraints(
        Math.max(1, Number(card.width) || 1) + 64,
        Math.max(1, Number(card.height) || 1) + 64
      );
    } catch (e) {}

    try {
      previewHost.x = -100000;
      previewHost.y = -100000;
    } catch (e) {}

    clone = card.clone();
    previewHost.appendChild(clone);

    try {
      clone.x = 0;
      clone.y = 0;
    } catch (e) {}

    const built = await buildTitleFitForCard(
      clone,
      rows,
      options,
      template,
      false
    );

    if (built.error) {
      return { error: built.error, previewBytes: null };
    }

    const exportTarget =
      built.wrappedInstance && clone.parent
        ? clone.parent
        : clone;

    const previewBytes = await exportNodePreviewBytes(exportTarget, 144);

    return {
      ...built,
      previewBytes
    };
  } catch (e) {
    return {
      error: e && e.message ? e.message : String(e),
      previewBytes: null
    };
  } finally {
    try {
      if (previewHost && previewHost.removed !== true) {
        previewHost.remove();
      }
    } catch (e) {}
  }
}

async function describeSharedReference(card, rows, refreshTemplate = false) {
  if (
    !card ||
    card.type === "DOCUMENT" ||
    card.type === "PAGE"
  ) {
    return {
      error: "Shared reference is no longer available. Set it again."
    };
  }

  const match =
    findTitleForNormalize(card, rows) ||
    findTitleHeuristically(card);

  if (!match) {
    return {
      error: "Could not identify the title inside this reference card."
    };
  }

  const titleNodes = getTitleNodes(match);
  const titleContainer = titleContainerFromMatch(match);
  const box = getAbsBox(card);

  let templateSummary = null;
  let titleFitReady = false;

  if (refreshTemplate) {
    const templateResult =
      await captureGeneratorTitleTemplate(
        card,
        rows
      );

    if (!templateResult.error) {
      await saveTitleFitTemplate(
        templateResult.template
      );

      templateSummary =
        titleFitTemplateSummary(
          templateResult.template
        );

      titleFitReady = true;
    }
  } else {
    const template =
      await loadTitleFitTemplate();

    if (template) {
      templateSummary =
        titleFitTemplateSummary(
          template
        );
      titleFitReady = true;
    }
  }

  return {
    cardId: card.id,
    frameName: card.name,
    title:
      match.row && match.row.title
        ? match.row.title
        : String(card.name || ""),
    lines: titleNodes.length,
    gap:
      titleContainer &&
      typeof titleContainer.itemSpacing === "number"
        ? titleContainer.itemSpacing
        : null,
    canonical: !!titleContainer,
    frameWidth: box ? box.width : null,
    frameHeight: box ? box.height : null,
    nodeType: card.type,
    titleFitReady,
    titleFitSummary: templateSummary,
    previewBytes:
      await exportSharedReferencePreview(card)
  };
}

async function setSharedReferenceFromSelection(rows) {
  const selection =
    [...figma.currentPage.selection];

  if (selection.length !== 1) {
    return {
      error:
        "Select exactly ONE reference card or one title layer."
    };
  }

  const selected = selection[0];

  const card =
    resolveOwningCard(selected, rows) ||
    (
      isSceneContainer(selected)
        ? selected
        : null
    );

  if (
    !card ||
    card.type === "TEXT" ||
    card.type === "PAGE" ||
    card.type === "DOCUMENT"
  ) {
    return {
      error:
        "Could not resolve the selected layer to a reference card."
    };
  }

  const description =
    await describeSharedReference(
      card,
      rows,
      true
    );

  if (description.error) {
    return description;
  }

  sharedReferenceId = card.id;
  normalizeReferenceId = card.id;

  return description;
}

async function getSharedReferenceInfo(rows) {
  if (!sharedReferenceId) {
    return {
      empty: true
    };
  }

  const card =
    await figma.getNodeByIdAsync(
      sharedReferenceId
    );

  if (!card) {
    sharedReferenceId = null;
    normalizeReferenceId = null;

    return {
      empty: true
    };
  }

  return await describeSharedReference(
    card,
    rows,
    false
  );
}

function currentSelectionInfo(){
  const selection=[...figma.currentPage.selection];

  const frameCount=selection.filter(node => {
    if(!node) return false;
    if(node.type === 'TEXT' || node.type === 'PAGE' || node.type === 'DOCUMENT') return false;
    return isSceneContainer(node);
  }).length;

  return {
    type: 'selection-info',
    count: selection.length,
    frameCount,
    names: selection.slice(0,10).map(node => String(node.name || node.type || ''))
  };
}

function postSelectionInfo(){
  try{
    figma.ui.postMessage(currentSelectionInfo());
  }catch(e){}
}

figma.on('selectionchange', postSelectionInfo);

figma.ui.onmessage = async (msg) => {
  if (msg.type === "set-shared-reference") {
    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map((r,index) => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim(),
        _syncRowKey:
          String(r._syncRowKey ?? "").trim() ||
          `table-row-${index + 1}`
      }))
      .filter(r => r.title && r.identifier);

    const result =
      await setSharedReferenceFromSelection(
        rows
      );

    if (result.error) {
      figma.ui.postMessage({
        type: "shared-reference-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "shared-reference-set",
      ...result
    });

    notifyLocalized(
      msg,
      `Референс задан: ${result.title}`,
      `Reference set: ${result.title}`
    );

    return;
  }

  if (msg.type === "get-shared-reference") {
    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map((r,index) => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim(),
        _syncRowKey:
          String(r._syncRowKey ?? "").trim() ||
          `table-row-${index + 1}`
      }))
      .filter(r => r.title && r.identifier);

    const result =
      await getSharedReferenceInfo(rows);

    figma.ui.postMessage({
      type: "shared-reference-info",
      ...result
    });

    return;
  }

  if (msg.type === "clear-shared-reference") {
    sharedReferenceId = null;
    normalizeReferenceId = null;
    titleFitTemplate = null;

    try {
      await figma.clientStorage.setAsync(
        TITLE_FIT_TEMPLATE_KEY,
        null
      );
    } catch (e) {}

    figma.ui.postMessage({
      type: "shared-reference-cleared"
    });

    notifyLocalized(
      msg,
      "Референс отменён.",
      "Reference cleared."
    );

    return;
  }

  if (msg.type === "select-shared-reference") {
    if (!sharedReferenceId) {
      figma.ui.postMessage({
        type: "shared-reference-error",
        message: "Set the shared reference first."
      });
      return;
    }

    const card =
      await figma.getNodeByIdAsync(
        sharedReferenceId
      );

    if (!card) {
      sharedReferenceId = null;
      normalizeReferenceId = null;

      figma.ui.postMessage({
        type: "shared-reference-error",
        message:
          "Shared reference is no longer available. Set it again."
      });
      return;
    }

    figma.currentPage.selection = [card];

    try {
      figma.viewport.scrollAndZoomIntoView(
        [card]
      );
    } catch (e) {}

    return;
  }

  if (msg.type === "gradient-color-analyze-result") {
    const resolve = gradientColorAnalysisPending.get(msg.requestId);

    if (resolve) {
      gradientColorAnalysisPending.delete(msg.requestId);
      resolve({
        color: msg.color || null,
        confidence: Number(msg.confidence) || 0,
        error: msg.error || null
      });
    }

    return;
  }

  if (msg.type === "load-settings") {
    const settings = await figma.clientStorage.getAsync("gir-settings-v1");
    figma.ui.postMessage({ type: "settings-loaded", settings: settings || null });
    return;
  }

  if (msg.type === "save-settings") {
    await figma.clientStorage.setAsync("gir-settings-v1", msg.settings || {});
    return;
  }

  if (msg.type === "save-and-close") {
    await figma.clientStorage.setAsync("gir-settings-v1", msg.settings || {});
    figma.closePlugin();
    return;
  }

  if (msg.type === "close-plugin") {
    figma.closePlugin();
    return;
  }

  if (msg.type === "generate-cards-from-table") {
    resetStopFlag();

    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map((row,index) => ({
        title: String(row.title ?? "").trim(),
        identifier: String(row.identifier ?? "").trim(),
        _syncRowKey:
          String(row._syncRowKey ?? "").trim() ||
          `table-row-${index + 1}`
      }))
      .filter(row => row.title && row.identifier);

    const result =
      await generateCardsFromTable(
        rows,
        {
          columns: msg.columns,
          gap: msg.gap,
          sidePadding: msg.sidePadding,
          visualGap: msg.visualGap,
          minFontSize: msg.minFontSize,
          maxFontSize: msg.maxFontSize
        }
      );

    if (result.error) {
      figma.ui.postMessage({
        type: "table-generator-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "table-generator-result",
      ...result
    });

    notifyLocalized(
      msg,
      result.stopped
        ? `Создание остановлено. Создано: ${result.created} из ${result.total}.`
        : `Создано карточек: ${result.created} из ${result.total}.`,
      result.stopped
        ? `Generation stopped. Created: ${result.created} of ${result.total}.`
        : `Cards created: ${result.created} of ${result.total}.`
    );

    return;
  }

  if (msg.type === "run-full-sync") {
    resetStopFlag();

    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map((row,index) => ({
        title: String(row.title ?? "").trim(),
        identifier: String(row.identifier ?? "").trim(),
        _syncRowKey:
          String(row._syncRowKey ?? "").trim() ||
          `table-row-${index + 1}`
      }))
      .filter(row => row.title && row.identifier);

    const result = await runFullSync(rows);

    if (result.error) {
      figma.ui.postMessage({
        type: "full-sync-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "full-sync-result",
      ...result
    });

    notifyLocalized(
      msg,
      `Full Sync: точных ${result.exact.length}, авто ${result.auto.length}, проверить ${result.review.length}, missing ${result.missing.length}.`,
      `Full Sync: ${result.exact.length} safe, ${result.auto.length} auto, ${result.review.length} review, ${result.missing.length} missing.`
    );

    return;
  }

  if (msg.type === "confirm-full-sync-review") {
    const result = await confirmFullSyncReview(
      msg.sessionId,
      msg.reviewId
    );

    if (result.error) {
      figma.ui.postMessage({
        type: "full-sync-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "full-sync-review-updated",
      ...result
    });

    return;
  }

  if (msg.type === "reject-full-sync-review") {
    const result = rejectFullSyncReview(
      msg.sessionId,
      msg.reviewId
    );

    if (result.error) {
      figma.ui.postMessage({
        type: "full-sync-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "full-sync-review-updated",
      ...result
    });

    return;
  }

  if (msg.type === "create-full-sync-missing-row") {
    resetStopFlag();

    const result = await createFullSyncMissingRows(
      msg.sessionId,
      [msg.rowKey],
      {
        columns: msg.columns,
        gap: msg.gap,
        sidePadding: msg.sidePadding,
        visualGap: msg.visualGap,
        minFontSize: msg.minFontSize,
        maxFontSize: msg.maxFontSize
      }
    );

    if (result.error) {
      figma.ui.postMessage({
        type: "full-sync-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "full-sync-missing-created",
      ...result
    });

    notifyLocalized(
      msg,
      result.created.length
        ? `Missing-карточка создана: ${result.created[0].title}.`
        : "Missing-карточка не создана.",
      result.created.length
        ? `Missing card created: ${result.created[0].title}.`
        : "Missing card was not created."
    );

    return;
  }

  if (msg.type === "create-all-full-sync-missing-rows") {
    resetStopFlag();

    const result = await createFullSyncMissingRows(
      msg.sessionId,
      [],
      {
        columns: msg.columns,
        gap: msg.gap,
        sidePadding: msg.sidePadding,
        visualGap: msg.visualGap,
        minFontSize: msg.minFontSize,
        maxFontSize: msg.maxFontSize
      }
    );

    if (result.error) {
      figma.ui.postMessage({
        type: "full-sync-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "full-sync-missing-created-all",
      ...result
    });

    notifyLocalized(
      msg,
      `Создано Missing-карточек: ${result.created.length}.`,
      `Created Missing cards: ${result.created.length}.`
    );

    return;
  }

  if (msg.type === "clone-full-sync-missing") {
    const result = await cloneMissingFromSuggestion(
      msg.sessionId,
      msg.suggestionId
    );

    if (result.error) {
      figma.ui.postMessage({
        type: "full-sync-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "full-sync-clone-created",
      ...result
    });

    notifyLocalized(
      msg,
      `Фрейм создан: ${result.suggestion.targetTitle}.`,
      `Frame created: ${result.suggestion.targetTitle}.`
    );

    return;
  }

  if (msg.type === "clone-all-full-sync-missing") {
    resetStopFlag();

    const result = await cloneAllMissingSuggestions(msg.sessionId);

    if (result.error) {
      figma.ui.postMessage({
        type: "full-sync-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "full-sync-clones-created",
      ...result
    });

    notifyLocalized(
      msg,
      `Создано Missing-фреймов: ${result.created.length}.`,
      `Created Missing frames: ${result.created.length}.`
    );

    return;
  }

  if (msg.type === "rerun-full-sync-session") {
    resetStopFlag();

    if (
      !fullSyncSession ||
      fullSyncSession.id !== msg.sessionId
    ) {
      figma.ui.postMessage({
        type: "full-sync-error",
        message:
          "Sync session is no longer active. Run Full Sync again."
      });
      return;
    }

    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map((row,index) => ({
        title: String(row.title ?? "").trim(),
        identifier: String(row.identifier ?? "").trim(),
        _syncRowKey:
          String(row._syncRowKey ?? "").trim() ||
          `table-row-${index + 1}`
      }))
      .filter(row => row.title && row.identifier);

    const visibleSelectionIds =
      figma.currentPage.selection.map(node => node.id);

    const stableMissingReferenceId = fullSyncSession.missingReferenceId;

    const result = await runFullSync(
      rows,
      fullSyncSession.selectionIds,
      stableMissingReferenceId
    );

    // Preserve ONLY duplicated frames selected in the UI.
    const visibleNodes = [];

    for (const id of visibleSelectionIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (node) visibleNodes.push(node);
    }

    if (visibleNodes.length) {
      figma.currentPage.selection = visibleNodes;
    }

    if (result.error) {
      figma.ui.postMessage({
        type: "full-sync-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "full-sync-result",
      ...result
    });

    return;
  }

  if (msg.type === "apply-full-sync") {
    resetStopFlag();

    const result = await applyFullSync(
      msg.sessionId
    );

    if (result.error) {
      figma.ui.postMessage({
        type: "full-sync-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "full-sync-applied",
      ...result
    });

    notifyLocalized(
      msg,
      `Full Sync применён: ${result.applied.length}. Пропущено: ${result.skipped.length}.`,
      `Full Sync applied: ${result.applied.length}. Skipped: ${result.skipped.length}.`
    );

    return;
  }

  if (msg.type === "reset-full-sync-aliases") {
    const result =
      await resetFullSyncAliases();

    figma.ui.postMessage({
      type: "full-sync-aliases-reset",
      ...result
    });

    return;
  }

  if (msg.type === "scan-gradient-styles") {
    const prefix = String(msg.prefix || "gradient/slots").trim();
    const styles = await getGradientStyles(prefix);

    figma.ui.postMessage({
      type: "gradient-styles-scanned",
      count: styles.length,
      names: styles.slice(0, 30).map(style => style.name)
    });
    return;
  }

  if (msg.type === "auto-match-gradients") {
    resetStopFlag();

    const result = await autoMatchGradientStyles({
      prefix: msg.prefix,
      topPercent: msg.topPercent
    });

    if (result.error) {
      figma.ui.postMessage({
        type: "gradient-auto-error",
        message: result.error,
        stylesFound: result.stylesFound || 0
      });
      return;
    }

    figma.ui.postMessage({
      type: "gradient-auto-result",
      ...result
    });

    notifyLocalized(
      msg,
      result.stopped
        ? `Автоподбор градиентов остановлен. Применено: ${result.applied.length}.`
        : `Градиенты подобраны по цвету: ${result.applied.length}. Пропущено: ${result.skipped.length}.`,
      result.stopped
        ? `Auto gradient matching stopped. Applied: ${result.applied.length}.`
        : `Gradients matched by banner color: ${result.applied.length}. Skipped: ${result.skipped.length}.`
    );

    return;
  }

  if (msg.type === "randomize-gradients") {
    resetStopFlag();

    const result = await randomizeGradientStyles({
      prefix: msg.prefix,
      avoidSame: msg.avoidSame
    });

    if (result.error) {
      figma.ui.postMessage({
        type: "gradient-randomize-error",
        message: result.error,
        stylesFound: result.stylesFound || 0
      });
      return;
    }

    figma.ui.postMessage({
      type: "gradient-randomize-result",
      ...result
    });

    notifyLocalized(
      msg,
      result.stopped
        ? `Градиенты: операция остановлена. Применено: ${result.applied.length}.`
        : `Градиенты применены: ${result.applied.length}. Пропущено: ${result.skipped.length}.`,
      result.stopped
        ? `Gradients: operation stopped. Applied: ${result.applied.length}.`
        : `Gradients applied: ${result.applied.length}. Skipped: ${result.skipped.length}.`
    );
    return;
  }

  if (msg.type === "load-titlefit-template") {
    const template = await loadTitleFitTemplate();

    figma.ui.postMessage({
      type: "titlefit-template-loaded",
      summary: titleFitTemplateSummary(template)
    });
    return;
  }

  if (msg.type === "set-titlefit-template") {
    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map((r,index) => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim(),
        _syncRowKey:
          String(r._syncRowKey ?? "").trim() ||
          `table-row-${index + 1}`
      }))
      .filter(r => r.title && r.identifier);

    const result =
      await setSharedReferenceFromSelection(
        rows
      );

    if (result.error) {
      figma.ui.postMessage({
        type: "titlefit-template-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "shared-reference-set",
      ...result
    });

    return;
  }

  if (msg.type === "preview-titlefit") {
    resetStopFlag();

    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map(r => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim()
      }))
      .filter(r => r.title && r.identifier);

    const result = await previewTitleFit(rows, {
      sidePadding: Math.max(0, Math.min(200, Number(msg.sidePadding) || 12)),
      visualGap: Math.max(
        0,
        Math.min(
          40,
          Number.isFinite(Number(msg.visualGap))
            ? Number(msg.visualGap)
            : 0
        )
      ),
      maxRows: Math.max(1, Math.min(4, Number(msg.maxRows) || 3)),
      minFontSize: Math.max(1, Number(msg.minFontSize) || 16),
      maxFontSize: Math.max(1, Number(msg.maxFontSize) || 48)
    });

    if (result.error) {
      figma.ui.postMessage({
        type: "titlefit-preview-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "titlefit-preview-result",
      ...result
    });
    return;
  }

  if (msg.type === "apply-titlefit") {
    resetStopFlag();

    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map(r => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim()
      }))
      .filter(r => r.title && r.identifier);

    const result = await applyTitleFit(rows, {
      sidePadding: Math.max(0, Math.min(200, Number(msg.sidePadding) || 12)),
      visualGap: Math.max(
        0,
        Math.min(
          40,
          Number.isFinite(Number(msg.visualGap))
            ? Number(msg.visualGap)
            : 0
        )
      ),
      maxRows: Math.max(1, Math.min(4, Number(msg.maxRows) || 3)),
      minFontSize: Math.max(1, Number(msg.minFontSize) || 16),
      maxFontSize: Math.max(1, Number(msg.maxFontSize) || 48)
    });

    if (result.error) {
      figma.ui.postMessage({
        type: "titlefit-apply-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "titlefit-apply-result",
      ...result
    });

    notifyLocalized(
      msg,
      result.stopped
        ? `Title Fit остановлен. Обработано: ${result.changedCount ?? result.changed.length}.`
        : `Title Fit: обработано ${result.changedCount ?? result.changed.length}, пропущено ${result.skipped.length}.`,
      result.stopped
        ? `Title Fit stopped. Processed: ${result.changedCount ?? result.changed.length}.`
        : `Title Fit: processed ${result.changedCount ?? result.changed.length}, skipped ${result.skipped.length}.`
    );
    return;
  }

  if (msg.type === "cancel-operation") {
    requestStopFlag();
    notifyLocalized(
      msg,
      "Остановка запрошена. Текущая операция завершится на ближайшем безопасном шаге.",
      "Stop requested. The current operation will end at the nearest safe step."
    );
    return;
  }

  if (msg.type === "smart-fit-autolayout") {
    resetStopFlag();

    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map(r => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim()
      }))
      .filter(r => r.title && r.identifier);

    const result = await smartFitTitlesToAutoLayout(rows, {
      maxLines: Math.max(2, Math.min(4, Number(msg.maxLines) || 3)),
      rowCount: Math.max(1, Math.min(4, Number(msg.rowCount || msg.maxLines) || 3)),
      exactRows: true,
      paddingPercent: Math.max(0, Math.min(45, Number(msg.paddingPercent) || 8)),
      gap: Math.max(0, Math.min(40, Number(msg.gap) || 0)),
      minFontSize: Number(msg.minFontSize) || 20,
      maxFontSize: Number(msg.maxFontSize) || 64,
      forceRebuild: msg.forceRebuild === true
    });

    if (result.error) {
      figma.ui.postMessage({
        type: "autolayout-fit-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "autolayout-fit-result",
      ...result
    });

    notifyLocalized(
      msg,
      result.stopped
        ? `Auto Layout остановлен. Собрано: ${result.converted.length}.`
        : `Заголовки собраны в Auto Layout: ${result.converted.length}. Пропущено: ${result.skipped.length}.`,
      result.stopped
        ? `Auto Layout stopped. Converted: ${result.converted.length}.`
        : `Titles converted to Auto Layout: ${result.converted.length}. Skipped: ${result.skipped.length}.`
    );

    return;
  }

  if (msg.type === "rebuild-title-layout") {
    resetStopFlag();

    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map(r => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim()
      }))
      .filter(r => r.title && r.identifier);

    const result = await smartFitTitlesToAutoLayout(rows, {
      maxLines: Math.max(2, Math.min(4, Number(msg.maxLines) || 3)),
      rowCount: Math.max(1, Math.min(4, Number(msg.rowCount || msg.maxLines) || 3)),
      exactRows: true,
      paddingPercent: Math.max(0, Math.min(45, Number(msg.paddingPercent) || 8)),
      gap: Math.max(0, Math.min(40, Number(msg.gap) || 0)),
      minFontSize: Number(msg.minFontSize) || 20,
      maxFontSize: Number(msg.maxFontSize) || 64,
      forceRebuild: true
    });

    if (result.error) {
      figma.ui.postMessage({ type: "title-layout-error", message: result.error });
      return;
    }

    figma.ui.postMessage({ type: "title-layout-result", ...result });

    notifyLocalized(
      msg,
      result.stopped
        ? `Пересборка title остановлена. Готово: ${result.converted.length}.`
        : `Структура title пересобрана: ${result.converted.length}. Пропущено: ${result.skipped.length}.`,
      result.stopped
        ? `Title rebuild stopped. Converted: ${result.converted.length}.`
        : `Title structure rebuilt: ${result.converted.length}. Skipped: ${result.skipped.length}.`
    );

    return;
  }

  if (msg.type === "smart-line-breaks") {
    resetStopFlag();
    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map(r => ({ title: String(r.title ?? "").trim(), identifier: String(r.identifier ?? "").trim() }))
      .filter(r => r.title && r.identifier);

    const result = await smartLineBreakTitles(rows, {
      preferredLines: Math.max(2, Math.min(4, Number(msg.preferredLines) || 3)),
      paddingPercent: Math.max(0, Math.min(45, Number(msg.paddingPercent) || 8)),
      preserveBottom: msg.preserveBottom !== false,
      autoFitAfter: msg.autoFitAfter === true,
      proportionalLineHeight: msg.proportionalLineHeight !== false,
      lineHeightPercent: Number.isFinite(Number(msg.lineHeightPercent)) ? Number(msg.lineHeightPercent) : 100,
      minFontSize: Number(msg.minFontSize) || 20,
      maxFontSize: Number(msg.maxFontSize) || 64
    });

    if (result.error) {
      figma.ui.postMessage({ type: "smartbreak-error", message: result.error });
      return;
    }

    figma.ui.postMessage({ type: "smartbreak-result", ...result });

    notifyLocalized(
      msg,
      result.stopped
        ? `Переносы остановлены. Обработано: ${result.changed.length}. Пропущено: ${result.skipped.length}.`
        : `Переносы настроены: ${result.changed.length}. Пропущено: ${result.skipped.length}.`,
      result.stopped
        ? `Smart line breaks stopped. Processed: ${result.changed.length}. Skipped: ${result.skipped.length}.`
        : `Smart line breaks applied: ${result.changed.length}. Skipped: ${result.skipped.length}.`
    );
    return;
  }

  if (msg.type === "auto-fit-titles") {
    resetStopFlag();
    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map(r => ({ title: String(r.title ?? "").trim(), identifier: String(r.identifier ?? "").trim() }))
      .filter(r => r.title && r.identifier);

    const result = await autoFitTitles(rows, {
      minFontSize: Number(msg.minFontSize) || 20,
      maxFontSize: Number(msg.maxFontSize) || 64,
      paddingPercent: Number(msg.paddingPercent) || 8,
      maxLines: Math.max(2, Math.min(4, Number(msg.maxLines) || 3)),
      rowCount: Math.max(1, Math.min(4, Number(msg.rowCount || msg.maxLines) || 3)),
      gap: Math.max(0, Math.min(40, Number(msg.gap) || 0)),
      preserveBottom: msg.preserveBottom !== false,
    });

    if (result.error) {
      figma.ui.postMessage({ type: "autofit-error", message: result.error });
      return;
    }

    figma.ui.postMessage({ type: "autofit-result", ...result });
    notifyLocalized(
      msg,
      result.stopped
        ? `Автоподгонка остановлена. Обработано: ${result.changed.length}. Пропущено: ${result.skipped.length}.`
        : `Подогнано заголовков: ${result.changed.length}. Пропущено: ${result.skipped.length}.`,
      result.stopped
        ? `Auto-fit stopped. Processed ${result.changed.length}. Skipped ${result.skipped.length}.`
        : `Auto-fit ${result.changed.length} titles. Skipped ${result.skipped.length}.`
    );
    return;
  }

  if (msg.type === "set-normalize-reference") {
    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map((r,index) => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim(),
        _syncRowKey:
          String(r._syncRowKey ?? "").trim() ||
          `table-row-${index + 1}`
      }))
      .filter(r => r.title && r.identifier);

    const result =
      await setSharedReferenceFromSelection(
        rows
      );

    if (result.error) {
      figma.ui.postMessage({
        type: "normalize-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "shared-reference-set",
      ...result
    });

    return;
  }

  if (msg.type === "normalize-titles") {
    resetStopFlag();
    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map(r => ({ title: String(r.title ?? "").trim(), identifier: String(r.identifier ?? "").trim() }))
      .filter(r => r.title && r.identifier);

    const result = await normalizeTitles(rows, {
      copyFont: msg.copyFont !== false,
      copyLetterSpacing: msg.copyLetterSpacing !== false,
      copyGap: msg.copyGap !== false,
      copyFrameSize: msg.copyFrameSize !== false,
      alignCenter: msg.alignCenter !== false,
      alignBottom: msg.alignBottom !== false
    });

    if (result.error) {
      figma.ui.postMessage({ type: "normalize-error", message: result.error });
      return;
    }

    figma.ui.postMessage({ type: "normalize-result", ...result });
    notifyLocalized(
      msg,
      result.stopped
        ? `Нормализация остановлена. Обработано: ${result.changedCount ?? result.changed.length}. Пропущено: ${result.skipped.length}.`
        : `Нормализовано заголовков: ${result.changedCount ?? result.changed.length}. Пропущено: ${result.skipped.length}.`,
      result.stopped
        ? `Normalize stopped. Processed ${result.changedCount ?? result.changed.length}. Skipped ${result.skipped.length}.`
        : `Normalized ${result.changedCount ?? result.changed.length} titles. Skipped ${result.skipped.length}.`
    );
    return;
  }

  if (msg.type === "sort-frames-alpha") {
    resetStopFlag();

    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map(r => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim()
      }))
      .filter(r => r.title && r.identifier);

    const result = await sortSelectedFrames(rows, {
      order: msg.order === "table" ? "table" : "alpha",
      chunkCols: Math.max(1, Math.min(100, Math.floor(Number(msg.chunkCols) || 10))),
      chunkRows: Math.max(1, Math.min(100, Math.floor(Number(msg.chunkRows) || 10))),
      cardGap: Math.max(0, Math.min(1000, Number(msg.cardGap) || 0)),
      chunkGap: Math.max(0, Math.min(5000, Number(msg.chunkGap) || 0)),
      chunksPerRow: Math.max(1, Math.min(100, Math.floor(Number(msg.chunksPerRow) || 5)))
    });

    if (result.error) {
      figma.ui.postMessage({
        type: "sort-frames-error",
        message: result.error
      });
      return;
    }

    figma.ui.postMessage({
      type: "sort-frames-result",
      ...result
    });

    notifyLocalized(
      msg,
      result.stopped
        ? `Сортировка остановлена. Перемещено: ${result.sorted}.`
        : result.order === "table"
          ? `Фреймы собраны в порядке таблицы: ${result.sorted}. Не найдено в таблице: ${result.notInTable}.`
          : `Фреймы отсортированы A–Z и собраны рядом: ${result.sorted}.`,
      result.stopped
        ? `Sorting stopped. Moved: ${result.sorted}.`
        : result.order === "table"
          ? `Frames packed in table order: ${result.sorted}. Not found in table: ${result.notInTable}.`
          : `Frames sorted A–Z and packed together: ${result.sorted}.`
    );
    return;
  }

  if (msg.type === "get-selection") {
    postSelectionInfo();
    return;
  }

  if (msg.type === "select-title-layers") {
    const roots = [...figma.currentPage.selection];

    if (!roots.length) {
      figma.ui.postMessage({
        type: "select-title-result",
        count: 0,
        cards: 0,
        error: "Select one or more cards or title layers first."
      });
      return;
    }

    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map(r => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim()
      }))
      .filter(r => r.title && r.identifier);

    const resolved = resolveSelectedCards(rows);
    const cards = resolved.cards;

    const titleNodes = [];
    const seen = new Set();
    let matchedCards = 0;
    let skippedCards = resolved.unresolved.length;

    for (const card of cards) {

      const match = findTitleForNormalize(card, rows);
      if (!match) {
        skippedCards++;
        continue;
      }

      const nodes = getTitleNodes(match).filter(n => n && n.type === "TEXT");
      if (!nodes.length) {
        skippedCards++;
        continue;
      }

      matchedCards++;

      for (const node of nodes) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        titleNodes.push(node);
      }
    }

    if (!titleNodes.length) {
      figma.ui.postMessage({
        type: "select-title-result",
        count: 0,
        cards: 0,
        skippedCards,
        error: "No game-title layers found inside the selected cards."
      });
      return;
    }

    figma.currentPage.selection = titleNodes;

    if (titleNodes.length <= 60) {
      figma.viewport.scrollAndZoomIntoView(titleNodes);
    }

    figma.ui.postMessage({
      type: "select-title-result",
      count: titleNodes.length,
      cards: matchedCards,
      skippedCards
    });

    postSelectionInfo();

    notifyLocalized(
      msg,
      `Выделено заголовков: ${titleNodes.length}. Карточек: ${matchedCards}.`,
      `Selected title layers: ${titleNodes.length}. Cards: ${matchedCards}.`
    );
    return;
  }

  if (msg.type === "rename") {
    resetStopFlag();
    const rows = (Array.isArray(msg.rows) ? msg.rows : [])
      .map(r => ({
        title: String(r.title ?? "").trim(),
        identifier: String(r.identifier ?? "").trim()
      }))
      .filter(r => r.title && r.identifier);

    if (!rows.length) {
      figma.ui.postMessage({ type: "error", message: "No valid title + identifier rows." });
      return;
    }

    if (!figma.currentPage.selection.length) {
      figma.ui.postMessage({ type: "error", message: "Select frames in Figma first." });
      return;
    }

    const result = await analyze(rows);
    const selectionById = new Map(
      result.selection.map(node => [node.id, node])
    );
    const renameItems = result.renameTargets || result.matched;
    const renameBatch = girBatchSize(renameItems.length, 32, 80);

    for (let renameIndex = 0; renameIndex < renameItems.length; renameIndex++) {
      if (wasStopRequested()) break;

      const item = renameItems[renameIndex];
      let node = selectionById.get(item.nodeId) || null;

      // Rare fallback for a node that was not part of the original selection.
      if (!node) {
        try { node = await figma.getNodeByIdAsync(item.nodeId); } catch (e) {}
      }

      if (
        node &&
        node.type !== 'DOCUMENT' &&
        node.type !== 'PAGE'
      ) {
        node.name = item.identifier;
      }

      if (
        renameIndex > 0 &&
        (renameIndex + 1) % renameBatch === 0
      ) {
        if (!(await cooperativeYield(true))) break;
      }
    }

    figma.ui.postMessage({
      type: "result",
      selected: result.selection.length,
      matched: result.matched,
      skipped: result.skipped,
      extras: result.extras,
      duplicates: result.duplicates || [],
      sharedIdentifierGroups: result.sharedIdentifierGroups || [],
      tableRowCount: result.tableRowCount,
      claimedRowCount: result.claimedRowCount,
      selectedCount: result.selection.length,
      actuallyRenamed: (result.renameTargets || result.matched).length,
      missing: result.missing,
      stopped: wasStopRequested() || result.stopped
    });

    notifyLocalized(
      msg,
      result.stopped
        ? `Переименование остановлено. Совпало: ${result.matched.length}. Пропущено: ${result.skipped.length}.`
        : `Обновлено имён фреймов: ${(result.renameTargets || result.matched).length}. Сопоставлено строк: ${result.matched.length}/${result.tableRowCount}. Лишних: ${result.extras.length}. Дубликатов: ${(result.duplicates || []).length}. Пропущено: ${result.skipped.length}. Не хватает строк: ${result.missing.length}.`,
      result.stopped
        ? `Rename stopped. Matched ${result.matched.length}. Skipped ${result.skipped.length}.`
        : `Frame names updated ${(result.renameTargets || result.matched).length}. Table rows matched ${result.matched.length}/${result.tableRowCount}. Extra ${result.extras.length}. Duplicates ${(result.duplicates || []).length}. Skipped ${result.skipped.length}. Missing rows ${result.missing.length}.`
    );
    return;
  }

  if (msg.type === "select-shared-identifier-cards") {
    const ids = Array.isArray(msg.nodeIds) ? msg.nodeIds : [];
    const nodes = [];

    for (const id of ids) {
      const node = await figma.getNodeByIdAsync(id);

      if (
        node &&
        node.type !== "DOCUMENT" &&
        node.type !== "PAGE"
      ) {
        nodes.push(node);
      }
    }

    if (nodes.length) {
      figma.currentPage.selection = nodes;
      figma.viewport.scrollAndZoomIntoView(nodes);

      notifyLocalized(
        msg,
        `Выделено карточек с одинаковым identifier: ${nodes.length}.`,
        `Selected cards sharing the same identifier: ${nodes.length}.`
      );
    }

    return;
  }

  if (msg.type === "select-duplicates") {
    const ids = Array.isArray(msg.nodeIds) ? msg.nodeIds : [];
    const nodes = [];

    for (const id of ids) {
      const node = await figma.getNodeByIdAsync(id);
      if (node && "visible" in node) nodes.push(node);
    }

    if (nodes.length) {
      figma.currentPage.selection = nodes;
      figma.viewport.scrollAndZoomIntoView(nodes);

      notifyLocalized(
        msg,
        `Выделено дубликатов: ${nodes.length}.`,
        `Selected ${nodes.length} duplicate banners.`
      );
    }

    return;
  }

  if (msg.type === "select-extras") {
    const ids = Array.isArray(msg.nodeIds) ? msg.nodeIds : [];
    const nodes = [];

    for (const id of ids) {
      const node = await figma.getNodeByIdAsync(id);
      if (node && "visible" in node) nodes.push(node);
    }

    if (nodes.length) {
      figma.currentPage.selection = nodes;
      figma.viewport.scrollAndZoomIntoView(nodes);
      notifyLocalized(
        msg,
        `Выделено лишних баннеров: ${nodes.length}.`,
        `Selected ${nodes.length} extra banners.`
      );
    }

    return;
  }

  if (msg.type === "select-skipped") {
    const ids = Array.isArray(msg.nodeIds) ? msg.nodeIds : [];
    const nodes = [];

    for (const id of ids) {
      const node = await figma.getNodeByIdAsync(id);
      if (node && "visible" in node) nodes.push(node);
    }

    if (nodes.length) {
      figma.currentPage.selection = nodes;
      figma.viewport.scrollAndZoomIntoView(nodes);
      notifyLocalized(msg, `Выделено пропущенных фреймов: ${nodes.length}.`, `Selected ${nodes.length} skipped frames.`);
    }
    return;
  }
};

figma.ui.postMessage({
  type: "selection-info",
  count: figma.currentPage.selection.length,
  names: figma.currentPage.selection.slice(0, 10).map(n => n.name)
});
