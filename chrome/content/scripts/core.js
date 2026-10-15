(function (global) {
  "use strict";

  function normalizeWhitespace(value) {
    return String(value ?? "")
      .replace(/[\u00ad\u200b]/g, "")
      .replace(/-\s*\n\s*(?=[a-z])/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitPages(text) {
    const source = String(text ?? "");
    if (source.includes("\f")) {
      return source.split("\f").map(normalizeWhitespace);
    }
    return [normalizeWhitespace(source)];
  }

  function findAllOccurrences(haystack, needle) {
    const positions = [];
    if (!needle) return positions;
    const lowerHaystack = haystack.toLocaleLowerCase();
    const lowerNeedle = needle.toLocaleLowerCase();
    let cursor = 0;
    while ((cursor = lowerHaystack.indexOf(lowerNeedle, cursor)) !== -1) {
      positions.push(cursor);
      cursor += Math.max(1, lowerNeedle.length);
    }
    return positions;
  }

  function sentenceBounds(text, index, termLength) {
    const leftPart = text.slice(0, index);
    const rightPart = text.slice(index + termLength);
    const leftBreak = Math.max(
      leftPart.lastIndexOf("."),
      leftPart.lastIndexOf("?"),
      leftPart.lastIndexOf("!"),
      leftPart.lastIndexOf("。"),
      leftPart.lastIndexOf("？"),
      leftPart.lastIndexOf("！")
    );
    const candidates = [".", "?", "!", "。", "？", "！"]
      .map((mark) => rightPart.indexOf(mark))
      .filter((value) => value >= 0);
    const rightBreak = candidates.length ? Math.min(...candidates) : -1;
    return {
      start: leftBreak >= 0 ? leftBreak + 1 : 0,
      end: rightBreak >= 0
        ? index + termLength + rightBreak + 1
        : text.length
    };
  }

  function extractSentence(pageText, selectedText) {
    const text = normalizeWhitespace(pageText);
    const selected = normalizeWhitespace(selectedText);
    if (!text || !selected) {
      return { sentence: selected, context: text, ambiguous: false };
    }
    const positions = findAllOccurrences(text, selected);
    if (!positions.length) {
      const context = text.slice(0, 1200);
      return { sentence: selected, context, ambiguous: false };
    }
    const index = positions[0];
    const bounds = sentenceBounds(text, index, selected.length);
    const sentence = normalizeWhitespace(text.slice(bounds.start, bounds.end));
    const contextStart = Math.max(0, bounds.start - 650);
    const contextEnd = Math.min(text.length, bounds.end + 650);
    return {
      sentence,
      context: normalizeWhitespace(text.slice(contextStart, contextEnd)),
      ambiguous: positions.length > 1
    };
  }

  function sanitizeFileName(value) {
    const cleaned = normalizeWhitespace(value)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[\[\]#^]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 120);
    return cleaned || "untitled";
  }

  function stableShortHash(value) {
    const text = String(value ?? "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function fitSessionFileName(
    directoryPath,
    questionLabel,
    timestamp,
    stableKey,
    existingFileName = "",
    safePathLength = 248
  ) {
    const directory = String(directoryPath || "").replace(/[\\/]+$/, "");
    const readableQuestion = sanitizeFileName(questionLabel || "AI 阅读会话");
    const readableTimestamp = sanitizeFileName(timestamp || "会话");
    const desired = existingFileName
      ? sanitizeFileName(existingFileName.replace(/\.md$/i, "")) + ".md"
      : `${readableQuestion} - ${readableTimestamp}.md`;
    const temporarySuffixLength = ".tmp".length;
    if (directory.length + 1 + desired.length + temporarySuffixLength <= safePathLength) {
      return desired;
    }

    const maximumFileNameLength = safePathLength
      - directory.length
      - 1
      - temporarySuffixLength;
    const extension = ".md";
    const maximumStemLength = maximumFileNameLength - extension.length;
    if (maximumStemLength < 10) {
      throw new Error("Obsidian Vault 路径过深，请将 Vault 或阅读会话目录移动到更短的上级路径");
    }

    const digest = stableShortHash(stableKey || desired).slice(0, 6);
    const timestampBudget = Math.max(0, Math.min(
      readableTimestamp.length,
      maximumStemLength - digest.length - 3
    ));
    const compactTimestamp = readableTimestamp.slice(0, timestampBudget).replace(/[. ]+$/g, "");
    const tail = compactTimestamp ? `${compactTimestamp} - ${digest}` : digest;
    const questionBudget = maximumStemLength - tail.length - 3;
    const compactQuestion = questionBudget > 3
      ? readableQuestion.slice(0, questionBudget).replace(/[. ]+$/g, "")
      : "";
    const stem = compactQuestion ? `${compactQuestion} - ${tail}` : tail;
    return `${stem.slice(0, maximumStemLength).replace(/[. ]+$/g, "")}${extension}`;
  }

  function escapeYaml(value) {
    return JSON.stringify(String(value ?? ""));
  }

  function tokenizeQuery(query) {
    const source = String(query ?? "").toLocaleLowerCase();
    const tokens = new Set(
      (source.match(/[a-z0-9][a-z0-9_-]{1,}/g) || [])
        .filter((token) => token.length > 2)
    );
    const chinese = source.replace(/[^\u3400-\u9fff]/g, "");
    for (let i = 0; i < chinese.length - 1; i++) {
      tokens.add(chinese.slice(i, i + 2));
    }
    return [...tokens];
  }

  function chunkPages(pages, size = 2600, overlap = 300) {
    const chunks = [];
    pages.forEach((page, pageIndex) => {
      const text = normalizeWhitespace(page);
      if (!text) return;
      let start = 0;
      while (start < text.length) {
        const end = Math.min(text.length, start + size);
        chunks.push({ pageIndex, text: text.slice(start, end), start });
        if (end >= text.length) break;
        start = Math.max(start + 1, end - overlap);
      }
    });
    return chunks;
  }

  function rankChunks(chunks, query, limit = 6) {
    const tokens = tokenizeQuery(query);
    return chunks
      .map((chunk, originalIndex) => {
        const text = chunk.text.toLocaleLowerCase();
        let score = 0;
        for (const token of tokens) {
          const count = text.split(token).length - 1;
          score += count * (token.length >= 6 ? 3 : 1);
        }
        return { ...chunk, score, originalIndex };
      })
      .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
      .slice(0, limit)
      .sort((a, b) => a.pageIndex - b.pageIndex || a.start - b.start);
  }

  function stripCodeFence(value) {
    const text = String(value ?? "").trim();
    const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1] : text;
  }

  function parseModelJSON(value) {
    const text = stripCodeFence(value);
    try {
      return JSON.parse(text);
    } catch (_error) {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
      throw new Error("模型没有返回有效 JSON");
    }
  }

  function normalizeSenseIDs(entry) {
    const source = entry && typeof entry === "object" ? entry : {};
    const firstText = (...values) => {
      for (const value of values) {
        if (Array.isArray(value)) {
          const joined = value.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
          if (joined) return joined;
        } else if (value !== undefined && value !== null && String(value).trim()) {
          return String(value).trim();
        }
      }
      return "";
    };
    const stringList = (value) => [...new Set(
      (Array.isArray(value) ? value : [value]).flatMap((item) =>
        typeof item === "string" ? item.split(/[,;，；]\s*/) : []
      ).map((item) => item.trim()).filter(Boolean)
    )];
    const rawSenses = Array.isArray(source.senses)
      ? source.senses
      : Array.isArray(source.meanings)
        ? source.meanings
        : [];
    const used = new Set();
    const senses = rawSenses.map(
      (sense, index) => {
        let senseId = String(sense.sense_id || `sense-${index + 1}`);
        if (used.has(senseId)) senseId = `sense-${index + 1}`;
        while (used.has(senseId)) senseId = `${senseId}-new`;
        used.add(senseId);
        const rawExamples = sense.ai_examples || sense.examples || [];
        const rawCollocationNotes = sense.collocation_notes
          || sense.professional_collocations
          || sense.collocation_details
          || [];
        return {
          sense_id: senseId,
          part_of_speech: firstText(sense.part_of_speech, sense.pos, source.part_of_speech, source.pos),
          chinese_definition: firstText(
            sense.chinese_definition,
            sense.definition,
            sense.meaning,
            sense.zh
          ),
          english_definition: firstText(
            sense.english_definition,
            sense.definition_en,
            sense.en_definition,
            sense.academic_definition
          ),
          domain: firstText(sense.domain, sense.register_tags, sense.field, "通用"),
          collocations: stringList(sense.collocations || sense.phrases || sense.common_phrases),
          collocation_notes: (Array.isArray(rawCollocationNotes) ? rawCollocationNotes : [])
            .map((note) => ({
              phrase: firstText(note?.phrase, note?.collocation, note?.term),
              domain: firstText(note?.domain, note?.field, sense.domain, "通用"),
              chinese_explanation: firstText(
                note?.chinese_explanation,
                note?.meaning,
                note?.explanation
              ),
              usage_note: firstText(note?.usage_note, note?.usage, note?.note)
            }))
            .filter((note) => note.phrase),
          ai_examples: (Array.isArray(rawExamples) ? rawExamples : []).map((example) => ({
            english: firstText(example.english, example.en, example.sentence),
            chinese: firstText(example.chinese, example.zh, example.translation)
          })).filter((example) => example.english || example.chinese)
        };
      }
    );
    const fallbackDefinition = firstText(
      source.short_definition,
      source.definition,
      senses[0]?.chinese_definition,
      senses[0]?.english_definition
    );
    if (!senses.length && fallbackDefinition) {
      senses.push({
        sense_id: "sense-1",
        part_of_speech: firstText(source.part_of_speech, source.pos),
        chinese_definition: fallbackDefinition,
        english_definition: "",
        domain: "通用",
        collocations: [],
        collocation_notes: [],
        ai_examples: []
      });
      used.add("sense-1");
    }
    const rawContext = source.current_context && typeof source.current_context === "object"
      ? source.current_context
      : {};
    const senseContext = rawSenses.find((sense) => sense?.current_context)?.current_context;
    const rawSentenceAnalysis = rawContext.sentence_analysis
      || source.sentence_analysis
      || {};
    const requestedSense = firstText(rawContext.sense_id, source.current_sense_id);
    const contextSenseID = used.has(requestedSense)
      ? requestedSense
      : String(senses[0]?.sense_id || "sense-1");
    const word = firstText(source.word, source.headword, source.term, source.lemma);
    const lemma = firstText(source.lemma, source.headword, source.word, source.term);
    return {
      word: word || lemma,
      lemma: lemma || word,
      pronunciation: firstText(source.pronunciation, source.soundmark, source.phonetic),
      part_of_speech: firstText(source.part_of_speech, source.pos, senses[0]?.part_of_speech),
      short_definition: fallbackDefinition,
      aliases: [...new Set([
        ...stringList(source.aliases),
        word,
        lemma
      ].filter(Boolean))],
      senses,
      current_context: {
        sense_id: contextSenseID,
        sense_label: firstText(
          rawContext.sense_label,
          rawContext.current_sense,
          senses.find((sense) => sense.sense_id === contextSenseID)?.chinese_definition
        ),
        contextual_meaning: firstText(
          rawContext.contextual_meaning,
          rawContext.current_context,
          typeof source.current_context === "string" ? source.current_context : "",
          typeof senseContext === "string" ? senseContext : "",
          senses.find((sense) => sense.sense_id === contextSenseID)?.chinese_definition
        ),
        reason: firstText(rawContext.reason, rawContext.evidence, source.context_reason, "根据论文原句和邻近上下文判断"),
        sentence_analysis: {
          sentence_pattern: firstText(
            rawSentenceAnalysis.sentence_pattern,
            rawSentenceAnalysis.pattern,
            rawSentenceAnalysis.summary
          ),
          structure: stringList(rawSentenceAnalysis.structure || rawSentenceAnalysis.components),
          grammar_points: stringList(
            rawSentenceAnalysis.grammar_points
            || rawSentenceAnalysis.grammar
            || rawSentenceAnalysis.points
          ),
          academic_usage: firstText(
            rawSentenceAnalysis.academic_usage,
            rawSentenceAnalysis.usage,
            rawSentenceAnalysis.writing_note
          )
        }
      },
      generated_by: firstText(source.generated_by)
    };
  }

  function mergeUniqueStrings(...collections) {
    const output = [];
    const seen = new Set();
    for (const value of collections.flat()) {
      const text = String(value || "").trim();
      const key = text.toLocaleLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      output.push(text);
    }
    return output;
  }

  function definitionKey(sense) {
    return normalizeWhitespace([
      sense?.part_of_speech,
      sense?.chinese_definition,
      sense?.english_definition
    ].filter(Boolean).join(" ")).toLocaleLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, "");
  }

  function mergeVocabularyEntries(existingEntry, generatedEntry, encounteredForm = "") {
    const existing = normalizeSenseIDs(existingEntry);
    const generated = normalizeSenseIDs(generatedEntry);
    const senses = existing.senses.map((sense) => JSON.parse(JSON.stringify(sense)));
    const idMap = new Map();
    const usedIDs = new Set(senses.map((sense) => sense.sense_id));

    for (const incoming of generated.senses) {
      const incomingKey = definitionKey(incoming);
      let match = senses.find((sense) => sense.sense_id === incoming.sense_id);
      if (!match && incomingKey) {
        match = senses.find((sense) => definitionKey(sense) === incomingKey);
      }
      if (!match) {
        const incomingChinese = normalizeWhitespace(incoming.chinese_definition).toLocaleLowerCase();
        match = senses.find((sense) => {
          const currentChinese = normalizeWhitespace(sense.chinese_definition).toLocaleLowerCase();
          return incomingChinese && currentChinese
            && (incomingChinese.includes(currentChinese) || currentChinese.includes(incomingChinese));
        });
      }
      if (!match) {
        let nextID = incoming.sense_id || `sense-${senses.length + 1}`;
        while (usedIDs.has(nextID)) nextID = `sense-${senses.length + 1}`;
        const added = { ...incoming, sense_id: nextID };
        senses.push(added);
        usedIDs.add(nextID);
        idMap.set(incoming.sense_id, nextID);
        continue;
      }

      idMap.set(incoming.sense_id, match.sense_id);
      match.part_of_speech ||= incoming.part_of_speech;
      match.chinese_definition ||= incoming.chinese_definition;
      match.english_definition ||= incoming.english_definition;
      match.domain ||= incoming.domain;
      match.collocations = mergeUniqueStrings(match.collocations || [], incoming.collocations || []);
      const collocationMap = new Map();
      for (const note of [...(match.collocation_notes || []), ...(incoming.collocation_notes || [])]) {
        const key = String(note?.phrase || "").trim().toLocaleLowerCase();
        if (!key) continue;
        const previous = collocationMap.get(key) || {};
        collocationMap.set(key, {
          phrase: note.phrase || previous.phrase,
          domain: previous.domain || note.domain,
          chinese_explanation: previous.chinese_explanation || note.chinese_explanation,
          usage_note: previous.usage_note || note.usage_note
        });
      }
      match.collocation_notes = [...collocationMap.values()];
      const exampleMap = new Map();
      for (const example of [...(match.ai_examples || []), ...(incoming.ai_examples || [])]) {
        const key = normalizeWhitespace(example?.english || example?.chinese).toLocaleLowerCase();
        if (key && !exampleMap.has(key)) exampleMap.set(key, example);
      }
      match.ai_examples = [...exampleMap.values()];
    }

    const generatedContext = generated.current_context || {};
    const mappedContextID = idMap.get(generatedContext.sense_id)
      || (usedIDs.has(generatedContext.sense_id) ? generatedContext.sense_id : senses[0]?.sense_id || "sense-1");
    return normalizeSenseIDs({
      ...existing,
      word: existing.word || generated.word,
      lemma: existing.lemma || generated.lemma,
      pronunciation: existing.pronunciation || generated.pronunciation,
      part_of_speech: existing.part_of_speech || generated.part_of_speech,
      short_definition: existing.short_definition || generated.short_definition,
      aliases: mergeUniqueStrings(
        existing.aliases || [],
        generated.aliases || [],
        [encounteredForm]
      ),
      senses,
      current_context: {
        ...generatedContext,
        sense_id: mappedContextID
      },
      generated_by: generated.generated_by || existing.generated_by
    });
  }

  function createManagedData(entry, occurrences) {
    return {
      schema_version: 4,
      entry: normalizeSenseIDs(entry),
      occurrences: Array.isArray(occurrences) ? occurrences : []
    };
  }

  function renderManagedData(entry, occurrences) {
    const json = JSON.stringify(createManagedData(entry, occurrences), null, 2);
    return `%%\nscholar-bridge-data\n${json}\nscholar-bridge-data-end\n%%`;
  }

  function parseManagedData(markdown) {
    const text = String(markdown || "");
    const match = text.match(
      /%%\s*\n?scholar-bridge-data\s*\n([\s\S]*?)\nscholar-bridge-data-end\s*\n?%%/
    ) || text.match(
      /<!-- scholar-bridge-data\s*\n([\s\S]*?)\nscholar-bridge-data-end -->/
    );
    let data;
    if (match) {
      data = JSON.parse(match[1]);
    } else {
      const trimmed = text.trim();
      if (!trimmed.startsWith("{")) return null;
      data = JSON.parse(trimmed);
    }
    if (!data || ![2, 3, 4].includes(data.schema_version) || !data.entry) return null;
    data.entry = normalizeSenseIDs(data.entry);
    data.occurrences = Array.isArray(data.occurrences) ? data.occurrences : [];
    return data;
  }

  function hasOccurrence(markdown, occurrenceId) {
    const text = String(markdown || "");
    return text.includes(`%% scholar-bridge-occurrence:${occurrenceId} %%`)
      || text.includes(`<!-- occurrence:${occurrenceId} -->`)
      || parseManagedData(text)?.occurrences?.some((item) => item.occurrenceId === occurrenceId)
      || false;
  }

  function extractCitations(answer) {
    const pages = [];
    const regex = /\[p\.\s*(\d+)\]/gi;
    let match;
    while ((match = regex.exec(String(answer || "")))) {
      pages.push(Number(match[1]));
    }
    return [...new Set(pages)];
  }

  function validateCitationPages(answer, pageCount) {
    const citations = extractCitations(answer);
    return {
      citations,
      invalid: citations.filter((page) => page < 1 || page > pageCount),
      hasCitations: citations.length > 0
    };
  }

  function textFingerprint(pages) {
    const values = Array.isArray(pages) ? pages : [pages];
    let hash = 0x811c9dc5;
    let length = 0;
    for (let pageIndex = 0; pageIndex < values.length; pageIndex++) {
      const text = String(values[pageIndex] || "");
      length += text.length;
      for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      hash ^= pageIndex + 1;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, "0")}-p${values.length}-c${length}`;
  }

  function parsePaperMemoryMetadata(markdown) {
    const frontmatter = String(markdown || "").match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1];
    if (!frontmatter) return {};
    const metadata = {};
    for (const line of frontmatter.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1).replace(/\\"/g, '"');
      }
      metadata[match[1]] = value;
    }
    return metadata;
  }

  function selectConversationHistory(entries, maxChars = 16000, minimumEntries = 6) {
    const values = Array.isArray(entries) ? entries : [];
    const selected = [];
    let used = 0;
    for (let index = values.length - 1; index >= 0; index--) {
      const entry = values[index];
      const text = String(entry?.text || "");
      if (!text) continue;
      if (selected.length >= minimumEntries && used + text.length > maxChars) break;
      selected.unshift(entry);
      used += text.length;
    }
    return selected;
  }

  function normalizeMathMarkdown(markdown) {
    return String(markdown || "")
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula) => `$$\n${formula.trim()}\n$$`)
      .replace(/\\\(([^\n]*?)\\\)/g, (_match, formula) => `$${formula.trim()}$`);
  }

  function pagesForModel(pages) {
    return (pages || []).map((page, index) =>
      `[p. ${index + 1}]\n${normalizeWhitespace(page)}`
    ).filter((value) => !value.endsWith("\n")).join("\n\n---\n\n");
  }

  function groupPages(pages, maxChars = 18000) {
    const groups = [];
    let current = [];
    let length = 0;
    (pages || []).forEach((page, pageIndex) => {
      const block = `[p. ${pageIndex + 1}]\n${normalizeWhitespace(page)}`;
      if (current.length && length + block.length > maxChars) {
        groups.push({
          pageStart: current[0].pageIndex,
          pageEnd: current.at(-1).pageIndex,
          text: current.map((item) => item.block).join("\n\n")
        });
        current = [];
        length = 0;
      }
      current.push({ pageIndex, block });
      length += block.length;
    });
    if (current.length) {
      groups.push({
        pageStart: current[0].pageIndex,
        pageEnd: current.at(-1).pageIndex,
        text: current.map((item) => item.block).join("\n\n")
      });
    }
    return groups;
  }

  function paperStableID(metadata) {
    const stableKey = metadata?.citeKey
      || metadata?.zoteroItemKey
      || metadata?.attachmentKey
      || metadata?.doi
      || "paper";
    const rawTitle = normalizeWhitespace(metadata?.title || "Untitled paper");
    const shortTitle = rawTitle.length > 72
      ? `${rawTitle.slice(0, 69).trim()}...`
      : rawTitle;
    const year = String(metadata?.year || "").match(/(?:19|20)\d{2}/)?.[0] || "日期未知";
    const key = sanitizeFileName(
      String(stableKey).replace(/^https?:\/\/doi\.org\//i, "")
    ).slice(0, 32);
    return sanitizeFileName(`${year} - ${shortTitle} (${key})`);
  }

  function legacyPaperStableID(metadata) {
    const candidate = metadata?.citeKey
      || metadata?.doi
      || metadata?.zoteroItemKey
      || metadata?.attachmentKey
      || metadata?.title
      || "paper";
    return sanitizeFileName(String(candidate).replace(/^https?:\/\/doi\.org\//i, ""));
  }

  function quoteBlock(value) {
    return normalizeWhitespace(value)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  function renderSenses(senses) {
    return (Array.isArray(senses) ? senses : []).map((sense, index) => {
      const collocations = (sense.collocations || []).join(" · ");
      const examples = (sense.ai_examples || []).map((example, exampleIndex) => [
        `${exampleIndex + 1}. ${example.english || "例句待补充"}`,
        `   **中文：** ${example.chinese || "翻译待补充"}`
      ].join("\n")).join("\n\n");
      return [
        `### 义项 ${index + 1} · ${sense.part_of_speech || "词性待确认"}`,
        "",
        "> [!definition] 中文释义",
        `> **${sense.chinese_definition || "释义待补充"}**`,
        sense.english_definition ? `> *${sense.english_definition}*` : "",
        "",
        `- **使用领域：** ${sense.domain || "通用"}`,
        collocations ? `- **常见搭配：** ${collocations}` : "",
        "",
        "#### 双语例句",
        "",
        examples || "*暂无例句。*"
      ].join("\n");
    }).join("\n\n");
  }

  function renderProfessionalCollocations(senses) {
    const sections = [];
    for (const [senseIndex, sense] of (Array.isArray(senses) ? senses : []).entries()) {
      for (const note of (sense.collocation_notes || [])) {
        sections.push([
          `### ${note.phrase || "搭配待确认"}`,
          "",
          `- **对应义项：** 义项 ${senseIndex + 1}`,
          `- **专业领域：** ${note.domain || sense.domain || "通用"}`,
          `- **专业含义：** ${note.chinese_explanation || "待补充"}`,
          `- **使用说明：** ${note.usage_note || "待补充"}`
        ].join("\n"));
      }
    }
    return sections.join("\n\n");
  }

  function renderOccurrenceMarkdown(data, index = 0, senses = []) {
    const senseIndex = senses.findIndex((sense) => sense.sense_id === data.senseId);
    const senseLabel = senseIndex >= 0 ? `义项 ${senseIndex + 1}` : (data.currentSense || "待确认");
    const analysis = data.sentenceAnalysis || {};
    const structure = (analysis.structure || []).map((item) => `> - ${item}`).join("\n");
    const grammar = (analysis.grammar_points || []).map((item) => `> - ${item}`).join("\n");
    const sentenceAnalysis = [
      analysis.sentence_pattern ? `> **核心句式：** ${analysis.sentence_pattern}` : "",
      structure ? `> **结构拆解：**\n${structure}` : "",
      grammar ? `> **语法要点：**\n${grammar}` : "",
      analysis.academic_usage ? `> **学术表达提示：** ${analysis.academic_usage}` : ""
    ].filter(Boolean).join("\n>\n");
    return [
      `### 语境 ${index + 1} · 第 ${data.pageLabel || "-"} 页`,
      "",
      `**来源论文：** [${data.paperTitle || "Untitled"}](${data.zoteroLink})`,
      "",
      "> [!quote] 论文原句",
      quoteBlock(data.sentence || data.selectedText),
      "",
      "> [!tip] 本句中的含义",
      `> **${data.contextualMeaning || "待确认"}**`,
      `> 对应：${senseLabel}`,
      `> 判断依据：${data.senseReason || "根据原句和邻近上下文判断"}`,
      "",
      sentenceAnalysis ? `> [!example]- 句式与语法\n${sentenceAnalysis}` : "",
      sentenceAnalysis ? "" : "",
      `[在 Zotero 中定位到原文](${data.zoteroLink})`,
      data.contextAmbiguous
        ? "\n> [!warning] 当前页中该词出现多次；原句由本地规则匹配，请人工核对。"
        : ""
    ].join("\n");
  }

  function renderVocabularyMarkdown(entry, occurrences, options = {}) {
    entry = normalizeSenseIDs(entry);
    occurrences = Array.isArray(occurrences) ? occurrences : [occurrences].filter(Boolean);
    const occurrenceMarkdown = occurrences.map((occurrence, index) =>
      renderOccurrenceMarkdown(occurrence, index, entry.senses)
    ).join("\n\n");
    const primarySense = entry.senses[0] || {};
    const chineseDefinition = primarySense.chinese_definition
      || entry.short_definition
      || "释义待补充";
    const englishDefinition = primarySense.english_definition
      || (entry.short_definition !== chineseDefinition ? entry.short_definition : "");
    const collocationMarkdown = renderProfessionalCollocations(entry.senses);
    return [
      `> [!abstract] ${entry.lemma || entry.word} · 核心解释`,
      `> **${chineseDefinition}**`,
      englishDefinition ? `> *${englishDefinition}*` : "",
      `> ${entry.part_of_speech || "词性待确认"}　·　${entry.pronunciation || "暂无音标"}`,
      "",
      "## 论文原句与语境",
      "",
      occurrenceMarkdown || "尚无语境记录。",
      "",
      "## 专业固定搭配",
      "",
      collocationMarkdown || "*当前语境中尚未识别出需要单独说明的专业固定搭配。*",
      "",
      "## 释义与双语例句",
      "",
      renderSenses(entry.senses),
      "",
      "> [!info]- 关于本词条",
      "> 论文原句均可回跳 Zotero；双语例句由大模型生成，不冒充论文原文。",
      `> 生成模型：${entry.generated_by || "LLM"}　·　论文语境：${occurrences.length} 条`,
      "",
      "#vocabulary",
      ""
    ].join("\n");
  }

  const core = {
    normalizeWhitespace,
    splitPages,
    extractSentence,
    sanitizeFileName,
    fitSessionFileName,
    escapeYaml,
    tokenizeQuery,
    chunkPages,
    rankChunks,
    parseModelJSON,
    normalizeSenseIDs,
    mergeVocabularyEntries,
    createManagedData,
    renderManagedData,
    parseManagedData,
    hasOccurrence,
    extractCitations,
    validateCitationPages,
    textFingerprint,
    parsePaperMemoryMetadata,
    selectConversationHistory,
    normalizeMathMarkdown,
    pagesForModel,
    groupPages,
    paperStableID,
    legacyPaperStableID,
    renderOccurrenceMarkdown,
    renderVocabularyMarkdown
  };

  global.ScholarBridgeCore = core;
  if (typeof module !== "undefined" && module.exports) module.exports = core;
})(typeof globalThis !== "undefined" ? globalThis : this);
