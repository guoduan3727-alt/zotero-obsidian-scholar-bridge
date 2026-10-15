const assert = require("node:assert/strict");
const core = require("../chrome/content/scripts/core.js");

{
  const page = "Previous sentence. The proposed formulation remains tractable under many scenarios. Next sentence.";
  const result = core.extractSentence(page, "tractable");
  assert.equal(
    result.sentence,
    "The proposed formulation remains tractable under many scenarios."
  );
  assert.equal(result.ambiguous, false);
}

{
  const page = "The bank is stable. A bank may also mean a river bank.";
  const result = core.extractSentence(page, "bank");
  assert.equal(result.ambiguous, true);
}

{
  assert.equal(core.sanitizeFileName('bank: a/b? <term>.'), "bank_ a_b_ _term_");
  assert.equal(core.splitPages("page one\fpage two").length, 2);
}

{
  const directory = `C:\\Users\\Researcher\\OneDrive\\${"long-paper-folder-".repeat(10)}AI 问答记录`;
  const desiredQuestion = "完整阅读文章，总结文章的主要工作和创新点";
  const timestamp = "2026-08-23 16-08-45";
  const fileName = core.fitSessionFileName(
    directory,
    desiredQuestion,
    timestamp,
    "session-123",
    "",
    248
  );
  assert.ok(directory.length + 1 + fileName.length + ".tmp".length <= 248);
  assert.match(fileName, /\.md$/);
  assert.match(fileName, /[0-9a-f]{6}\.md$/);
  assert.equal(
    core.fitSessionFileName("C:\\Vault\\Literature", "Readable question", timestamp, "session-123"),
    "Readable question - 2026-08-23 16-08-45.md"
  );
}

{
  const chunks = [
    { pageIndex: 0, start: 0, text: "unrelated introduction" },
    { pageIndex: 4, start: 0, text: "CVaR controls tail risk in optimization" },
    { pageIndex: 7, start: 0, text: "conclusion" }
  ];
  const ranked = core.rankChunks(chunks, "Why use CVaR for tail risk?", 1);
  assert.equal(ranked[0].pageIndex, 4);
}

{
  assert.deepEqual(core.parseModelJSON("```json\n{\"ok\":true}\n```"), { ok: true });
}

{
  const entry = {
    word: "tractable",
    lemma: "tractable",
    pronunciation: "/ˈtræktəbəl/",
    part_of_speech: "adjective",
    short_definition: "可处理的",
    aliases: [],
    generated_by: "test:model",
    senses: [{
      sense_id: "sense-1",
      part_of_speech: "adjective",
      chinese_definition: "计算上可处理的",
      english_definition: "feasible to solve",
      domain: "optimization",
      collocations: ["computationally tractable"],
      collocation_notes: [{
        phrase: "computationally tractable",
        domain: "optimization",
        chinese_explanation: "在可接受计算资源内可求解",
        usage_note: "常用于描述模型或算法的计算可行性"
      }],
      ai_examples: [{ english: "The reformulation is tractable.", chinese: "该重构是可处理的。" }]
    }]
  };
  const occurrence = {
    occurrenceId: "abc123",
    selectedText: "tractable",
    paperTitle: "Paper",
    pageLabel: "12",
    sentence: "The formulation remains tractable.",
    contextAmbiguous: false,
    currentSense: "computational",
    contextualMeaning: "可求解",
    senseReason: "讨论计算复杂度",
    sentenceAnalysis: {
      sentence_pattern: "主系表结构",
      structure: ["The formulation（主语）", "remains（系动词）", "tractable（表语）"],
      grammar_points: ["remain + adjective"],
      academic_usage: "用于谨慎描述模型性质"
    },
    zoteroLink: "zotero://open-pdf/library/items/ABC?page=12",
    createdAt: "2026-08-20T00:00:00.000Z"
  };
  const markdown = core.renderVocabularyMarkdown(entry, occurrence);
  assert.match(markdown, /论文原句与语境/);
  assert.match(markdown, /双语例句/);
  assert.match(markdown, /专业固定搭配/);
  assert.match(markdown, /句式与语法/);
  assert.match(markdown, /\*\*计算上可处理的\*\*/);
  assert.doesNotMatch(markdown, /scholar-bridge-data/);
  assert.doesNotMatch(markdown, /scholar-bridge-occurrence/);
  assert.doesNotMatch(markdown, /schema_version/);
  assert.doesNotMatch(markdown, /^---$/m);
  assert.equal(core.hasOccurrence(markdown, "abc123"), false);
  const data = core.parseManagedData(JSON.stringify(core.createManagedData(entry, [occurrence])));
  assert.equal(data.schema_version, 4);
  assert.equal(data.entry.senses[0].sense_id, "sense-1");
  assert.equal(data.occurrences[0].occurrenceId, "abc123");
}

{
  const merged = core.mergeVocabularyEntries(
    {
      word: "dispatch",
      lemma: "dispatch",
      aliases: ["dispatch"],
      senses: [{
        sense_id: "sense-1",
        part_of_speech: "noun",
        chinese_definition: "调度",
        english_definition: "allocation of system resources",
        domain: "power systems",
        collocations: ["economic dispatch"],
        collocation_notes: [],
        ai_examples: [{ english: "The dispatch is feasible.", chinese: "该调度是可行的。" }]
      }],
      current_context: { sense_id: "sense-1" }
    },
    {
      word: "dispatched",
      lemma: "dispatch",
      aliases: ["dispatched"],
      senses: [{
        sense_id: "sense-1",
        part_of_speech: "noun",
        chinese_definition: "调度",
        english_definition: "allocation of system resources",
        domain: "power systems",
        collocations: ["optimal dispatch"],
        collocation_notes: [{
          phrase: "optimal dispatch",
          domain: "power systems",
          chinese_explanation: "最优调度",
          usage_note: "指满足约束的成本最优资源分配"
        }],
        ai_examples: [{ english: "Optimal dispatch reduces cost.", chinese: "最优调度降低成本。" }]
      }],
      current_context: {
        sense_id: "sense-1",
        sentence_analysis: { sentence_pattern: "被动语态" }
      }
    },
    "dispatched"
  );
  assert.equal(merged.senses.length, 1);
  assert.deepEqual(merged.senses[0].collocations, ["economic dispatch", "optimal dispatch"]);
  assert.equal(merged.senses[0].ai_examples.length, 2);
  assert.ok(merged.aliases.includes("dispatched"));
  assert.equal(merged.current_context.sentence_analysis.sentence_pattern, "被动语态");
}

{
  const deepSeekShape = {
    headword: "electricity",
    aliases: ["Electricity"],
    soundmark: "/ɪˌlekˈtrɪsəti/",
    part_of_speech: "noun",
    senses: [{
      sense_id: "sense-1",
      definition: "电力；电能",
      register_tags: ["general", "energy"],
      academic_definition: "电荷运动产生并可转换的能量形式。",
      current_context: "本文指关键基础设施中的电力系统。",
      examples: [{ en: "Electricity powers the hospital.", zh: "电力为医院供能。" }]
    }]
  };
  const normalized = core.normalizeSenseIDs(deepSeekShape);
  assert.equal(normalized.word, "electricity");
  assert.equal(normalized.lemma, "electricity");
  assert.equal(normalized.pronunciation, "/ɪˌlekˈtrɪsəti/");
  assert.equal(normalized.short_definition, "电力；电能");
  assert.equal(normalized.senses[0].chinese_definition, "电力；电能");
  assert.equal(normalized.senses[0].domain, "general, energy");
  assert.equal(normalized.senses[0].ai_examples[0].english, "Electricity powers the hospital.");
  assert.match(normalized.current_context.contextual_meaning, /关键基础设施/);
}

{
  const legacy = `<!-- scholar-bridge-data\n${JSON.stringify({
    schema_version: 2,
    entry: { headword: "bank", senses: [{ definition: "银行" }] },
    occurrences: []
  })}\nscholar-bridge-data-end -->`;
  assert.equal(core.parseManagedData(legacy).entry.lemma, "bank");
}

{
  const validation = core.validateCitationPages(
    "The method follows the assumption [p. 3] but not [p. 99].",
    12
  );
  assert.deepEqual(validation.citations, [3, 99]);
  assert.deepEqual(validation.invalid, [99]);
}

{
  const fingerprint = core.textFingerprint(["page one", "page two"]);
  assert.match(fingerprint, /^fnv1a32-[0-9a-f]{8}-p2-c16$/);
  assert.equal(fingerprint, core.textFingerprint(["page one", "page two"]));
  assert.notEqual(fingerprint, core.textFingerprint(["page one", "changed"]));
  assert.deepEqual(
    core.parsePaperMemoryMetadata("---\npdf_fingerprint: abc\nmemory_model: deepseek-v4-pro\n---\n# Memory"),
    { pdf_fingerprint: "abc", memory_model: "deepseek-v4-pro" }
  );
}

{
  const entries = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: `message-${index}-${"x".repeat(20)}`
  }));
  const selected = core.selectConversationHistory(entries, 100, 2);
  assert.ok(selected.length >= 2);
  assert.equal(selected.at(-1).text, entries.at(-1).text);
  assert.ok(selected.length < entries.length);
}

{
  assert.equal(
    core.normalizeMathMarkdown("Inline \\(x_i\\) and display:\n\\[x_i \\leq 1\\]"),
    "Inline $x_i$ and display:\n$$\nx_i \\leq 1\n$$"
  );
}

{
  const groups = core.groupPages(["a".repeat(10), "b".repeat(10), "c".repeat(10)], 30);
  assert.equal(groups.length, 3);
  assert.match(groups[0].text, /\[p\. 1\]/);
}

{
  assert.equal(
    core.paperStableID({
      citeKey: "Smith2026",
      zoteroItemKey: "ABC123",
      year: "2026-04-01",
      title: "A Readable Paper Title"
    }),
    "2026 - A Readable Paper Title (Smith2026)"
  );
  assert.equal(
    core.legacyPaperStableID({ citeKey: "Smith2026", zoteroItemKey: "ABC123" }),
    "Smith2026"
  );
  assert.equal(core.sanitizeFileName("question [draft] #1"), "question _draft_ _1");
}

console.log("core tests passed");
