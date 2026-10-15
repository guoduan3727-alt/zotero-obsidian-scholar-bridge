/* global Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils, rootURI, ScholarBridgeCore, ScholarBridgeKatex */

var ObsidianScholarBridge = (() => {
  "use strict";

  const ADDON_ID = "obsidian-scholar-bridge@local";
  const PREF_ROOT = "extensions.obsidian-scholar-bridge.";
  const LOGIN_ORIGIN = "chrome://obsidian-scholar-bridge";
  const LOGIN_REALM = "Obsidian Scholar Bridge API Keys";
  const PAPER_HOME_FILE = "00 - 论文索引.md";
  const PAPER_MEMORY_FILE = "01 - 全文记忆.md";
  const PAPER_SESSIONS_FOLDER = "AI 问答记录";
  const SESSION_SCHEMA_VERSION = 1;
  const PROVIDER_PRESETS = Object.freeze({
    openai: Object.freeze({
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5.6-luna",
      deepModel: "gpt-5.6-sol",
      protocol: "responses"
    }),
    deepseek: Object.freeze({
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      deepModel: "deepseek-v4-pro",
      protocol: "chat-completions"
    }),
    generic: Object.freeze({
      baseURL: "http://localhost:11434/v1",
      model: "",
      deepModel: "",
      protocol: "chat-completions"
    })
  });
  const WORKSPACE_THEMES = Object.freeze({
    auto: Object.freeze({ label: "自动", accent: "#52606d", contrast: "#ffffff" }),
    violet: Object.freeze({ label: "紫罗兰", accent: "#6c5ce7", contrast: "#ffffff" }),
    ocean: Object.freeze({ label: "海洋蓝", accent: "#2563a8", contrast: "#ffffff" }),
    forest: Object.freeze({ label: "森林绿", accent: "#24745b", contrast: "#ffffff" }),
    amber: Object.freeze({ label: "暖琥珀", accent: "#a45b13", contrast: "#ffffff" }),
    graphite: Object.freeze({ label: "石墨灰", accent: "#4b5563", contrast: "#ffffff" })
  });
  const textCache = new Map();
  const paperMemoryCache = new Map();
  const conversations = new Map();
  const paperSessionStates = new Map();
  const vocabularyPreviews = new Map();
  const vocabularyPreviewViews = new Set();
  const vocabularyIndex = new Map();
  let vocabularyIndexReady = false;
  let toolsMenuID = null;
  let selectionHandler = null;
  let toolbarHandler = null;

  const DICTIONARY_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      word: { type: "string" },
      lemma: { type: "string" },
      pronunciation: { type: "string" },
      part_of_speech: { type: "string" },
      short_definition: { type: "string" },
      aliases: { type: "array", items: { type: "string" } },
      senses: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            sense_id: { type: "string" },
            part_of_speech: { type: "string" },
            chinese_definition: { type: "string" },
            english_definition: { type: "string" },
            domain: { type: "string" },
            collocations: { type: "array", items: { type: "string" } },
            collocation_notes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  phrase: { type: "string" },
                  domain: { type: "string" },
                  chinese_explanation: { type: "string" },
                  usage_note: { type: "string" }
                },
                required: ["phrase", "domain", "chinese_explanation", "usage_note"]
              }
            },
            ai_examples: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  english: { type: "string" },
                  chinese: { type: "string" }
                },
                required: ["english", "chinese"]
              }
            }
          },
          required: [
            "sense_id",
            "part_of_speech",
            "chinese_definition",
            "english_definition",
            "domain",
            "collocations",
            "collocation_notes",
            "ai_examples"
          ]
        }
      },
      current_context: {
        type: "object",
        additionalProperties: false,
        properties: {
          sense_id: { type: "string" },
          sense_label: { type: "string" },
          contextual_meaning: { type: "string" },
          reason: { type: "string" },
          sentence_analysis: {
            type: "object",
            additionalProperties: false,
            properties: {
              sentence_pattern: { type: "string" },
              structure: { type: "array", items: { type: "string" } },
              grammar_points: { type: "array", items: { type: "string" } },
              academic_usage: { type: "string" }
            },
            required: ["sentence_pattern", "structure", "grammar_points", "academic_usage"]
          }
        },
        required: ["sense_id", "sense_label", "contextual_meaning", "reason", "sentence_analysis"]
      }
    },
    required: [
      "word",
      "lemma",
      "pronunciation",
      "part_of_speech",
      "short_definition",
      "aliases",
      "senses",
      "current_context"
    ]
  };

  function pref(name, fallback = "") {
    const value = Zotero.Prefs.get(PREF_ROOT + name, true);
    return value === undefined || value === null ? fallback : value;
  }

  function setPref(name, value) {
    Zotero.Prefs.set(PREF_ROOT + name, value, true);
  }

  function applyWorkspaceTheme(element, themeName = null) {
    if (!element?.style) return;
    const name = WORKSPACE_THEMES[themeName]
      ? themeName
      : String(pref("workspaceTheme", "ocean"));
    const theme = WORKSPACE_THEMES[name] || WORKSPACE_THEMES.ocean;
    element.style.setProperty("--sb-accent", theme.accent);
    element.style.setProperty("--sb-accent-contrast", theme.contrast);
    element.style.setProperty("--sb-accent-soft", `color-mix(in srgb, ${theme.accent} 11%, var(--material-background,#fff))`);
    element.style.setProperty("--sb-accent-softer", `color-mix(in srgb, ${theme.accent} 6%, var(--material-background,#fff))`);
    element.setAttribute?.("data-scholar-bridge-theme", name);
  }

  function getProviderDefaults(provider) {
    return { ...(PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.generic) };
  }

  function getProviderConfig(quality = "fast") {
    const selectedProvider = String(pref("provider", "openai")).trim().toLocaleLowerCase();
    const provider = PROVIDER_PRESETS[selectedProvider] ? selectedProvider : "openai";
    const defaults = getProviderDefaults(provider);
    const fastModel = String(pref(`${provider}.model`, defaults.model)).trim() || defaults.model;
    const deepModel = String(pref(`${provider}.deepModel`, defaults.deepModel)).trim()
      || defaults.deepModel
      || fastModel;
    return {
      provider,
      baseURL: (String(pref(`${provider}.baseURL`, defaults.baseURL)).trim() || defaults.baseURL)
        .replace(/\/+$/, ""),
      model: quality === "deep" ? deepModel : fastModel,
      fastModel,
      deepModel,
      quality,
      protocol: defaults.protocol
    };
  }

  async function getAPIKey(provider = getProviderConfig().provider) {
    try {
      const logins = await Services.logins.searchLoginsAsync({
        origin: LOGIN_ORIGIN,
        httpRealm: LOGIN_REALM
      });
      return logins.find((login) => login.username === provider)?.password || "";
    } catch (error) {
      Zotero.logError(error);
      return "";
    }
  }

  async function setAPIKey(provider, apiKey) {
    const logins = await Services.logins.searchLoginsAsync({
      origin: LOGIN_ORIGIN,
      httpRealm: LOGIN_REALM
    });
    for (const login of logins.filter((item) => item.username === provider)) {
      Services.logins.removeLogin(login);
    }
    if (!apiKey) return;
    const LoginInfo = new Components.Constructor(
      "@mozilla.org/login-manager/loginInfo;1",
      Components.interfaces.nsILoginInfo,
      "init"
    );
    const login = new LoginInfo(
      LOGIN_ORIGIN,
      null,
      LOGIN_REALM,
      provider,
      apiKey,
      "",
      ""
    );
    await Services.logins.addLoginAsync(login);
  }

  function endpoint(baseURL, suffix) {
    if (!baseURL) throw new Error("请先配置 API Base URL");
    return `${baseURL}/${suffix.replace(/^\/+/, "")}`;
  }

  function extractResponsesText(response) {
    if (typeof response.output_text === "string") return response.output_text;
    const texts = [];
    for (const item of response.output || []) {
      if (item.type !== "message") continue;
      for (const content of item.content || []) {
        if (content.type === "output_text" && content.text) texts.push(content.text);
      }
    }
    return texts.join("\n");
  }

  async function postJSON(url, body, apiKey) {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const xhr = await Zotero.HTTP.request("POST", url, {
      body: JSON.stringify(body),
      headers,
      responseType: "json",
      timeout: 90000
    });
    return xhr.response;
  }

  async function callModel({
    system,
    user,
    structured = false,
    structuredSchema = DICTIONARY_SCHEMA,
    structuredName = "academic_dictionary_entry",
    quality = "fast"
  }) {
    const config = getProviderConfig(quality);
    if (!config.model) throw new Error("请先配置模型名称");
    const apiKey = await getAPIKey(config.provider);
    if (!apiKey && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(config.baseURL)) {
      throw new Error(`尚未为 ${config.provider} 保存 API Key`);
    }

    if (config.protocol === "responses") {
      const body = {
        model: config.model,
        input: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      };
      if (structured) {
        body.text = {
          format: {
            type: "json_schema",
            name: structuredName,
            strict: true,
            schema: structuredSchema
          }
        };
      }
      const response = await postJSON(endpoint(config.baseURL, "responses"), body, apiKey);
      const text = extractResponsesText(response);
      if (!text) throw new Error("OpenAI Responses API 返回了空内容");
      return text;
    }

    const body = {
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    };
    if (config.provider === "deepseek") {
      body.thinking = { type: quality === "deep" ? "enabled" : "disabled" };
      if (quality === "deep") body.reasoning_effort = "high";
    } else {
      body.temperature = 0.2;
    }
    if (structured) body.response_format = { type: "json_object" };
    let response;
    try {
      response = await postJSON(endpoint(config.baseURL, "chat/completions"), body, apiKey);
    } catch (error) {
      if (!structured || config.provider !== "generic") throw error;
      delete body.response_format;
      response = await postJSON(endpoint(config.baseURL, "chat/completions"), body, apiKey);
    }
    const text = response?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Chat Completions API 返回了空内容");
    return text;
  }

  function relativeSegments(relativePath) {
    const value = String(relativePath || "").trim();
    if (!value || /^[A-Za-z]:|^[\\/]/.test(value)) {
      throw new Error("Obsidian 子目录必须是相对路径");
    }
    const segments = value.split(/[\\/]+/).filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new Error("Obsidian 子目录不能包含 . 或 ..");
    }
    return segments;
  }

  function vaultFilePath(folderPref, ...pathParts) {
    const vault = String(pref("vaultPath", "")).trim();
    if (!vault) throw new Error("请先在 Zotero 设置中选择 Obsidian Vault");
    const segments = [
      ...relativeSegments(folderPref),
      ...pathParts.flatMap((part) => relativeSegments(String(part)))
    ];
    return PathUtils.join(vault, ...segments);
  }

  async function ensureParentDirectory(filePath) {
    const parentPath = PathUtils.parent(filePath);
    await IOUtils.makeDirectory(parentPath, {
      createAncestors: true,
      ignoreExisting: true
    });
    if (!(await IOUtils.exists(parentPath))) {
      throw new Error(`无法创建 Obsidian 目录：${parentPath}`);
    }
  }

  async function writeUTF8(filePath, content) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await ensureParentDirectory(filePath);
      try {
        await IOUtils.writeUTF8(filePath, content, { tmpPath: `${filePath}.tmp` });
        return;
      } catch (error) {
        lastError = error;
        const retryable = /NS_ERROR_FILE_NOT_FOUND|failed to open file for writing|Could not write/i.test(
          String(error?.message || error)
        );
        if (!retryable) throw error;
      }
    }
    try {
      await ensureParentDirectory(filePath);
      await IOUtils.writeUTF8(filePath, content);
      return;
    } catch (error) {
      lastError = error;
    }
    const pathHint = `${filePath}.tmp`.length >= 248
      ? "保存路径仍然过长，请在设置中选择层级更浅的 Vault 根目录"
      : "目录可能被 OneDrive 或外部程序移动，请确认 Vault 当前可写";
    throw new Error(`${pathHint}。原始错误：${lastError?.message || String(lastError)}`);
  }

  function vocabularyBaseName(markdownPath) {
    return String(markdownPath || "")
      .split(/[\\/]/)
      .at(-1)
      .replace(/\.md$/i, "");
  }

  function vocabularyDataPath(markdownPath) {
    return vaultFilePath(
      ".scholar-bridge",
      "vocabulary",
      `${vocabularyBaseName(markdownPath)}.json`
    );
  }

  function vocabularyLegacyPath(markdownPath) {
    return vaultFilePath(
      ".scholar-bridge",
      "legacy-vocabulary",
      `${vocabularyBaseName(markdownPath)}.md`
    );
  }

  async function readVocabularyData(markdownPath, markdown = null) {
    const dataPath = vocabularyDataPath(markdownPath);
    if (await IOUtils.exists(dataPath)) {
      try {
        return ScholarBridgeCore.parseManagedData(await IOUtils.readUTF8(dataPath));
      } catch (error) {
        Zotero.logError(error);
      }
    }
    if (markdown === null && await IOUtils.exists(markdownPath)) {
      markdown = await IOUtils.readUTF8(markdownPath);
    }
    return ScholarBridgeCore.parseManagedData(markdown || "");
  }

  function managedDataHasOccurrence(data, occurrenceId) {
    return Boolean(data?.occurrences?.some((item) => item.occurrenceId === occurrenceId));
  }

  function getAnnotationPosition(annotation) {
    if (!annotation?.position) return {};
    if (typeof annotation.position === "string") {
      try { return JSON.parse(annotation.position); } catch (_error) { return {}; }
    }
    return annotation.position;
  }

  async function getAttachmentPages(attachment, force = false) {
    if (!force && textCache.has(attachment.id)) return textCache.get(attachment.id);
    const result = await Zotero.PDFWorker.getFullText(attachment.id);
    let pages;
    if (Array.isArray(result?.pages)) {
      pages = result.pages.map((page) =>
        ScholarBridgeCore.normalizeWhitespace(page?.text ?? page)
      );
    } else {
      pages = ScholarBridgeCore.splitPages(result?.text || "");
    }
    textCache.set(attachment.id, pages);
    return pages;
  }

  function creatorsText(item) {
    try {
      return item.getCreators()
        .map((creator) => [creator.firstName, creator.lastName].filter(Boolean).join(" "))
        .filter(Boolean)
        .join(", ");
    } catch (_error) {
      return "";
    }
  }

  function citationKey(item) {
    if (!item) return "";
    try {
      const direct = item.getField("citationKey");
      if (direct) return String(direct).trim();
    } catch (_error) {}
    try {
      const extra = String(item.getField("extra") || "");
      const match = extra.match(/^Citation Key:\s*(.+)$/im);
      return match ? match[1].trim() : "";
    } catch (_error) {
      return "";
    }
  }

  function itemMetadata(attachment) {
    const parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : attachment;
    const metadata = {
      title: parent?.getField("title") || attachment.getField("title") || "Untitled",
      authors: parent ? creatorsText(parent) : "",
      year: parent?.getField("date") || "",
      publication: parent?.getField("publicationTitle") || "",
      doi: parent?.getField("DOI") || "",
      citeKey: citationKey(parent),
      zoteroItemKey: parent?.key || attachment.key,
      attachmentKey: attachment.key,
      parent,
      attachment
    };
    metadata.paperId = ScholarBridgeCore.paperStableID(metadata);
    metadata.legacyPaperId = ScholarBridgeCore.legacyPaperStableID(metadata);
    return metadata;
  }

  async function resolveAttachment(item) {
    if (!item) throw new Error("当前没有选中文献");
    if (item.isPDFAttachment?.()) return item;
    if (item.isAttachment?.() && !item.isPDFAttachment?.()) {
      throw new Error("当前附件不是 PDF");
    }
    if (item.isRegularItem?.()) {
      const best = await item.getBestAttachment?.();
      if (best?.isPDFAttachment?.()) return best;
      const ids = item.getAttachments?.() || [];
      for (const id of ids) {
        const attachment = Zotero.Items.get(id);
        if (attachment?.isPDFAttachment?.()) return attachment;
      }
    }
    throw new Error("没有找到可读取的 PDF 附件");
  }

  function zoteroPDFLink(attachment, pageLabel) {
    const scope = attachment.library?.libraryType === "group"
      ? `groups/${attachment.libraryID}`
      : "library";
    const page = encodeURIComponent(pageLabel || "1");
    return `zotero://open-pdf/${scope}/items/${attachment.key}?page=${page}`;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function showProgress(title, message, isError = false) {
    try {
      const progress = new Zotero.ProgressWindow();
      progress.changeHeadline(title);
      progress.addDescription(message);
      if (isError) progress.show();
      else progress.show();
      progress.startCloseTimer(isError ? 8000 : 4000);
    } catch (_error) {
      Zotero.debug(`${title}: ${message}`);
    }
  }

  async function buildVocabularyIndex(force = false) {
    if (vocabularyIndexReady && !force) return;
    vocabularyIndex.clear();
    vocabularyIndexReady = true;
    let directory;
    try {
      directory = PathUtils.parent(vaultFilePath(
        pref("vocabularyFolder", "Vocabulary"),
        "index-placeholder.md"
      ));
      if (!(await IOUtils.exists(directory))) return;
      const children = await IOUtils.getChildren(directory);
      for (const child of children.filter((path) => path.toLocaleLowerCase().endsWith(".md"))) {
        try {
          const data = await readVocabularyData(child);
          if (!data) continue;
          const terms = [
            data.entry.word,
            data.entry.lemma,
            ...(data.entry.aliases || [])
          ].filter(Boolean);
          for (const term of terms) {
            vocabularyIndex.set(String(term).toLocaleLowerCase(), child);
          }
        } catch (error) {
          Zotero.logError(error);
        }
      }
    } catch (error) {
      Zotero.logError(error);
    }
  }

  async function findVocabularyFile(selectedText) {
    const directName = `${ScholarBridgeCore.sanitizeFileName(selectedText.toLocaleLowerCase())}.md`;
    const directPath = vaultFilePath(pref("vocabularyFolder", "Vocabulary"), directName);
    if (await IOUtils.exists(directPath)) return directPath;
    await buildVocabularyIndex();
    const key = selectedText.toLocaleLowerCase();
    let indexedPath = vocabularyIndex.get(key) || null;
    if (indexedPath && !(await IOUtils.exists(indexedPath))) {
      vocabularyIndex.delete(key);
      await buildVocabularyIndex(true);
      indexedPath = vocabularyIndex.get(key) || null;
    }
    return indexedPath && await IOUtils.exists(indexedPath) ? indexedPath : null;
  }

  function needsVocabularyMigration(markdown) {
    const text = String(markdown || "");
    return text.includes("scholar-bridge-data")
      || text.includes("scholar-bridge-occurrence:")
      || !text.includes("## 专业固定搭配")
      || !text.includes("句式与语法")
      || !text.includes("## 释义与双语例句")
      || !text.includes("## 论文原句与语境");
  }

  function compactDictionaryForMerge(entry) {
    const normalized = ScholarBridgeCore.normalizeSenseIDs(entry || {});
    return {
      word: normalized.word,
      lemma: normalized.lemma,
      pronunciation: normalized.pronunciation,
      part_of_speech: normalized.part_of_speech,
      short_definition: normalized.short_definition,
      aliases: normalized.aliases,
      senses: normalized.senses.map((sense) => ({
        sense_id: sense.sense_id,
        part_of_speech: sense.part_of_speech,
        chinese_definition: sense.chinese_definition,
        english_definition: sense.english_definition,
        domain: sense.domain,
        collocations: (sense.collocations || []).slice(0, 8),
        collocation_notes: (sense.collocation_notes || []).slice(0, 4)
      }))
    };
  }

  async function buildDictionary(selectedText, sentenceData, metadata, existing = null) {
    const system = [
      "你是一名严谨的英汉学术词典编辑。",
      "输出必须匹配给定 JSON 结构。",
      "区分通用义项、学术/专业义项和当前论文语境。",
      "每个义项必须有稳定 sense_id，格式为 sense-1、sense-2；合并旧词条时保留已有 sense_id。",
      "新语境若匹配已有义项，只补充 current_context；确有新含义时才新增义项。",
      "允许修正明显错误，但不要删除仍然有效的已有义项、搭配和例句。",
      "aliases 必须包含本次实际遇到的词形，便于以后直接命中同一词条。",
      "为每个重要义项生成 1-2 条简短英文例句及中文翻译。",
      "对当前语境中真正专业且固定的搭配生成 collocation_notes，每项给出领域、专业含义和使用限制；不要把逐词翻译冒充固定搭配。",
      "在 current_context.sentence_analysis 中一次完成原句的核心句式、成分结构、关键语法和学术写作作用分析。",
      "优先复用已有 sense_id；不要因为措辞略有不同而重复创建相同义项。",
      "不要把 AI 例句伪装成论文原句。",
      "如果音标或词形不确定，用空字符串，不要猜测。"
    ].join("\n");
    const user = [
      `待解释词语：${selectedText}`,
      `论文标题：${metadata.title}`,
      `作者：${metadata.authors || "未知"}`,
      `期刊/会议：${metadata.publication || "未知"}`,
      "论文原句：",
      sentenceData.sentence,
      "附近上下文：",
      sentenceData.context.slice(0, 2200),
      "返回字段使用 word、lemma、pronunciation、part_of_speech、short_definition、aliases、senses、current_context。结构由接口约束，不要输出额外说明。",
      existing?.entry
        ? `已有义项目录，请判断当前语境应匹配哪一个；只返回本次分析所需的完整候选结构，本地会保留旧内容并确定性合并：\n${JSON.stringify(compactDictionaryForMerge(existing.entry))}`
        : "这是首次创建该词条。",
      existing?.legacyMarkdown
        ? `旧版 Markdown 词条，请提取有效义项并安全迁移：\n${existing.legacyMarkdown.slice(0, 12000)}`
        : ""
    ].join("\n\n");
    // Vocabulary generation is deliberately locked to the configured fast
    // model. This includes first creation, legacy migration and sense merging.
    const quality = "fast";
    const raw = await callModel({
      system,
      user,
      structured: true,
      quality
    });
    let entry = ScholarBridgeCore.normalizeSenseIDs(
      ScholarBridgeCore.parseModelJSON(raw)
    );
    const modelConfig = getProviderConfig(quality);
    entry.generated_by = `${modelConfig.provider}:${modelConfig.model}`;
    if (existing?.entry) {
      entry = ScholarBridgeCore.mergeVocabularyEntries(existing.entry, entry, selectedText);
      entry.generated_by = `${modelConfig.provider}:${modelConfig.model}`;
    }
    return entry;
  }

  async function prepareVocabulary({ reader, annotation }) {
    const selectedText = ScholarBridgeCore.normalizeWhitespace(annotation?.text || "");
    if (!selectedText) throw new Error("没有读取到选中的文字");
    if (selectedText.length > 160) throw new Error("请选择单词、短语或较短术语");

    const attachment = await resolveAttachment(Zotero.Items.get(reader.itemID));
    const metadata = itemMetadata(attachment);
    const position = getAnnotationPosition(annotation);
    const pageIndex = Number.isInteger(position.pageIndex)
      ? position.pageIndex
      : Math.max(0, Number(attachment.getAttachmentLastPageIndex?.()) || 0);
    const pages = await getAttachmentPages(attachment);
    const pageText = pages[pageIndex] || pages[0] || selectedText;
    const sentenceData = ScholarBridgeCore.extractSentence(pageText, selectedText);
    const pageLabel = annotation?.pageLabel || String(pageIndex + 1);
    const createdAt = new Date().toISOString();
    const occurrenceId = hashString([
      attachment.libraryID,
      attachment.key,
      pageLabel,
      sentenceData.sentence
    ].join("|"));
    let filePath = await findVocabularyFile(selectedText);
    let existingMarkdown = "";
    let existingData = null;
    let duplicateOccurrence = false;
    let migrationRequired = false;
    if (filePath) {
      existingMarkdown = await IOUtils.readUTF8(filePath);
      existingData = await readVocabularyData(filePath, existingMarkdown);
      if (managedDataHasOccurrence(existingData, occurrenceId)
          || ScholarBridgeCore.hasOccurrence(existingMarkdown, occurrenceId)) {
        const needsMigration = needsVocabularyMigration(existingMarkdown);
        if (!needsMigration) {
          return {
            attachmentID: attachment.id,
            filePath,
            entry: existingData?.entry || { word: selectedText, lemma: selectedText, senses: [] },
            occurrences: existingData?.occurrences || [],
            duplicate: true,
            needsMigration: false,
            legacyContent: "",
            saved: true
          };
        }
        duplicateOccurrence = true;
        migrationRequired = true;
      }
    }
    let entry = await buildDictionary(selectedText, sentenceData, metadata, filePath ? {
      entry: existingData?.entry || null,
      legacyMarkdown: existingData ? "" : existingMarkdown
    } : null);
    const lemma = entry.lemma || entry.word || selectedText;
    const canonicalPath = vaultFilePath(
      pref("vocabularyFolder", "Vocabulary"),
      `${ScholarBridgeCore.sanitizeFileName(lemma.toLocaleLowerCase())}.md`
    );
    if (!filePath && await IOUtils.exists(canonicalPath)) {
      filePath = canonicalPath;
      existingMarkdown = await IOUtils.readUTF8(filePath);
      existingData = await readVocabularyData(filePath, existingMarkdown);
      if (managedDataHasOccurrence(existingData, occurrenceId)
          || ScholarBridgeCore.hasOccurrence(existingMarkdown, occurrenceId)) {
        const needsMigration = needsVocabularyMigration(existingMarkdown);
        if (!needsMigration) {
          return {
            attachmentID: attachment.id,
            filePath,
            entry: existingData?.entry || entry,
            occurrences: existingData?.occurrences || [],
            duplicate: true,
            needsMigration: false,
            legacyContent: "",
            saved: true
          };
        }
        duplicateOccurrence = true;
        migrationRequired = true;
      }
      entry = await buildDictionary(selectedText, sentenceData, metadata, {
        entry: existingData?.entry || null,
        legacyMarkdown: existingData ? "" : existingMarkdown
      });
    }
    const current = entry.current_context || {};
    const occurrence = {
      occurrenceId,
      selectedText,
      paperTitle: metadata.title,
      pageLabel,
      sentence: sentenceData.sentence,
      contextAmbiguous: sentenceData.ambiguous,
      paperId: metadata.paperId,
      zoteroItemKey: metadata.zoteroItemKey,
      attachmentKey: metadata.attachmentKey,
      senseId: current.sense_id,
      currentSense: current.sense_label,
      contextualMeaning: current.contextual_meaning,
      senseReason: current.reason,
      sentenceAnalysis: current.sentence_analysis || {},
      zoteroLink: zoteroPDFLink(attachment, pageLabel),
      createdAt
    };
    filePath ||= canonicalPath;
    const occurrences = [...(existingData?.occurrences || [])];
    const existingOccurrenceIndex = occurrences.findIndex((item) => item.occurrenceId === occurrenceId);
    if (existingOccurrenceIndex >= 0) {
      occurrences[existingOccurrenceIndex] = { ...occurrences[existingOccurrenceIndex], ...occurrence };
      duplicateOccurrence = true;
    } else {
      occurrences.push(occurrence);
    }
    return {
      attachmentID: attachment.id,
      filePath,
      entry,
      occurrence,
      occurrences,
      legacyContent: existingMarkdown && needsVocabularyMigration(existingMarkdown)
        ? existingMarkdown
        : "",
      duplicate: duplicateOccurrence,
      needsMigration: migrationRequired || Boolean(existingMarkdown && needsVocabularyMigration(existingMarkdown)),
      saved: false
    };
  }

  async function commitVocabulary(preview) {
    if (!preview) throw new Error("没有可保存的词典预览");
    const markdownExists = await IOUtils.exists(preview.filePath);
    const managedPath = vocabularyDataPath(preview.filePath);
    const managedExists = await IOUtils.exists(managedPath);
    const recoveryNeeded = !markdownExists || !managedExists;
    preview.restored = false;
    if ((preview.duplicate && !preview.needsMigration) || preview.saved) {
      if (markdownExists && managedExists) return preview;
      preview.saved = false;
      preview.needsMigration = true;
    }

    let latestData = null;
    if (markdownExists || managedExists) {
      latestData = await readVocabularyData(preview.filePath);
      if (!preview.needsMigration && preview.occurrence
          && managedDataHasOccurrence(latestData, preview.occurrence.occurrenceId)) {
        preview.duplicate = true;
        preview.saved = true;
        return preview;
      }
    }
    if (latestData?.entry) {
      preview.entry = ScholarBridgeCore.mergeVocabularyEntries(
        latestData.entry,
        preview.entry,
        preview.occurrence?.selectedText || preview.entry?.word
      );
      const occurrenceMap = new Map();
      for (const occurrence of [
        ...(latestData.occurrences || []),
        ...(preview.occurrences || [])
      ]) {
        if (occurrence?.occurrenceId) occurrenceMap.set(occurrence.occurrenceId, occurrence);
      }
      preview.occurrences = [...occurrenceMap.values()];
    }
    if (preview.legacyContent) {
      const legacyPath = vocabularyLegacyPath(preview.filePath);
      if (!(await IOUtils.exists(legacyPath))) {
        await writeUTF8(legacyPath, preview.legacyContent);
      }
    }
    await writeUTF8(
      managedPath,
      JSON.stringify(
        ScholarBridgeCore.createManagedData(preview.entry, preview.occurrences),
        null,
        2
      ) + "\n"
    );
    await writeUTF8(preview.filePath, ScholarBridgeCore.renderVocabularyMarkdown(
      preview.entry,
      preview.occurrences
    ));
    const entry = preview.entry;
    for (const term of [entry.word, entry.lemma, ...(entry.aliases || [])].filter(Boolean)) {
      vocabularyIndex.set(String(term).toLocaleLowerCase(), preview.filePath);
    }
    preview.saved = true;
    preview.needsMigration = false;
    preview.restored = recoveryNeeded;
    return preview;
  }

  async function saveVocabulary(args) {
    return commitVocabulary(await prepareVocabulary(args));
  }

  async function refreshVocabularyPreviewViews(attachmentID) {
    for (const view of [...vocabularyPreviewViews]) {
      let connected = false;
      try {
        connected = Boolean(view.body?.isConnected);
      } catch (_error) {
        connected = false;
      }
      if (!connected) {
        vocabularyPreviewViews.delete(view);
        continue;
      }
      try {
        await view.refresh(attachmentID);
      } catch (error) {
        if (/dead object/i.test(String(error?.message || error))) {
          vocabularyPreviewViews.delete(view);
          continue;
        }
        throw error;
      }
    }
  }

  function safelyUpdateTransientControl(control, properties) {
    try {
      if (!control) return false;
      for (const [name, value] of Object.entries(properties || {})) {
        control[name] = value;
      }
      return true;
    } catch (error) {
      if (!/dead object/i.test(String(error?.message || error))) Zotero.logError(error);
      return false;
    }
  }

  function registerSelectionPopup() {
    selectionHandler = (event) => {
      const { reader, doc, params, append } = event;
      const selectedRaw = String(params?.annotation?.text || "").replace(/\r/g, "").trim();
      const selected = ScholarBridgeCore.normalizeWhitespace(selectedRaw);
      if (!selected) return;
      const askButton = createHTMLElement(doc, "button");
      askButton.type = "button";
      askButton.textContent = "💬 引用到论文问答";
      askButton.title = "把选中文字或公式加入论文 AI 工作台的提问框";
      askButton.style.cssText = [
        "margin:4px 6px",
        "padding:5px 9px",
        "border-radius:6px",
        "border:1px solid color-mix(in srgb, var(--sb-accent,#2563a8) 55%, currentColor 20%)",
        "background:color-mix(in srgb, var(--sb-accent,#2563a8) 12%, transparent)",
        "color:inherit",
        "cursor:pointer"
      ].join(";");
      askButton.addEventListener("click", async () => {
        askButton.disabled = true;
        try {
          const position = getAnnotationPosition(params.annotation);
          const pageLabel = params.annotation?.pageLabel
            || (Number.isInteger(position.pageIndex) ? String(position.pageIndex + 1) : "当前页");
          const limited = selectedRaw.length > 12000
            ? `${selectedRaw.slice(0, 12000)}\n\n[选区过长，已截取前 12000 个字符]`
            : selectedRaw;
          const quote = limited.split(/\n/).map((line) => `> ${line}`).join("\n");
          const promptText = `请结合论文上下文解释以下选中内容（p. ${pageLabel}）：\n\n${quote}\n\n我的问题：`;
          await focusPaperAIWorkspace(reader, "chat");
          const readerDoc = reader?._iframeWindow?.document;
          const workspace = readerDoc?.getElementById("obsidian-scholar-bridge-workspace-drawer")?._workspaceBody;
          if (!workspace?._scholarBridgeInsertQuestion) throw new Error("论文问答输入框尚未准备好");
          workspace._scholarBridgeInsertQuestion(promptText);
          safelyUpdateTransientControl(askButton, { textContent: "✓ 已加入提问框" });
          showProgress("论文问答", `已引用第 ${pageLabel} 页选区，请补充问题后提交`);
        } catch (error) {
          Zotero.logError(error);
          safelyUpdateTransientControl(askButton, {
            disabled: false,
            textContent: "⚠ 引用失败，点击重试",
            title: error.message
          });
        }
      });
      append(askButton);
      if (selected.length > 160) return;
      const button = createHTMLElement(doc, "button");
      button.type = "button";
      button.textContent = "✨ 生成 AI 词典预览";
      button.title = "先在论文 AI 工作台中预览，再确认写入 Obsidian";
      button.style.cssText = [
        "margin:4px 6px",
        "padding:5px 9px",
        "border-radius:6px",
        "border:1px solid color-mix(in srgb, currentColor 25%, transparent)",
        "background:transparent",
        "color:inherit",
        "cursor:pointer"
      ].join(";");
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "⏳ 正在生成…";
        try {
          const result = await prepareVocabulary({ reader, annotation: params.annotation });
          vocabularyPreviews.set(result.attachmentID, result);
          await focusPaperAIWorkspace(reader, "dictionary");
          await new Promise((resolve) => setTimeout(resolve, 250));
          await refreshVocabularyPreviewViews(result.attachmentID);
          safelyUpdateTransientControl(button, { textContent: result.needsMigration
            ? "✓ 旧词条可更新"
            : result.duplicate
              ? "✓ 该语境已存在"
              : "✓ 预览已生成" });
          showProgress(
            "AI 词典预览",
            result.duplicate
              ? result.needsMigration
                ? "该语境已存在；请在右侧预览并更新为新版词条格式"
                : "该论文语境已经记录"
              : `已生成 ${result.entry.lemma || selected}，请在论文 AI 工作台中确认保存`
          );
        } catch (error) {
          Zotero.logError(error);
          safelyUpdateTransientControl(button, {
            disabled: false,
            textContent: "⚠ 生成失败，点击重试",
            title: error.message
          });
          showProgress("AI 词典预览失败", error.message, true);
        }
      });
      append(button);
    };
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      selectionHandler,
      ADDON_ID
    );
  }

  function getActiveReader() {
    for (const win of Zotero.getMainWindows()) {
      const tabID = win.Zotero_Tabs?.selectedID;
      const reader = tabID ? Zotero.Reader.getByTabID(tabID) : null;
      if (reader) return reader;
    }
    return null;
  }

  function enableWorkspaceDragging(drawer, handle) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button,select,input,textarea,a")) return;
      const view = drawer.ownerDocument.defaultView;
      const rect = drawer.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      drawer.style.left = `${startLeft}px`;
      drawer.style.top = `${startTop}px`;
      drawer.style.right = "auto";
      drawer.style.bottom = "auto";
      drawer.dataset.maximized = "false";
      const move = (moveEvent) => {
        const maxLeft = Math.max(0, view.innerWidth - drawer.offsetWidth);
        const maxTop = Math.max(0, view.innerHeight - 44);
        drawer.style.left = `${Math.min(maxLeft, Math.max(0, startLeft + moveEvent.clientX - startX))}px`;
        drawer.style.top = `${Math.min(maxTop, Math.max(0, startTop + moveEvent.clientY - startY))}px`;
      };
      const stop = () => {
        view.removeEventListener("pointermove", move);
        view.removeEventListener("pointerup", stop);
        handle.releasePointerCapture?.(event.pointerId);
      };
      handle.setPointerCapture?.(event.pointerId);
      view.addEventListener("pointermove", move);
      view.addEventListener("pointerup", stop);
      event.stopPropagation();
      event.preventDefault();
    });
  }

  function enableWorkspaceResizing(drawer, handle) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const view = drawer.ownerDocument.defaultView;
      const rect = drawer.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = rect.left;
      const startWidth = rect.width;
      const startHeight = rect.height;
      drawer.style.left = `${startLeft}px`;
      drawer.style.right = "auto";
      drawer.style.top = `${rect.top}px`;
      drawer.style.width = `${startWidth}px`;
      drawer.style.height = `${startHeight}px`;
      drawer.style.resize = "none";
      drawer.dataset.maximized = "false";
      const move = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        const maximumWidth = Math.max(320, view.innerWidth - 12);
        const maximumHeight = Math.max(260, view.innerHeight - rect.top - 8);
        const width = Math.min(maximumWidth, Math.max(320, startWidth - deltaX));
        const height = Math.min(maximumHeight, Math.max(260, startHeight + deltaY));
        const rightEdge = startLeft + startWidth;
        drawer.style.left = `${Math.max(4, rightEdge - width)}px`;
        drawer.style.width = `${width}px`;
        drawer.style.height = `${height}px`;
      };
      const stop = () => {
        view.removeEventListener("pointermove", move);
        view.removeEventListener("pointerup", stop);
        handle.releasePointerCapture?.(event.pointerId);
      };
      handle.setPointerCapture?.(event.pointerId);
      view.addEventListener("pointermove", move);
      view.addEventListener("pointerup", stop);
      event.stopPropagation();
      event.preventDefault();
    });
  }

  function enableVerticalResizing(target, handle, onResizeEnd = () => {}) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const view = target.ownerDocument.defaultView;
      const startY = event.clientY;
      const startHeight = target.getBoundingClientRect().height;
      const move = (moveEvent) => {
        const maximum = Math.max(220, view.innerHeight - 180);
        const height = Math.min(maximum, Math.max(170, startHeight + moveEvent.clientY - startY));
        target.style.height = `${Math.round(height)}px`;
      };
      const stop = () => {
        view.removeEventListener("pointermove", move);
        view.removeEventListener("pointerup", stop);
        handle.releasePointerCapture?.(event.pointerId);
        onResizeEnd(Math.round(target.getBoundingClientRect().height));
      };
      handle.setPointerCapture?.(event.pointerId);
      view.addEventListener("pointermove", move);
      view.addEventListener("pointerup", stop);
      event.stopPropagation();
      event.preventDefault();
    });
  }

  async function focusPaperAIWorkspace(reader = null, tab = "chat") {
    reader ||= getActiveReader();
    const doc = reader?._iframeWindow?.document;
    if (!reader || !doc?.body) {
      showProgress("论文 AI 工作台", "请先激活一个已经打开的 PDF 标签页。", true);
      return false;
    }
    ensureKaTeXStyles(doc);
    applyWorkspaceTheme(doc.documentElement);

    let drawer = doc.getElementById("obsidian-scholar-bridge-workspace-drawer");
    if (!drawer) {
      drawer = createHTMLElement(doc, "aside");
      drawer.id = "obsidian-scholar-bridge-workspace-drawer";
      drawer.setAttribute("role", "dialog");
      drawer.setAttribute("aria-label", "论文 AI 工作台");
      applyWorkspaceTheme(drawer);
      addStyle(drawer, [
        "position:fixed",
        "top:54px",
        "right:16px",
        "width:min(430px,calc(100vw - 40px))",
        "height:calc(100vh - 70px)",
        "min-width:320px",
        "min-height:260px",
        "max-width:calc(100vw - 12px)",
        "max-height:calc(100vh - 12px)",
        "z-index:2147483000",
        "display:flex",
        "flex-direction:column",
        "overflow:hidden",
        "resize:none",
        "border:1px solid color-mix(in srgb,var(--sb-accent,#2563a8) 24%,var(--fill-quinary,#b8b8b8))",
        "border-radius:12px",
        "background:var(--material-background,#fff)",
        "color:var(--material-foreground,#222)",
        "box-shadow:0 14px 42px #0004"
      ].join(";"));

      const drawerHeader = createHTMLElement(doc, "div");
      addStyle(drawerHeader, [
        "display:flex",
        "align-items:center",
        "justify-content:space-between",
        "gap:8px",
        "padding:9px 10px",
        "cursor:move",
        "user-select:none",
        "border-bottom:1px solid var(--fill-quinary,#ddd)",
        "background:var(--sb-accent-soft,color-mix(in srgb,#2563a8 11%,var(--material-background,#fff)))"
      ].join(";"));
      const drawerTitle = createHTMLElement(doc, "strong");
      drawerTitle.textContent = "论文 AI 工作台";
      const headerActions = createHTMLElement(doc, "div");
      addStyle(headerActions, "display:flex;gap:5px;align-items:center");
      const themeSelect = createHTMLElement(doc, "select");
      themeSelect.title = "界面皮肤";
      themeSelect.setAttribute("aria-label", "界面皮肤");
      for (const [value, theme] of Object.entries(WORKSPACE_THEMES)) {
        const option = createHTMLElement(doc, "option");
        option.value = value;
        option.textContent = theme.label;
        themeSelect.append(option);
      }
      const storedTheme = String(pref("workspaceTheme", "ocean"));
      themeSelect.value = WORKSPACE_THEMES[storedTheme] ? storedTheme : "ocean";
      addStyle(themeSelect, [
        "max-width:86px",
        "min-height:26px",
        "border-radius:6px",
        "border:1px solid var(--fill-quinary,#ccc)",
        "background:var(--material-background,#fff)",
        "color:inherit",
        "font:inherit"
      ].join(";"));
      themeSelect.addEventListener("change", () => {
        setPref("workspaceTheme", themeSelect.value);
        applyWorkspaceTheme(doc.documentElement, themeSelect.value);
        applyWorkspaceTheme(drawer, themeSelect.value);
      });
      const minimizeButton = createButton(doc, "最小化");
      const closeButton = createButton(doc, "关闭");
      for (const button of [minimizeButton, closeButton]) {
        addStyle(button, "padding:4px 7px");
      }
      minimizeButton.addEventListener("click", () => {
        const minimized = drawer.dataset.minimized === "true";
        if (minimized) {
          drawer.dataset.minimized = "false";
          drawer.style.height = drawer.dataset.restoreHeight || "calc(100vh - 70px)";
          drawer.style.resize = "none";
          drawer._workspaceBody.hidden = false;
          minimizeButton.textContent = "最小化";
        } else {
          drawer.dataset.restoreHeight = `${drawer.getBoundingClientRect().height}px`;
          drawer.dataset.minimized = "true";
          drawer.style.height = "auto";
          drawer.style.resize = "none";
          drawer._workspaceBody.hidden = true;
          minimizeButton.textContent = "还原";
        }
      });
      closeButton.addEventListener("click", () => {
        drawer.hidden = true;
        drawer.style.display = "none";
      });
      headerActions.append(themeSelect, minimizeButton, closeButton);
      drawerHeader.append(drawerTitle, headerActions);
      enableWorkspaceDragging(drawer, drawerHeader);

      const drawerBody = createHTMLElement(doc, "div");
      drawerBody.className = "obsidian-scholar-bridge-workspace-body";
      addStyle(drawerBody, "flex:1;min-height:0;overflow:auto");
      drawer._workspaceBody = drawerBody;
      const drawerResizeHandle = createHTMLElement(doc, "div");
      drawerResizeHandle.title = "向左拖动增大宽度，向下拖动增大高度";
      drawerResizeHandle.setAttribute("role", "separator");
      drawerResizeHandle.setAttribute("aria-label", "调整工作台大小");
      addStyle(drawerResizeHandle, [
        "position:absolute",
        "left:2px",
        "bottom:2px",
        "z-index:20",
        "width:18px",
        "height:18px",
        "border-radius:0 6px 0 8px",
        "background:linear-gradient(45deg,currentColor 0 25%,transparent 26% 48%,currentColor 49% 58%,transparent 59%)",
        "opacity:.32",
        "cursor:nesw-resize",
        "user-select:none",
        "touch-action:none"
      ].join(";"));
      enableWorkspaceResizing(drawer, drawerResizeHandle);
      drawer.append(drawerHeader, drawerBody, drawerResizeHandle);
      doc.body.appendChild(drawer);
      renderChatUIWithFallback({
        doc,
        body: drawerBody,
        item: Zotero.Items.get(reader.itemID)
      });
    }
    drawer.hidden = false;
    drawer.style.display = "flex";
    const drawerBody = drawer.querySelector(".obsidian-scholar-bridge-workspace-body");
    drawerBody?._scholarBridgeShowTab?.(tab);
    return true;
  }

  function registerReaderToolbar() {
    toolbarHandler = ({ reader, doc, append }) => {
      const button = createHTMLElement(doc, "button");
      button.type = "button";
      button.textContent = "论文 AI";
      button.title = "打开独立的论文 AI 工作台";
      button.setAttribute("aria-label", "打开论文 AI 工作台");
      addStyle(button, [
        "margin:2px 5px",
        "padding:4px 9px",
        "min-height:28px",
        "border-radius:7px",
        "border:1px solid color-mix(in srgb, var(--sb-accent,#2563a8) 60%, currentColor 20%)",
        "background:color-mix(in srgb, var(--sb-accent,#2563a8) 16%, transparent)",
        "color:inherit",
        "font:inherit",
        "font-weight:650",
        "cursor:pointer"
      ].join(";"));
      button.addEventListener("click", () => focusPaperAIWorkspace(reader, "chat"));
      append(button);
    };
    Zotero.Reader.registerEventListener("renderToolbar", toolbarHandler, ADDON_ID);
  }

  function registerToolsMenu() {
    toolsMenuID = Zotero.MenuManager.registerMenu({
      menuID: "obsidian-scholar-bridge-tools-menu",
      pluginID: ADDON_ID,
      target: "main/menubar/tools",
      menus: [{
        menuType: "menuitem",
        l10nID: "obsidian-scholar-bridge-menu-open-workspace",
        icon: rootURI + "chrome/content/icons/pane-16.svg",
        onCommand: () => focusPaperAIWorkspace()
      }]
    });
  }

  function addStyle(element, declarations) {
    element.style.cssText = declarations;
    return element;
  }

  function createHTMLElement(doc, tagName) {
    return doc.createElementNS("http://www.w3.org/1999/xhtml", tagName);
  }

  function createButton(doc, label, primary = false) {
    const button = createHTMLElement(doc, "button");
    button.type = "button";
    button.textContent = label;
    addStyle(button, [
      "padding:6px 10px",
      "border-radius:6px",
      "border:1px solid var(--fill-quinary, #bbb)",
      `background:${primary ? "var(--sb-accent,#2563a8)" : "var(--material-background, transparent)"}`,
      `color:${primary ? "var(--sb-accent-contrast,#fff)" : "inherit"}`,
      "cursor:pointer",
      "font:inherit"
    ].join(";"));
    return button;
  }

  function conversationFor(attachmentID) {
    if (!conversations.has(attachmentID)) conversations.set(attachmentID, []);
    return conversations.get(attachmentID);
  }

  function ensureKaTeXStyles(doc) {
    if (!doc?.documentElement || doc.getElementById("obsidian-scholar-bridge-katex-css")) return;
    const link = createHTMLElement(doc, "link");
    link.id = "obsidian-scholar-bridge-katex-css";
    link.rel = "stylesheet";
    link.href = rootURI + "chrome/content/vendor/katex/katex.min.css";
    (doc.head || doc.documentElement).append(link);
  }

  function renderMath(doc, parent, source, displayMode = false) {
    const math = createHTMLElement(doc, displayMode ? "div" : "span");
    if (displayMode) {
      addStyle(math, "overflow-x:auto;overflow-y:hidden;padding:7px 2px;margin:7px 0;text-align:center");
    }
    try {
      if (!ScholarBridgeKatex?.renderToString) throw new Error("KaTeX runtime unavailable");
      math.innerHTML = ScholarBridgeKatex.renderToString(String(source || "").trim(), {
        displayMode,
        throwOnError: false,
        trust: false,
        strict: "error",
        output: "htmlAndMathml"
      });
    } catch (_error) {
      math.textContent = displayMode ? `$$${source}$$` : `$${source}$`;
      addStyle(math, "font-family:monospace;color:#b42318");
    }
    parent.append(math);
  }

  function renderInlineMarkdown(doc, parent, value) {
    const text = String(value || "");
    const tokenPattern = /(`[^`\n]+`|\$[^$\n]+\$|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\n]+\))/g;
    let cursor = 0;
    for (const match of text.matchAll(tokenPattern)) {
      if (match.index > cursor) parent.append(doc.createTextNode(text.slice(cursor, match.index)));
      const token = match[0];
      if (token.startsWith("`")) {
        const code = createHTMLElement(doc, "code");
        code.textContent = token.slice(1, -1);
        addStyle(code, "padding:1px 4px;border-radius:4px;background:var(--fill-quinary,#e9e9e9);font-family:monospace");
        parent.append(code);
      } else if (token.startsWith("$")) {
        renderMath(doc, parent, token.slice(1, -1), false);
      } else if (token.startsWith("**")) {
        const strong = createHTMLElement(doc, "strong");
        renderInlineMarkdown(doc, strong, token.slice(2, -2));
        parent.append(strong);
      } else if (token.startsWith("*")) {
        const emphasis = createHTMLElement(doc, "em");
        renderInlineMarkdown(doc, emphasis, token.slice(1, -1));
        parent.append(emphasis);
      } else {
        const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const href = linkMatch?.[2]?.trim() || "";
        if (linkMatch && /^(?:https?:|zotero:)/i.test(href)) {
          const anchor = createHTMLElement(doc, "a");
          anchor.textContent = linkMatch[1];
          anchor.href = href;
          anchor.target = "_blank";
          anchor.rel = "noreferrer";
          parent.append(anchor);
        } else {
          parent.append(doc.createTextNode(token));
        }
      }
      cursor = match.index + token.length;
    }
    if (cursor < text.length) parent.append(doc.createTextNode(text.slice(cursor)));
  }

  function isMarkdownBlockStart(lines, index) {
    const line = lines[index] || "";
    const next = lines[index + 1] || "";
    return /^\s*(?:```|\$\$|\\\[|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|(?:---+|___+|\*\*\*+)\s*$)/.test(line)
      || (/\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(next));
  }

  function renderMarkdownBlocks(doc, parent, markdown) {
    const lines = ScholarBridgeCore.normalizeMathMarkdown(markdown).replace(/\r\n?/g, "\n").split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }
      if (/^\s*```/.test(line)) {
        const language = line.trim().slice(3).trim();
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^\s*```/.test(lines[index])) codeLines.push(lines[index++]);
        if (index < lines.length) index += 1;
        const pre = createHTMLElement(doc, "pre");
        addStyle(pre, "overflow:auto;padding:9px;border-radius:7px;background:#1f2430;color:#f7f7f7;white-space:pre");
        const code = createHTMLElement(doc, "code");
        if (language) code.dataset.language = language;
        code.textContent = codeLines.join("\n");
        pre.append(code);
        parent.append(pre);
        continue;
      }
      if (/^\s*(?:\$\$|\\\[)/.test(line)) {
        const bracketMode = /^\s*\\\[/.test(line);
        const open = bracketMode ? "\\[" : "$$";
        const close = bracketMode ? "\\]" : "$$";
        let content = line.slice(line.indexOf(open) + open.length);
        const parts = [];
        if (content.includes(close)) {
          parts.push(content.slice(0, content.indexOf(close)));
          index += 1;
        } else {
          if (content) parts.push(content);
          index += 1;
          while (index < lines.length && !lines[index].includes(close)) parts.push(lines[index++]);
          if (index < lines.length) {
            parts.push(lines[index].slice(0, lines[index].indexOf(close)));
            index += 1;
          }
        }
        renderMath(doc, parent, parts.join("\n"), true);
        continue;
      }
      const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = Math.min(6, Math.max(3, headingMatch[1].length + 2));
        const heading = createHTMLElement(doc, `h${level}`);
        addStyle(heading, "margin:12px 0 6px;line-height:1.3");
        renderInlineMarkdown(doc, heading, headingMatch[2]);
        parent.append(heading);
        index += 1;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quoteLines = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quoteLines.push(lines[index++].replace(/^\s*>\s?/, ""));
        }
        const quote = createHTMLElement(doc, "blockquote");
        addStyle(quote, "margin:7px 0;padding:7px 10px;border-left:3px solid var(--sb-accent,#2563a8);background:var(--sb-accent-soft,color-mix(in srgb,var(--material-background,#fff) 90%,#2563a8 10%))");
        renderMarkdownBlocks(doc, quote, quoteLines.join("\n"));
        parent.append(quote);
        continue;
      }
      const listMatch = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
      if (listMatch) {
        const ordered = /^\d/.test(listMatch[1]);
        const list = createHTMLElement(doc, ordered ? "ol" : "ul");
        addStyle(list, "margin:6px 0;padding-left:24px");
        while (index < lines.length) {
          const itemMatch = lines[index].match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
          if (!itemMatch || /^\d/.test(itemMatch[1]) !== ordered) break;
          const itemNode = createHTMLElement(doc, "li");
          addStyle(itemNode, "margin:3px 0;line-height:1.5");
          renderInlineMarkdown(doc, itemNode, itemMatch[2]);
          list.append(itemNode);
          index += 1;
        }
        parent.append(list);
        continue;
      }
      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
        const rule = createHTMLElement(doc, "hr");
        addStyle(rule, "border:0;border-top:1px solid var(--fill-quinary,#ccc);margin:10px 0");
        parent.append(rule);
        index += 1;
        continue;
      }
      if (/\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || "")) {
        const rows = [line];
        index += 2;
        while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) rows.push(lines[index++]);
        const tableWrap = createHTMLElement(doc, "div");
        addStyle(tableWrap, "overflow-x:auto;margin:7px 0");
        const table = createHTMLElement(doc, "table");
        addStyle(table, "border-collapse:collapse;width:100%;font-size:.94em");
        rows.forEach((row, rowIndex) => {
          const tr = createHTMLElement(doc, "tr");
          const cells = row.trim().replace(/^\||\|$/g, "").split("|");
          for (const cell of cells) {
            const node = createHTMLElement(doc, rowIndex === 0 ? "th" : "td");
            addStyle(node, "border:1px solid var(--fill-quinary,#ccc);padding:5px 7px;text-align:left;vertical-align:top");
            renderInlineMarkdown(doc, node, cell.trim());
            tr.append(node);
          }
          table.append(tr);
        });
        tableWrap.append(table);
        parent.append(tableWrap);
        continue;
      }
      const paragraphLines = [line.trim()];
      index += 1;
      while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines, index)) {
        paragraphLines.push(lines[index].trim());
        index += 1;
      }
      const paragraph = createHTMLElement(doc, "p");
      addStyle(paragraph, "margin:6px 0;line-height:1.58");
      renderInlineMarkdown(doc, paragraph, paragraphLines.join(" "));
      parent.append(paragraph);
    }
  }

  function renderScholarMarkdown(container, markdown) {
    container.replaceChildren();
    renderMarkdownBlocks(container.ownerDocument, container, markdown);
  }

  function appendMessage(doc, messages, role, text) {
    const box = createHTMLElement(doc, "div");
    box.dataset.role = role;
    addStyle(box, [
      "padding:8px 9px",
      "border-radius:8px",
      "overflow-wrap:anywhere",
      "line-height:1.45",
      "user-select:text",
      "-moz-user-select:text",
      "cursor:text",
      role === "user" ? "background:var(--sb-accent,#2563a8);color:var(--sb-accent-contrast,#fff);margin-left:18px" : "background:var(--fill-quinary,#eee);margin-right:18px"
    ].join(";"));
    renderScholarMarkdown(box, text);
    messages.append(box);
    messages.scrollTop = messages.scrollHeight;
    return box;
  }

  function paperFilePath(metadata, ...parts) {
    return vaultFilePath(
      pref("chatFolder", "Literature"),
      metadata.paperId,
      ...parts
    );
  }

  function paperSessionStatePath(metadata) {
    const stableKey = ScholarBridgeCore.sanitizeFileName(
      metadata.citeKey || metadata.zoteroItemKey || metadata.attachmentKey || metadata.paperId
    ).slice(0, 100) || "paper";
    return vaultFilePath(".scholar-bridge", "paper-sessions", `${stableKey}.json`);
  }

  function createSessionID(date = new Date()) {
    const stamp = date.toISOString().replace(/[-:.TZ]/g, "");
    return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function createPaperSession(metadata, date = new Date()) {
    const now = date.toISOString();
    return {
      id: createSessionID(date),
      title: "新阅读会话",
      createdAt: now,
      updatedAt: now,
      publishedAt: "",
      fileName: "",
      entries: [],
      paperTitle: metadata.title
    };
  }

  function normalizePaperSessionState(raw, metadata) {
    const sessions = Array.isArray(raw?.sessions)
      ? raw.sessions.filter((session) => session && session.id).map((session) => ({
        id: String(session.id),
        title: String(session.title || "阅读会话"),
        createdAt: String(session.createdAt || new Date().toISOString()),
        updatedAt: String(session.updatedAt || session.createdAt || new Date().toISOString()),
        publishedAt: String(session.publishedAt || ""),
        fileName: String(session.fileName || ""),
        entries: Array.isArray(session.entries) ? session.entries.map((entry) => ({
          role: entry?.role === "assistant" ? "assistant" : "user",
          text: String(entry?.text || ""),
          time: String(entry?.time || ""),
          mode: String(entry?.mode || ""),
          model: String(entry?.model || ""),
          provider: String(entry?.provider || ""),
          citations: Array.isArray(entry?.citations) ? entry.citations.map(Number).filter(Number.isFinite) : []
        })).filter((entry) => entry.text) : [],
        paperTitle: String(session.paperTitle || metadata.title)
      }))
      : [];
    let activeSessionId = String(raw?.activeSessionId || "");
    if (!sessions.some((session) => session.id === activeSessionId)) {
      activeSessionId = sessions[0]?.id || "";
    }
    return {
      schema_version: SESSION_SCHEMA_VERSION,
      paper_id: metadata.paperId,
      zotero_item_key: metadata.zoteroItemKey,
      attachment_key: metadata.attachmentKey,
      activeSessionId,
      sessions
    };
  }

  function parsePublishedSession(markdown, fileName, metadata) {
    const frontmatter = ScholarBridgeCore.parsePaperMemoryMetadata(markdown);
    const entries = [];
    const sectionPattern = /^#{2,3} (问题|AI 回答|回答) \d+\s*\n([\s\S]*?)(?=^#{2,3} (?:问题|AI 回答|回答) \d+\s*$|(?![\s\S]))/gm;
    for (const match of String(markdown || "").matchAll(sectionPattern)) {
      const role = match[1] === "问题" ? "user" : "assistant";
      const lines = match[2].trim().split(/\r?\n/);
      let mode = "";
      let model = "";
      let provider = "";
      let time = "";
      let citations = [];
      while (lines[0]?.startsWith("> ")) {
        const metadataLine = lines.shift().slice(2).trim();
        const plainMetadataLine = metadataLine.replace(/\*\*/g, "");
        mode ||= plainMetadataLine.match(/(?:模式|阅读策略)：([^·　]+)/)?.[1]?.trim() || "";
        model ||= plainMetadataLine.match(/模型：([^·　]+)/)?.[1]?.trim() || "";
        provider ||= plainMetadataLine.match(/服务商：([^·　]+)/)?.[1]?.trim() || "";
        time ||= plainMetadataLine.match(/时间：(.+)$/)?.[1]?.trim() || "";
        const pages = [...plainMetadataLine.matchAll(/p\.\s*(\d+)/gi)].map((page) => Number(page[1]));
        if (pages.length) citations = pages;
      }
      while (lines.length && !lines[0].trim()) lines.shift();
      const text = lines.join("\n").trim();
      if (text) entries.push({ role, text, time, mode, model, provider, citations });
    }
    if (!entries.length) return null;
    const createdAt = String(frontmatter.created || frontmatter.updated || new Date().toISOString());
    const updatedAt = String(frontmatter.updated || frontmatter.created || createdAt);
    const firstQuestion = entries.find((entry) => entry.role === "user")?.text || "历史阅读会话";
    return {
      id: String(frontmatter.session_id || `legacy-${hashString([metadata.attachmentKey, fileName].join("|"))}`),
      title: firstQuestion.slice(0, 90),
      createdAt,
      updatedAt,
      publishedAt: updatedAt,
      fileName,
      entries,
      paperTitle: metadata.title
    };
  }

  async function importPublishedSessions(metadata) {
    const folders = [
      paperFilePath(metadata, PAPER_SESSIONS_FOLDER),
      legacyPaperFilePath(metadata, PAPER_SESSIONS_FOLDER),
      legacyPaperFilePath(metadata, "AI Sessions")
    ];
    const sessions = [];
    const seen = new Set();
    for (const folderPath of folders) {
      if (!(await IOUtils.exists(folderPath))) continue;
      try {
        const children = await IOUtils.getChildren(folderPath);
        for (const filePath of children.filter((path) => /\.md$/i.test(path))) {
          try {
            const fileName = String(filePath).split(/[\\/]/).at(-1);
            const session = parsePublishedSession(await IOUtils.readUTF8(filePath), fileName, metadata);
            if (session && !seen.has(session.id)) {
              seen.add(session.id);
              sessions.push(session);
            }
          } catch (error) {
            Zotero.logError(error);
          }
        }
      } catch (error) {
        Zotero.logError(error);
      }
    }
    return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function loadPaperSessionState(attachment) {
    if (paperSessionStates.has(attachment.id)) return paperSessionStates.get(attachment.id);
    const metadata = itemMetadata(attachment);
    const statePath = paperSessionStatePath(metadata);
    let raw = null;
    let importedExisting = false;
    if (await IOUtils.exists(statePath)) {
      try {
        raw = JSON.parse(await IOUtils.readUTF8(statePath));
      } catch (error) {
        Zotero.logError(error);
      }
    }
    if (!Array.isArray(raw?.sessions) || !raw.sessions.length) {
      const imported = await importPublishedSessions(metadata);
      if (imported.length) {
        raw = { activeSessionId: imported[0].id, sessions: imported };
        importedExisting = true;
      }
    }
    const state = normalizePaperSessionState(raw, metadata);
    paperSessionStates.set(attachment.id, state);
    if (importedExisting) await writePaperSessionState(attachment, state);
    return state;
  }

  async function writePaperSessionState(attachment, state) {
    const metadata = itemMetadata(attachment);
    state.schema_version = SESSION_SCHEMA_VERSION;
    state.paper_id = metadata.paperId;
    state.zotero_item_key = metadata.zoteroItemKey;
    state.attachment_key = metadata.attachmentKey;
    await writeUTF8(paperSessionStatePath(metadata), `${JSON.stringify(state, null, 2)}\n`);
    paperSessionStates.set(attachment.id, state);
  }

  async function ensureActivePaperSession(attachment) {
    const metadata = itemMetadata(attachment);
    const state = await loadPaperSessionState(attachment);
    let session = state.sessions.find((candidate) => candidate.id === state.activeSessionId);
    if (!session) {
      session = createPaperSession(metadata);
      state.sessions.unshift(session);
      state.activeSessionId = session.id;
      await writePaperSessionState(attachment, state);
    }
    if (!conversations.has(attachment.id)) conversations.set(attachment.id, session.entries);
    return { state, session };
  }

  async function persistActivePaperSession(attachment) {
    const { state, session } = await ensureActivePaperSession(attachment);
    session.entries = conversationFor(attachment.id);
    session.updatedAt = new Date().toISOString();
    const firstQuestion = session.entries.find((entry) => entry.role === "user")?.text;
    if (firstQuestion) session.title = firstQuestion.slice(0, 90);
    await writePaperSessionState(attachment, state);
    return { state, session };
  }

  async function startNewPaperSession(attachment) {
    const metadata = itemMetadata(attachment);
    const state = await loadPaperSessionState(attachment);
    state.sessions = state.sessions.filter((session) => session.entries.length || session.publishedAt);
    const session = createPaperSession(metadata);
    state.sessions.unshift(session);
    state.activeSessionId = session.id;
    conversations.set(attachment.id, session.entries);
    await writePaperSessionState(attachment, state);
    return { state, session };
  }

  async function resumePaperSession(attachment, sessionID) {
    const state = await loadPaperSessionState(attachment);
    const session = state.sessions.find((candidate) => candidate.id === sessionID);
    if (!session) throw new Error("找不到要继续的历史会话");
    state.activeSessionId = session.id;
    conversations.set(attachment.id, session.entries);
    await writePaperSessionState(attachment, state);
    return { state, session };
  }

  function legacyPaperFilePath(metadata, ...parts) {
    return vaultFilePath(
      pref("chatFolder", "Literature"),
      metadata.legacyPaperId,
      ...parts
    );
  }

  async function loadPaperMemory(attachment) {
    const metadata = itemMetadata(attachment);
    for (const filePath of [
      paperFilePath(metadata, PAPER_MEMORY_FILE),
      legacyPaperFilePath(metadata, "Paper Memory.md")
    ]) {
      if (await IOUtils.exists(filePath)) {
        const memory = await IOUtils.readUTF8(filePath);
        paperMemoryCache.set(attachment.id, memory);
        return memory;
      }
    }
    paperMemoryCache.delete(attachment.id);
    return "";
  }

  async function inspectPaperMemory(attachment) {
    const memory = await loadPaperMemory(attachment);
    if (!memory) return { state: "missing", memory: "", metadata: {}, fingerprint: "" };
    const pages = await getAttachmentPages(attachment, true);
    const fingerprint = ScholarBridgeCore.textFingerprint(pages);
    const metadata = ScholarBridgeCore.parsePaperMemoryMetadata(memory);
    const recorded = String(metadata.pdf_fingerprint || "");
    return {
      state: !recorded ? "legacy" : recorded === fingerprint ? "current" : "changed",
      memory,
      metadata,
      fingerprint
    };
  }

  async function consolidatePaperNotes(notes, metadata, onProgress, quality = "deep") {
    const system = [
      "你是论文全文结构编辑。根据覆盖论文连续部分的分段笔记建立全局论文地图。",
      "必须保留页码，连接研究问题、假设、方法、变量、公式、结果、局限和章节间依赖。",
      "不要把局部观察夸大为全文结论；冲突或不确定之处必须标出。",
      "输出紧凑 Markdown，包含：主线、章节地图、核心概念、关键假设、方法流程、主要发现、局限性、待核对问题。"
    ].join("\n");
    let level = 1;
    let current = [...notes];
    const batchSize = 8;
    while (current.length > batchSize) {
      const next = [];
      const total = Math.ceil(current.length / batchSize);
      for (let start = 0; start < current.length; start += batchSize) {
        const batch = current.slice(start, start + batchSize);
        const batchNumber = Math.floor(start / batchSize) + 1;
        onProgress(`分层汇总 ${level}：${batchNumber}/${total}`);
        next.push(await callModel({
          quality,
          system,
          user: [
            `论文：${metadata.title}`,
            `这是第 ${level} 层的一组连续阅读笔记，请保留其中的页码和跨段联系。`,
            batch.map((note, index) => `## 笔记 ${start + index + 1}\n${note}`).join("\n\n")
          ].join("\n\n")
        }));
      }
      current = next;
      level += 1;
    }
    onProgress("正在生成最终全文结构和跨章节关系…");
    return callModel({
      quality,
      system,
      user: [
        `论文：${metadata.title}`,
        "以下笔记共同覆盖整篇论文，请生成最终全局论文地图。",
        current.map((note, index) => `## 分段/中间汇总 ${index + 1}\n${note}`).join("\n\n")
      ].join("\n\n")
    });
  }

  async function buildPaperMemory(
    attachment,
    onProgress = () => {},
    force = false,
    requestedQuality = "deep"
  ) {
    const quality = requestedQuality === "fast" ? "fast" : "deep";
    if (!force) {
      const existing = await loadPaperMemory(attachment);
      if (existing) {
        const existingMetadata = ScholarBridgeCore.parsePaperMemoryMetadata(existing);
        const recordedFingerprint = String(existingMetadata.pdf_fingerprint || "");
        if (!recordedFingerprint) return existing;
        const currentPages = await getAttachmentPages(attachment);
        if (recordedFingerprint === ScholarBridgeCore.textFingerprint(currentPages)) return existing;
        onProgress("检测到 PDF 正文已变化，正在自动更新全文记忆…");
      }
    }
    const metadata = itemMetadata(attachment);
    const pages = await getAttachmentPages(attachment, force);
    const pdfFingerprint = ScholarBridgeCore.textFingerprint(pages);
    const groups = ScholarBridgeCore.groupPages(pages, 18000);
    const notes = [];
    const memoryModel = getProviderConfig(quality).model;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      onProgress(
        `全文阅读 ${index + 1}/${groups.length}：p. ${group.pageStart + 1}-${group.pageEnd + 1} · ${memoryModel}`
      );
      const note = await callModel({
        quality,
        system: [
          "你正在分段精读一篇学术论文。这是连续页段，不是独立文章。",
          "提取该页段的章节位置、论点、定义、假设、方法、公式含义、实验发现、限制以及与前后文的依赖。",
          "所有信息必须带 [p. 页码]；信息缺失时不要补写。",
          "输出紧凑的 Markdown 阅读笔记，保留后续回答问题所需的专业细节。"
        ].join("\n"),
        user: `论文：${metadata.title}\n\n连续页段：\n${group.text}`
      });
      notes.push(note);
    }
    const consolidated = await consolidatePaperNotes(notes, metadata, onProgress, quality);
    const now = new Date().toISOString();
    const memory = [
      "---",
      `paper_id: ${ScholarBridgeCore.escapeYaml(metadata.paperId)}`,
      `stable_key: ${ScholarBridgeCore.escapeYaml(metadata.citeKey || metadata.zoteroItemKey)}`,
      `zotero_item_key: ${ScholarBridgeCore.escapeYaml(metadata.zoteroItemKey)}`,
      `attachment_key: ${ScholarBridgeCore.escapeYaml(metadata.attachmentKey)}`,
      `generated: ${ScholarBridgeCore.escapeYaml(now)}`,
      `generated_by: ${ScholarBridgeCore.escapeYaml(`${getProviderConfig(quality).provider}:${getProviderConfig(quality).model}`)}`,
      `memory_provider: ${ScholarBridgeCore.escapeYaml(getProviderConfig(quality).provider)}`,
      `memory_model: ${ScholarBridgeCore.escapeYaml(getProviderConfig(quality).model)}`,
      `memory_quality: ${ScholarBridgeCore.escapeYaml(quality)}`,
      `pdf_fingerprint: ${ScholarBridgeCore.escapeYaml(pdfFingerprint)}`,
      `page_count: ${pages.length}`,
      "tags: [paper-memory, ai-assisted]",
      "---",
      "",
      `# 全文记忆 · ${metadata.title}`,
      "",
      "> [!warning] 这是 AI 建立的全文导航，不替代论文原文；回答问题时仍会回读相关页面并复核。",
      "",
      consolidated,
      "",
      "## 分段阅读记录",
      "",
      notes.map((note, index) => `### Segment ${index + 1}\n\n${note}`).join("\n\n")
    ].join("\n");
    await writeUTF8(paperFilePath(metadata, PAPER_MEMORY_FILE), memory);
    paperMemoryCache.set(attachment.id, memory);
    return memory;
  }

  async function relevantContext(attachment, question, mode = "quick") {
    const pages = await getAttachmentPages(attachment);
    const chunks = ScholarBridgeCore.chunkPages(pages);
    const ranked = ScholarBridgeCore.rankChunks(chunks, question, mode === "quick" ? 5 : 7);
    const currentPage = Number(attachment.getAttachmentLastPageIndex?.());
    const currentChunk = Number.isInteger(currentPage)
      ? chunks.find((chunk) => chunk.pageIndex === currentPage)
      : null;
    const selected = [];
    const seen = new Set();
    const expanded = [];
    for (const chunk of ranked) {
      const index = chunks.findIndex((candidate) =>
        candidate.pageIndex === chunk.pageIndex && candidate.start === chunk.start
      );
      if (mode !== "quick" && index > 0) expanded.push(chunks[index - 1]);
      expanded.push(chunk);
      if (mode !== "quick" && index >= 0 && index < chunks.length - 1) expanded.push(chunks[index + 1]);
    }
    for (const chunk of [currentChunk, ...expanded].filter(Boolean)) {
      const key = `${chunk.pageIndex}:${chunk.start}`;
      if (!seen.has(key)) {
        seen.add(key);
        selected.push(chunk);
      }
    }
    const configuredMaximum = Number(pref("maxContextChars", 36000)) || 36000;
    const maximum = Math.min(configuredMaximum, mode === "quick" ? 22000 : 28000);
    let used = 0;
    const output = [];
    for (const chunk of selected) {
      if (used + chunk.text.length > maximum && output.length >= 2) break;
      output.push(`[p. ${chunk.pageIndex + 1}]\n${chunk.text}`);
      used += chunk.text.length;
    }
    return {
      text: output.join("\n\n---\n\n"),
      pages,
      pageCount: pages.length
    };
  }

  function attachCitationWarning(answer, pageCount) {
    const validation = ScholarBridgeCore.validateCitationPages(answer, pageCount);
    const warnings = [];
    if (!validation.hasCitations) warnings.push("回答没有给出可核对的页码引用");
    if (validation.invalid.length) {
      warnings.push(`出现超出论文范围的页码：${validation.invalid.join(", ")}`);
    }
    return warnings.length
      ? `${answer}\n\n> [!warning] 引用检查：${warnings.join("；")}。请回到 Zotero 原文核对。`
      : answer;
  }

  function verificationEvidence(pages, draft, fallbackEvidence, maximum = 18000) {
    const citedPages = ScholarBridgeCore.extractCitations(draft)
      .filter((page) => page >= 1 && page <= pages.length);
    if (!citedPages.length) return String(fallbackEvidence || "").slice(0, maximum);
    const indexes = [];
    const seen = new Set();
    for (const page of citedPages) {
      for (const index of [page - 1, page - 2, page]) {
        if (index >= 0 && index < pages.length && !seen.has(index)) {
          seen.add(index);
          indexes.push(index);
        }
      }
    }
    indexes.sort((a, b) => a - b);
    const output = [];
    let used = 0;
    for (const index of indexes) {
      const block = `[p. ${index + 1}]\n${pages[index] || ""}`;
      if (used + block.length > maximum && output.length) break;
      output.push(block);
      used += block.length;
    }
    return output.join("\n\n---\n\n");
  }

  async function verifyAnswer(question, draft, evidence, memory, pageCount, quality = "deep") {
    const verified = await callModel({
      quality,
      system: [
        "你是论文回答的证据审校员。",
        "逐项检查草稿是否被给出的论文原文支持，删除或降低没有证据的断言。",
        "修正页码；每个关键结论必须使用 [p. 页码]。",
        "数学公式必须使用标准 LaTeX：行内公式用 $...$，独立公式用 $$...$$，不要放入代码块。",
        "只输出修订后的最终回答，不输出审校过程。"
      ].join("\n"),
      user: [
        `问题：${question}`,
        `草稿：\n${draft}`,
        memory ? `论文全局地图（压缩复核版）：\n${memory.slice(0, 14000)}` : "",
        `用于核验的原文：\n${evidence}`
      ].filter(Boolean).join("\n\n")
    });
    return attachCitationWarning(verified, pageCount);
  }

  async function askPaper(
    attachment,
    question,
    requestedMode = null,
    requestedQuality = null,
    onProgress = () => {}
  ) {
    const metadata = itemMetadata(attachment);
    let mode = requestedMode || String(pref("readingMode", "deep"));
    const quality = requestedQuality === "fast" ? "fast" : "deep";
    const retrieved = await relevantContext(attachment, question, mode);
    let memory = "";
    let context = retrieved.text;
    let fallbackNote = "";
    if (mode === "deep") {
      memory = await buildPaperMemory(attachment, onProgress, false, quality);
    } else if (mode === "full") {
      const fullText = ScholarBridgeCore.pagesForModel(retrieved.pages);
      const limit = Number(pref("maxFullTextChars", 180000)) || 180000;
      if (fullText.length <= limit) {
        context = fullText;
      } else {
        mode = "deep";
        fallbackNote = `全文约 ${fullText.length} 字符，超过设置上限 ${limit}，已自动使用深度模式。`;
        memory = await buildPaperMemory(attachment, onProgress, false, quality);
      }
    }
    const history = ScholarBridgeCore.selectConversationHistory(
      conversationFor(attachment.id).slice(0, -1),
      12000,
      6
    )
      .map((entry) => `${entry.role === "user" ? "用户" : "助手"}：${entry.text}`)
      .join("\n\n");
    const language = pref("answerLanguage", "zh-CN");
    const system = [
      "你是严谨的论文阅读助手。只能依据给出的论文全局地图和原文回答；证据不足时明确说明。",
      "每个关键结论都使用 [p. 页码] 标注来源页，不得编造页码、引文或论文结论。",
      "回答局部问题时也要检查它与论文研究目标、假设、方法、结果和局限的关系。",
      "输出清晰 Markdown；数学公式使用标准 LaTeX，行内用 $...$、独立公式用 $$...$$，不要把公式放进代码块。",
      `默认回答语言：${language}。`,
      "先直接回答问题，再解释证据与不确定性。"
    ].join("\n");
    const user = [
      `论文：${metadata.title}`,
      `作者：${metadata.authors || "未知"}`,
      history ? `近期对话：\n${history}` : "",
      `问题：${question}`,
      memory ? `由全文分段阅读形成的论文全局地图：\n${memory.slice(0, 24000)}` : "",
      `${mode === "full" ? "论文全文" : "回读的相关原文及前后文"}：\n${context || "没有提取到可用文本"}`
    ].filter(Boolean).join("\n\n");
    const activeModel = getProviderConfig(quality);
    onProgress(
      `${mode === "quick" ? "正在快速回答" : "正在基于全文结构生成回答"} · ${activeModel.model}…`
    );
    let answer = await callModel({
      system,
      user,
      structured: false,
      quality
    });
    if (mode !== "quick") {
      onProgress("正在对照原文复核回答和页码…");
      const compactEvidence = verificationEvidence(retrieved.pages, answer, context);
      answer = await verifyAnswer(
        question,
        answer,
        compactEvidence,
        memory,
        retrieved.pageCount,
        quality
      );
    } else {
      answer = attachCitationWarning(answer, retrieved.pageCount);
    }
    answer = ScholarBridgeCore.normalizeMathMarkdown(answer);
    if (fallbackNote) answer = `> [!info] ${fallbackNote}\n\n${answer}`;
    return { answer, mode, model: activeModel.model, provider: activeModel.provider, quality };
  }

  function timestampForFile(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
    ].join(" ");
  }

  async function saveConversation(attachment) {
    const { state, session } = await persistActivePaperSession(attachment);
    const entries = session.entries;
    if (!entries.length) throw new Error("当前会话还没有内容");
    const metadata = itemMetadata(attachment);
    const now = new Date();
    const firstQuestion = entries.find((entry) => entry.role === "user")?.text || "AI 阅读会话";
    const questionLabel = ScholarBridgeCore.sanitizeFileName(firstQuestion).slice(0, 72);
    const sessionDirectory = paperFilePath(metadata, PAPER_SESSIONS_FOLDER);
    const sessionTimestamp = timestampForFile(new Date(session.createdAt || now));
    const fileName = ScholarBridgeCore.fitSessionFileName(
      sessionDirectory,
      questionLabel,
      sessionTimestamp,
      session.id,
      session.fileName
    );
    const filePath = PathUtils.join(sessionDirectory, fileName);
    const bodyParts = [];
    let round = 0;
    for (const entry of entries) {
      if (entry.role === "user") {
        round += 1;
        bodyParts.push([
          `## 问题 ${round}`,
          "",
          entry.time ? `> [!question] 提问时间：${entry.time}` : "",
          "",
          ScholarBridgeCore.normalizeMathMarkdown(entry.text).trim()
        ].filter(Boolean).join("\n"));
      } else {
        if (!round) round = 1;
        const citations = entry.citations?.length
          ? [...new Set(entry.citations)].map((page) => `p. ${page}`).join("、")
          : "未提取到页码";
        const readableAnswer = ScholarBridgeCore.normalizeMathMarkdown(entry.text)
          .replace(/^\s*(?:---+\s*)+/, "")
          .trim();
        bodyParts.push([
          `## AI 回答 ${round}`,
          "",
          "> [!info]- 本轮阅读设置",
          `> **阅读策略：** ${entry.mode || "-"}`,
          `> **服务商：** ${entry.provider || "-"}`,
          `> **模型：** ${entry.model || "-"}`,
          `> **回答时间：** ${entry.time || "-"}`,
          `> **原文证据页：** ${citations}`,
          "",
          readableAnswer
        ].join("\n"));
      }
    }
    const body = bodyParts.join("\n\n---\n\n");
    const markdown = [
      "---",
      `title: ${ScholarBridgeCore.escapeYaml(`AI 阅读会话 · ${metadata.title}`)}`,
      `paper: ${ScholarBridgeCore.escapeYaml(metadata.title)}`,
      `paper_id: ${ScholarBridgeCore.escapeYaml(metadata.paperId)}`,
      `citekey: ${ScholarBridgeCore.escapeYaml(metadata.citeKey)}`,
      `zotero_item_key: ${ScholarBridgeCore.escapeYaml(metadata.zoteroItemKey)}`,
      `attachment_key: ${ScholarBridgeCore.escapeYaml(metadata.attachmentKey)}`,
      `session_id: ${ScholarBridgeCore.escapeYaml(session.id)}`,
      `doi: ${ScholarBridgeCore.escapeYaml(metadata.doi)}`,
      `authors: ${ScholarBridgeCore.escapeYaml(metadata.authors)}`,
      `created: ${ScholarBridgeCore.escapeYaml(session.createdAt)}`,
      `updated: ${ScholarBridgeCore.escapeYaml(now.toISOString())}`,
      "tags: [literature-note, ai-reading-session]",
      "---",
      "",
      `# AI 阅读会话 · ${metadata.title}`,
      "",
      `- Zotero：[打开论文](${zoteroPDFLink(attachment, "1")})`,
      `- 快速模型：${getProviderConfig("fast").provider}:${getProviderConfig("fast").model}`,
      `- 深度模型：${getProviderConfig("deep").provider}:${getProviderConfig("deep").model}`,
      "",
      "> [!note] AI 回答可能出错。页码引用应回到 Zotero 原文核对。",
      "",
      body,
      ""
    ].join("\n");
    await writeUTF8(filePath, markdown);
    session.fileName = fileName;
    session.publishedAt = now.toISOString();
    session.updatedAt = now.toISOString();
    await writePaperSessionState(attachment, state);
    await updatePaperHub(metadata, attachment, fileName);
    return filePath;
  }

  async function updatePaperHub(metadata, attachment, sessionFileName) {
    const hubPath = paperFilePath(metadata, PAPER_HOME_FILE);
    const start = "<!-- scholar-bridge:sessions:start -->";
    const end = "<!-- scholar-bridge:sessions:end -->";
    let existing = await IOUtils.exists(hubPath) ? await IOUtils.readUTF8(hubPath) : "";
    const previousBlock = existing.match(
      /<!-- scholar-bridge:sessions:start -->[\s\S]*?<!-- scholar-bridge:sessions:end -->/
    )?.[0] || "";
    const escapedFolder = PAPER_SESSIONS_FOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const links = previousBlock.match(new RegExp(`^- \\[\\[${escapedFolder}\\/.+\\]\\]$`, "gm")) || [];
    const newLink = `- [[${PAPER_SESSIONS_FOLDER}/${sessionFileName.replace(/\.md$/i, "")}]]`;
    const block = [
      start,
      "## AI 阅读会话",
      "",
      ...[...new Set([newLink, ...links])],
      end
    ].join("\n");
    if (!existing) {
      existing = [
        "---",
        `title: ${ScholarBridgeCore.escapeYaml(metadata.title)}`,
        `paper_id: ${ScholarBridgeCore.escapeYaml(metadata.paperId)}`,
        `stable_key: ${ScholarBridgeCore.escapeYaml(metadata.citeKey || metadata.zoteroItemKey)}`,
        `citekey: ${ScholarBridgeCore.escapeYaml(metadata.citeKey)}`,
        `zotero_item_key: ${ScholarBridgeCore.escapeYaml(metadata.zoteroItemKey)}`,
        `doi: ${ScholarBridgeCore.escapeYaml(metadata.doi)}`,
        "tags: [literature-note]",
        "---",
        "",
        `# ${metadata.title}`,
        "",
        `- 作者：${metadata.authors || "-"}`,
        `- 年份：${metadata.year || "-"}`,
        `- 稳定索引：${metadata.citeKey || metadata.zoteroItemKey}`,
        `- Zotero：[打开论文](${zoteroPDFLink(attachment, "1")})`,
        "",
        "## 阅读总览",
        "",
        "此处可补充人工笔记；插件只维护下方会话索引。",
        "",
        block,
        ""
      ].join("\n");
    } else if (previousBlock) {
      existing = existing.replace(previousBlock, block);
    } else {
      existing = `${existing.trimEnd()}\n\n${block}\n`;
    }
    await writeUTF8(hubPath, existing);
  }

  function renderChatUI(doc, body, item) {
    body.textContent = "";
    addStyle(body, "padding:8px;min-height:300px;box-sizing:border-box");

    const wrapper = createHTMLElement(doc, "div");
    addStyle(wrapper, "display:flex;flex-direction:column;gap:8px;min-height:300px;padding-bottom:26px");
    const tabRow = createHTMLElement(doc, "div");
    tabRow.setAttribute("role", "tablist");
    tabRow.setAttribute("aria-label", "论文 AI 功能");
    addStyle(tabRow, [
      "display:grid",
      "grid-template-columns:1fr 1fr",
      "gap:4px",
      "padding:3px",
      "border-radius:9px",
      "background:var(--fill-quinary,#e7e7e7)"
    ].join(";"));
    const dictionaryTab = createButton(doc, "词典预览");
    const chatTab = createButton(doc, "论文问答");
    for (const tab of [dictionaryTab, chatTab]) {
      tab.setAttribute("role", "tab");
      addStyle(tab, [
        "padding:7px 8px",
        "border:0",
        "border-radius:7px",
        "background:transparent",
        "color:inherit",
        "font:inherit",
        "font-weight:650",
        "cursor:pointer"
      ].join(";"));
    }
    tabRow.append(dictionaryTab, chatTab);

    const dictionaryView = createHTMLElement(doc, "div");
    dictionaryView.setAttribute("role", "tabpanel");
    addStyle(dictionaryView, "display:flex;flex-direction:column;gap:8px;min-height:0");
    const chatView = createHTMLElement(doc, "div");
    chatView.setAttribute("role", "tabpanel");
    addStyle(chatView, "display:flex;flex-direction:column;gap:8px");

    const dictionaryPanel = createHTMLElement(doc, "section");
    addStyle(dictionaryPanel, [
      "border:1px solid var(--fill-quinary,#ccc)",
      "border-radius:9px",
      "padding:9px",
      "background:var(--sb-accent-softer,color-mix(in srgb, var(--material-background,#fff) 94%, #2563a8 6%))"
    ].join(";"));
    const dictionaryTitle = createHTMLElement(doc, "div");
    dictionaryTitle.textContent = "AI 词典预览";
    addStyle(dictionaryTitle, "font-weight:700;margin-bottom:2px");
    const dictionaryModelNote = createHTMLElement(doc, "div");
    dictionaryModelNote.textContent = `固定使用快速模型 · ${getProviderConfig("fast").model} · 词典、专业搭配与句式分析共用一次生成`;
    addStyle(dictionaryModelNote, "font-size:.86em;opacity:.68;margin-bottom:7px");
    const dictionaryContent = createHTMLElement(doc, "div");
    addStyle(dictionaryContent, [
      "max-height:min(62vh,560px)",
      "overflow-y:auto",
      "overflow-x:hidden",
      "overscroll-behavior:contain",
      "padding-right:5px",
      "scrollbar-gutter:stable"
    ].join(";"));
    dictionaryPanel.append(dictionaryTitle, dictionaryModelNote, dictionaryContent);
    const dictionaryStatus = createHTMLElement(doc, "div");
    addStyle(dictionaryStatus, [
      "padding:7px 9px",
      "border:1px solid color-mix(in srgb,var(--sb-accent,#2563a8) 20%,var(--fill-quinary,#ccc))",
      "border-radius:7px",
      "background:var(--sb-accent-softer,var(--fill-quinary,#eee))",
      "font-size:.88em",
      "line-height:1.4"
    ].join(";"));
    dictionaryStatus.textContent = "词典状态：尚未生成预览。";
    const dictionaryActions = createHTMLElement(doc, "div");
    addStyle(dictionaryActions, [
      "display:none",
      "align-items:center",
      "gap:7px",
      "flex-wrap:wrap",
      "flex:0 0 auto",
      "padding:0 2px"
    ].join(";"));

    const chatTitle = createHTMLElement(doc, "div");
    chatTitle.textContent = "论文问答";
    addStyle(chatTitle, "font-weight:700;margin-top:4px");
    const chatHeadingRow = createHTMLElement(doc, "div");
    addStyle(chatHeadingRow, "display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap");
    const answerSizeSelect = createHTMLElement(doc, "select");
    answerSizeSelect.setAttribute("aria-label", "回答区域高度");
    answerSizeSelect.title = "也可以直接拖动回答区域下边缘改变高度";
    for (const [value, label] of [
      ["compact", "回答区：紧凑"],
      ["standard", "回答区：标准"],
      ["large", "回答区：扩展"]
    ]) {
      const option = createHTMLElement(doc, "option");
      option.value = value;
      option.textContent = label;
      answerSizeSelect.append(option);
    }
    answerSizeSelect.value = String(pref("answerPaneSize", "standard"));
    addStyle(answerSizeSelect, "min-height:27px;font-size:.88em");
    chatHeadingRow.append(chatTitle, answerSizeSelect);
    const sessionPanel = createHTMLElement(doc, "section");
    addStyle(sessionPanel, [
      "padding:8px",
      "border:1px solid var(--fill-quinary,#ccc)",
      "border-radius:8px",
      "background:var(--sb-accent-softer,color-mix(in srgb,var(--material-background,#fff) 94%,#2563a8 6%))"
    ].join(";"));
    const sessionLabel = createHTMLElement(doc, "div");
    sessionLabel.textContent = "阅读会话";
    addStyle(sessionLabel, "font-weight:650;margin-bottom:5px");
    const sessionRow = createHTMLElement(doc, "div");
    addStyle(sessionRow, "display:flex;gap:6px;align-items:center;flex-wrap:wrap");
    const sessionSelect = createHTMLElement(doc, "select");
    sessionSelect.setAttribute("aria-label", "历史阅读会话");
    addStyle(sessionSelect, "min-height:28px;flex:1;min-width:190px");
    const resumeButton = createButton(doc, "继续所选");
    const newSessionButton = createButton(doc, "新建会话");
    const sessionStatus = createHTMLElement(doc, "div");
    addStyle(sessionStatus, "font-size:.85em;opacity:.72;margin-top:5px;line-height:1.35");
    sessionRow.append(sessionSelect, resumeButton, newSessionButton);
    sessionPanel.append(sessionLabel, sessionRow, sessionStatus);
    const messages = createHTMLElement(doc, "div");
    addStyle(messages, [
      "display:flex",
      "flex-direction:column",
      "gap:7px",
      "min-height:170px",
      "height:min(50vh,520px)",
      "max-height:none",
      "resize:none",
      "overflow:auto",
      "padding:2px 5px 7px 0"
    ].join(";"));
    messages.setAttribute("aria-label", "可选择和复制的论文问答记录");
    messages.style.setProperty("user-select", "text", "important");
    messages.style.setProperty("-moz-user-select", "text", "important");
    messages.addEventListener("pointerdown", (event) => event.stopPropagation());
    messages.addEventListener("selectstart", (event) => event.stopPropagation());
    const answerResizeHandle = createHTMLElement(doc, "div");
    answerResizeHandle.setAttribute("role", "separator");
    answerResizeHandle.setAttribute("aria-label", "调整回答区域高度");
    answerResizeHandle.setAttribute("aria-orientation", "horizontal");
    addStyle(answerResizeHandle, [
      "width:100%",
      "height:8px",
      "margin:-5px 0",
      "background:transparent",
      "cursor:ns-resize",
      "user-select:none",
      "touch-action:none",
      "position:relative",
      "z-index:2"
    ].join(";"));
    const intro = createHTMLElement(doc, "div");
    intro.textContent = "阅读策略决定读取哪些论文内容；论文模型决定全部阅读、汇总、回答和复核调用快速模型还是深度模型。词典始终使用快速模型。";
    addStyle(intro, "font-size:.92em;opacity:.75;line-height:1.4");
    messages.append(intro);

    const modeRow = createHTMLElement(doc, "div");
    addStyle(modeRow, "display:flex;gap:7px;align-items:center;flex-wrap:wrap");
    const modeLabel = createHTMLElement(doc, "label");
    modeLabel.textContent = "阅读模式：";
    const modeSelect = createHTMLElement(doc, "select");
    for (const [value, label] of [
      ["quick", "快速"],
      ["deep", "深度（推荐）"],
      ["full", "全文"]
    ]) {
      const option = createHTMLElement(doc, "option");
      option.value = value;
      option.textContent = label;
      modeSelect.append(option);
    }
    modeSelect.value = String(pref("readingMode", "deep"));
    addStyle(modeSelect, "min-height:28px;flex:1");
    modeSelect.addEventListener("change", () => setPref("readingMode", modeSelect.value));
    modeRow.append(modeLabel, modeSelect);

    const modelRow = createHTMLElement(doc, "div");
    addStyle(modelRow, "display:flex;gap:7px;align-items:center;flex-wrap:wrap");
    const modelLabel = createHTMLElement(doc, "label");
    modelLabel.textContent = "论文模型：";
    const modelSelect = createHTMLElement(doc, "select");
    for (const quality of ["fast", "deep"]) {
      const config = getProviderConfig(quality);
      const option = createHTMLElement(doc, "option");
      option.value = quality;
      option.textContent = `${quality === "fast" ? "快速模型" : "深度模型"} · ${config.model}`;
      modelSelect.append(option);
    }
    modelSelect.value = String(pref("paperModelQuality", "deep")) === "fast" ? "fast" : "deep";
    modelSelect.title = "DeepSeek 下快速模型对应 Flash，深度模型对应 Pro";
    addStyle(modelSelect, "min-height:28px;flex:1;min-width:190px");
    modelRow.append(modelLabel, modelSelect);

    const memoryStatus = createHTMLElement(doc, "div");
    addStyle(memoryStatus, [
      "padding:7px 8px",
      "border:1px solid var(--fill-quinary,#ccc)",
      "border-radius:7px",
      "background:var(--fill-quinary,#eee)",
      "font-size:.88em",
      "line-height:1.4"
    ].join(";"));
    memoryStatus.textContent = "全文记忆：正在检查…";
    const modelChoicePanel = createHTMLElement(doc, "div");
    addStyle(modelChoicePanel, [
      "display:none",
      "padding:8px",
      "border:1px solid #d69e2e",
      "border-radius:7px",
      "background:#fff8df",
      "color:#4a3a00",
      "font-size:.9em",
      "line-height:1.4"
    ].join(";"));
    const modelChoiceText = createHTMLElement(doc, "div");
    const modelChoiceActions = createHTMLElement(doc, "div");
    addStyle(modelChoiceActions, "display:flex;gap:6px;flex-wrap:wrap;margin-top:6px");
    const answerOnlyButton = createButton(doc, "仅切换回答模型");
    const rebuildForModelButton = createButton(doc, "切换并重建全文记忆", true);
    modelChoiceActions.append(answerOnlyButton, rebuildForModelButton);
    modelChoicePanel.append(modelChoiceText, modelChoiceActions);

    const input = createHTMLElement(doc, "textarea");
    input.rows = 4;
    input.placeholder = "例如：作者为什么采用 CVaR？这个假设会带来什么限制？";
    addStyle(input, [
      "width:100%",
      "box-sizing:border-box",
      "resize:vertical",
      "padding:8px",
      "border-radius:7px",
      "border:1px solid var(--fill-quinary,#aaa)",
      "background:var(--material-background,#fff)",
      "color:inherit",
      "font:inherit"
    ].join(";"));
    const actions = createHTMLElement(doc, "div");
    addStyle(actions, "display:flex;gap:7px;flex-wrap:wrap");
    const askButton = createButton(doc, "提交问题", true);
    const memoryButton = createButton(doc, "首次构建全文记忆（消耗 Token）");
    const saveButton = createButton(doc, "保存会话到 Obsidian");
    const clearButton = createButton(doc, "清空未发布草稿");
    askButton.title = "按当前阅读模式和论文模型提交问题；回答会自动保存为隐藏草稿";
    memoryButton.title = "首次构建会阅读全文；已有记忆时重新构建会再次消耗 Token";
    saveButton.title = "首次保存会创建 Markdown；再次保存会更新同一个会话文件";
    clearButton.title = "已发布会话会保留并新建空白会话；未发布草稿将被清空";
    const chatStatus = createHTMLElement(doc, "div");
    addStyle(chatStatus, [
      "min-height:18px",
      "padding:7px 9px",
      "border:1px solid color-mix(in srgb,var(--sb-accent,#2563a8) 20%,var(--fill-quinary,#ccc))",
      "border-radius:7px",
      "background:var(--sb-accent-softer,var(--fill-quinary,#eee))",
      "font-size:.9em",
      "line-height:1.4"
    ].join(";"));
    chatStatus.textContent = "论文问答状态：正在初始化…";

    actions.append(askButton, memoryButton, saveButton, clearButton);
    dictionaryView.append(dictionaryPanel, dictionaryActions, dictionaryStatus);
    chatView.append(
      chatHeadingRow,
      sessionPanel,
      messages,
      answerResizeHandle,
      modeRow,
      modelRow,
      memoryStatus,
      modelChoicePanel,
      input,
      actions,
      chatStatus
    );
    wrapper.append(
      tabRow,
      dictionaryView,
      chatView
    );
    body.append(wrapper);

    function showTab(name) {
      const dictionaryActive = name === "dictionary";
      const previousTab = body._scholarBridgeActiveTab;
      const drawer = body.parentElement;
      if (dictionaryActive && previousTab !== "dictionary" && drawer && drawer.dataset.minimized !== "true") {
        drawer.dataset.chatHeight = `${Math.round(drawer.getBoundingClientRect().height)}px`;
      }
      body._scholarBridgeActiveTab = dictionaryActive ? "dictionary" : "chat";
      dictionaryView.hidden = !dictionaryActive;
      chatView.hidden = dictionaryActive;
      dictionaryView.style.display = dictionaryActive ? "flex" : "none";
      chatView.style.display = dictionaryActive ? "none" : "flex";
      dictionaryTab.setAttribute("aria-selected", String(dictionaryActive));
      chatTab.setAttribute("aria-selected", String(!dictionaryActive));
      dictionaryTab.style.background = dictionaryActive
        ? "var(--sb-accent-soft,var(--material-background,#fff))"
        : "transparent";
      chatTab.style.background = dictionaryActive
        ? "transparent"
        : "var(--sb-accent-soft,var(--material-background,#fff))";
      dictionaryTab.style.color = dictionaryActive ? "var(--sb-accent,#2563a8)" : "inherit";
      chatTab.style.color = dictionaryActive ? "inherit" : "var(--sb-accent,#2563a8)";
      dictionaryTab.style.boxShadow = dictionaryActive
        ? "0 0 0 1px color-mix(in srgb,var(--sb-accent,#2563a8) 25%,transparent),0 1px 3px #0001"
        : "none";
      chatTab.style.boxShadow = dictionaryActive
        ? "none"
        : "0 0 0 1px color-mix(in srgb,var(--sb-accent,#2563a8) 25%,transparent),0 1px 3px #0001";
      if (dictionaryActive) {
        fitDictionaryWorkspace();
      } else if (previousTab === "dictionary" && drawer?.dataset.chatHeight && drawer.dataset.minimized !== "true") {
        drawer.style.height = drawer.dataset.chatHeight;
      }
    }

    function fitDictionaryWorkspace() {
      const drawer = body.parentElement;
      const view = doc.defaultView;
      if (!drawer || body._scholarBridgeActiveTab !== "dictionary" || drawer.dataset.minimized === "true") return;
      view.requestAnimationFrame?.(() => {
        if (!drawer.isConnected || body._scholarBridgeActiveTab !== "dictionary") return;
        const headerHeight = drawer.firstElementChild?.getBoundingClientRect().height || 48;
        const maximum = Math.max(300, view.innerHeight - Math.max(4, drawer.getBoundingClientRect().top) - 8);
        const desired = Math.ceil(headerHeight + wrapper.scrollHeight + 12);
        drawer.style.height = `${Math.min(maximum, Math.max(300, desired))}px`;
      });
    }
    dictionaryTab.addEventListener("click", () => showTab("dictionary"));
    chatTab.addEventListener("click", () => showTab("chat"));
    showTab("chat");
    body._scholarBridgeShowTab = showTab;
    body._scholarBridgeInsertQuestion = (text) => {
      const value = String(text || "").trim();
      if (!value) return;
      showTab("chat");
      input.value = [input.value.trim(), value].filter(Boolean).join("\n\n");
      input.focus();
      input.setSelectionRange?.(input.value.length, input.value.length);
      chatStatus.textContent = "论文问答：已把 PDF 选中内容加入提问框；请补充问题后点击“提交问题”。";
    };

    async function currentAttachment() {
      return resolveAttachment(item);
    }

    function applyAnswerPaneSize(value) {
      const heights = {
        compact: "300px",
        standard: "min(50vh,520px)",
        large: "70vh"
      };
      messages.style.height = heights[value] || heights.standard;
    }
    applyAnswerPaneSize(answerSizeSelect.value);
    const savedAnswerPaneHeight = Number(pref("answerPaneHeight", 0));
    if (savedAnswerPaneHeight >= 170) messages.style.height = `${savedAnswerPaneHeight}px`;
    answerSizeSelect.addEventListener("change", () => {
      setPref("answerPaneSize", answerSizeSelect.value);
      setPref("answerPaneHeight", 0);
      applyAnswerPaneSize(answerSizeSelect.value);
    });
    enableVerticalResizing(messages, answerResizeHandle, (height) => {
      setPref("answerPaneHeight", height);
    });

    function selectedConversationText() {
      const selection = messages.ownerDocument.defaultView.getSelection?.();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
      const anchor = selection.anchorNode?.nodeType === 1
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;
      const focus = selection.focusNode?.nodeType === 1
        ? selection.focusNode
        : selection.focusNode?.parentElement;
      if (!messages.contains(anchor) || !messages.contains(focus)) return "";
      return String(selection).trim();
    }

    function quoteConversationText(selected) {
      const quoted = selected.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
      body._scholarBridgeInsertQuestion(`引用上一轮内容：\n${quoted}`);
    }

    function copyConversationText(selected) {
      try {
        Components.classes["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Components.interfaces.nsIClipboardHelper)
          .copyString(selected);
        chatStatus.textContent = "论文问答：选中内容已复制到剪贴板。";
      } catch (error) {
        Zotero.logError(error);
        chatStatus.textContent = `论文问答复制失败：${error.message}`;
      }
    }

    let conversationContextMenu = null;
    function dismissConversationContextMenu() {
      if (conversationContextMenu) conversationContextMenu.remove();
      conversationContextMenu = null;
      doc.removeEventListener("pointerdown", dismissConversationContextMenu);
      doc.removeEventListener("keydown", dismissConversationContextMenuOnEscape);
    }
    function dismissConversationContextMenuOnEscape(event) {
      if (event.key === "Escape") dismissConversationContextMenu();
    }
    function showConversationContextMenu(event, selected) {
      dismissConversationContextMenu();
      const menu = createHTMLElement(doc, "div");
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "选中文字操作");
      addStyle(menu, [
        "position:fixed",
        "z-index:2147483600",
        "display:flex",
        "flex-direction:column",
        "min-width:158px",
        "padding:5px",
        "gap:2px",
        "border:1px solid var(--fill-quinary,#c9c9c9)",
        "border-radius:8px",
        "background:var(--material-background,#fff)",
        "color:var(--material-foreground,#222)",
        "box-shadow:0 8px 24px #0003"
      ].join(";"));
      applyWorkspaceTheme(menu, String(pref("workspaceTheme", "ocean")));
      function addMenuAction(label, action) {
        const button = createButton(doc, label);
        button.setAttribute("role", "menuitem");
        addStyle(button, "width:100%;padding:7px 10px;text-align:left;border:0;background:transparent;border-radius:6px;color:inherit");
        button.addEventListener("mouseenter", () => {
          button.style.background = "var(--sb-accent-soft,var(--fill-quinary,#eee))";
        });
        button.addEventListener("mouseleave", () => {
          button.style.background = "transparent";
        });
        button.addEventListener("pointerdown", (pointerEvent) => {
          pointerEvent.preventDefault();
          pointerEvent.stopPropagation();
        });
        button.addEventListener("click", () => {
          dismissConversationContextMenu();
          action(selected);
        });
        menu.append(button);
      }
      addMenuAction("引用到提问框", quoteConversationText);
      addMenuAction("复制选中文字", copyConversationText);
      menu.addEventListener("pointerdown", (pointerEvent) => pointerEvent.stopPropagation());
      doc.body.append(menu);
      conversationContextMenu = menu;
      const view = doc.defaultView;
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(6, Math.min(event.clientX, view.innerWidth - rect.width - 6))}px`;
      menu.style.top = `${Math.max(6, Math.min(event.clientY, view.innerHeight - rect.height - 6))}px`;
      doc.addEventListener("pointerdown", dismissConversationContextMenu);
      doc.addEventListener("keydown", dismissConversationContextMenuOnEscape);
    }
    messages.addEventListener("contextmenu", (event) => {
      const selected = selectedConversationText();
      if (!selected) {
        dismissConversationContextMenu();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      showConversationContextMenu(event, selected);
    });
    messages.addEventListener("scroll", dismissConversationContextMenu);

    function formatSessionTime(value) {
      if (!value) return "";
      try { return new Date(value).toLocaleString("zh-CN", { hour12: false }); } catch (_error) { return value; }
    }

    function renderConversation(entries) {
      messages.replaceChildren(intro);
      for (const entry of entries || []) {
        let text = entry.text;
        if (entry.role === "assistant") {
          const metadataLine = [entry.mode, entry.model, formatSessionTime(entry.time)].filter(Boolean).join(" · ");
          if (metadataLine) text = `${metadataLine}\n\n${text}`;
        }
        appendMessage(doc, messages, entry.role, text);
      }
    }

    async function refreshSessionUI(attachment, selectedSessionID = "") {
      const state = await loadPaperSessionState(attachment);
      const sessions = [...state.sessions].sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt))
      );
      sessionSelect.replaceChildren();
      for (const session of sessions) {
        const option = createHTMLElement(doc, "option");
        option.value = session.id;
        const publication = session.publishedAt ? "已写入 Obsidian" : "自动草稿";
        const active = session.id === state.activeSessionId ? "当前 · " : "";
        option.textContent = `${active}${session.title || "新阅读会话"} · ${publication} · ${formatSessionTime(session.updatedAt)}`;
        sessionSelect.append(option);
      }
      sessionSelect.value = selectedSessionID || state.activeSessionId;
      const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
      if (activeSession) {
        sessionStatus.textContent = activeSession.publishedAt
          ? `当前会话已发布；后续提问会自动保存草稿，点击“保存会话”将更新原文件。最近更新：${formatSessionTime(activeSession.updatedAt)}`
          : `当前会话会在每轮问答后自动保存为隐藏草稿。最近更新：${formatSessionTime(activeSession.updatedAt)}`;
        saveButton.textContent = activeSession.publishedAt
          ? "更新当前会话到 Obsidian"
          : "保存会话到 Obsidian";
        clearButton.textContent = activeSession.publishedAt
          ? "开始空白新会话"
          : "清空未发布草稿";
      }
    }

    async function refreshMemoryStatus(attachment, offerModelChoice = false) {
      memoryStatus.textContent = "全文记忆：正在核对 PDF 指纹…";
      const report = await inspectPaperMemory(attachment);
      modelChoicePanel.style.display = "none";
      memoryStatus.style.color = "inherit";
      memoryStatus.style.borderColor = "var(--fill-quinary,#ccc)";
      memoryStatus.style.background = "var(--fill-quinary,#eee)";
      if (report.state === "missing") {
        memoryStatus.textContent = "○ 全文记忆尚未构建 · 快速模式可直接提问；深度模式首次提问会自动构建。";
        memoryButton.textContent = "首次构建全文记忆（消耗 Token）";
        return report;
      }
      const memoryModel = report.metadata.memory_model
        || String(report.metadata.generated_by || "").split(":").slice(1).join(":")
        || "旧版未记录";
      const generated = report.metadata.generated || "时间未知";
      if (report.state === "changed") {
        memoryStatus.textContent = `⚠ PDF 正文已变化 · 旧全文记忆由 ${memoryModel} 生成。下次深度提问会自动更新，也可以现在更新。`;
        memoryStatus.style.color = "#b42318";
        memoryStatus.style.borderColor = "#d97706";
        memoryStatus.style.background = "#fff8df";
        memoryButton.textContent = "更新全文记忆（PDF 已变化）";
      } else if (report.state === "legacy") {
        memoryStatus.textContent = `△ 旧版全文记忆可继续使用 · 模型：${memoryModel} · 未记录 PDF 指纹，建议更新一次。`;
        memoryButton.textContent = "升级旧版全文记忆（消耗 Token）";
      } else {
        memoryStatus.textContent = `✓ 全文记忆已构建 · 模型：${memoryModel} · 时间：${generated} · PDF 未变化。深度模式将直接复用，无需再次构建。`;
        memoryStatus.style.borderColor = "#65a375";
        memoryStatus.style.background = "color-mix(in srgb,var(--material-background,#fff) 90%,#58a66c 10%)";
        memoryButton.textContent = "重新构建全文记忆（再次消耗 Token）";
      }
      const selectedModel = getProviderConfig(modelSelect.value).model;
      if (offerModelChoice && memoryModel !== "旧版未记录" && memoryModel !== selectedModel) {
        modelChoiceText.textContent = `现有全文记忆由 ${memoryModel} 生成；你刚切换到 ${selectedModel}。请选择只切换后续回答，还是同时用新模型重建全文记忆。`;
        modelChoicePanel.style.display = "block";
      }
      return report;
    }

    async function rebuildMemory() {
      try {
        const attachment = await currentAttachment();
        const report = await inspectPaperMemory(attachment);
        if (report.state === "current" || report.state === "legacy") {
          const confirmed = doc.defaultView.confirm?.(
            "这篇论文已经有可用的全文记忆。重新构建会再次提交全文并消耗 Token，同时覆盖旧记忆。\n\n确定继续吗？"
          );
          if (!confirmed) {
            chatStatus.textContent = "论文问答：已取消重新构建；现有全文记忆保持不变，没有调用模型。";
            return;
          }
        }
        memoryButton.disabled = true;
        rebuildForModelButton.disabled = true;
        await buildPaperMemory(
          attachment,
          (message) => { chatStatus.textContent = `全文记忆：${message}`; },
          true,
          modelSelect.value
        );
        chatStatus.textContent = `全文记忆：已由 ${getProviderConfig(modelSelect.value).model} 重新阅读论文、构建并保存。`;
        modelChoicePanel.style.display = "none";
        await refreshMemoryStatus(attachment, false);
        showProgress("论文全文记忆", "构建完成");
      } catch (error) {
        Zotero.logError(error);
        chatStatus.textContent = `全文记忆构建失败：${error.message}`;
      } finally {
        memoryButton.disabled = false;
        rebuildForModelButton.disabled = false;
      }
    }

    async function initializePaperWorkspace() {
      askButton.disabled = true;
      resumeButton.disabled = true;
      newSessionButton.disabled = true;
      try {
        const attachment = await currentAttachment();
        const { session } = await ensureActivePaperSession(attachment);
        renderConversation(session.entries);
        await refreshSessionUI(attachment);
        await refreshMemoryStatus(attachment, false);
        chatStatus.textContent = session.entries.length
          ? "论文问答：已恢复上次阅读会话，可以继续提问。"
          : "论文问答：已准备空白阅读会话。";
      } catch (error) {
        Zotero.logError(error);
        chatStatus.textContent = `论文问答初始化失败：${error.message}`;
      } finally {
        askButton.disabled = false;
        resumeButton.disabled = false;
        newSessionButton.disabled = false;
      }
    }

    function previewText(parent, label, value, strong = false) {
      if (!value) return;
      const line = createHTMLElement(doc, "div");
      const labelNode = createHTMLElement(doc, strong ? "strong" : "span");
      labelNode.textContent = `${label}：`;
      const valueNode = createHTMLElement(doc, "span");
      valueNode.textContent = value;
      line.append(labelNode, valueNode);
      addStyle(line, "line-height:1.45;margin:2px 0");
      parent.append(line);
    }

    function renderDictionaryPreview(preview) {
      dictionaryContent.replaceChildren();
      dictionaryActions.replaceChildren();
      dictionaryActions.style.display = "none";
      if (!preview) {
        const hint = createHTMLElement(doc, "div");
        hint.textContent = "在 PDF 中选中单词或短语，点击“生成 AI 词典预览”。确认释义和原句后再保存到 Obsidian。";
        addStyle(hint, "font-size:.92em;opacity:.72;line-height:1.45");
        dictionaryContent.append(hint);
        dictionaryStatus.textContent = "词典状态：尚未生成预览；未调用模型，也未修改 Obsidian。";
        fitDictionaryWorkspace();
        return;
      }
      const entry = ScholarBridgeCore.normalizeSenseIDs(preview.entry);
      preview.entry = entry;
      dictionaryStatus.textContent = preview.saved || preview.duplicate
        ? `词典状态：已生成“${entry.lemma || entry.word}”并存在于 Obsidian；可以检查或恢复文件。`
        : `词典状态：已使用快速模型生成“${entry.lemma || entry.word}”预览，尚未写入 Obsidian。`;
      const heading = createHTMLElement(doc, "div");
      heading.textContent = entry.lemma || entry.word || "词条";
      addStyle(heading, "font-size:1.25em;font-weight:750;margin:2px 0 5px");
      dictionaryContent.append(heading);
      previewText(
        dictionaryContent,
        "核心解释",
        entry.short_definition || entry.senses[0]?.chinese_definition || "释义待补充",
        true
      );
      previewText(dictionaryContent, "词性", entry.part_of_speech || "待确认");
      previewText(dictionaryContent, "音标", entry.pronunciation || "待确认");

      const occurrence = preview.occurrence || preview.occurrences?.at(-1);
      if (occurrence) {
        const contextBox = createHTMLElement(doc, "div");
        addStyle(contextBox, [
          "margin:8px 0",
          "padding:7px 8px",
          "border-left:3px solid var(--sb-accent,#2563a8)",
          "background:var(--sb-accent-soft,color-mix(in srgb, var(--material-background,#fff) 88%, #2563a8 12%))"
        ].join(";"));
        const contextTitle = createHTMLElement(doc, "strong");
        contextTitle.textContent = `当前论文语境 · p. ${occurrence.pageLabel || "-"}`;
        const quote = createHTMLElement(doc, "div");
        quote.textContent = occurrence.sentence || occurrence.selectedText;
        addStyle(quote, "font-style:italic;line-height:1.45;margin:5px 0");
        contextBox.append(contextTitle, quote);
        previewText(contextBox, "本句含义", occurrence.contextualMeaning || "待确认", true);
        previewText(contextBox, "对应义项", occurrence.senseId || occurrence.currentSense || "待确认");
        const analysis = occurrence.sentenceAnalysis || {};
        if (analysis.sentence_pattern || analysis.structure?.length || analysis.grammar_points?.length) {
          const analysisBox = createHTMLElement(doc, "div");
          addStyle(analysisBox, "margin-top:8px;padding-top:7px;border-top:1px solid var(--fill-quinary,#ddd)");
          const analysisTitle = createHTMLElement(doc, "strong");
          analysisTitle.textContent = "句式与语法";
          analysisBox.append(analysisTitle);
          previewText(analysisBox, "核心句式", analysis.sentence_pattern || "");
          previewText(analysisBox, "结构拆解", (analysis.structure || []).join("；"));
          previewText(analysisBox, "语法要点", (analysis.grammar_points || []).join("；"));
          previewText(analysisBox, "学术表达", analysis.academic_usage || "");
          contextBox.append(analysisBox);
        }
        dictionaryContent.append(contextBox);
      }

      const collocationNotes = entry.senses.flatMap((sense, senseIndex) =>
        (sense.collocation_notes || []).map((note) => ({ ...note, senseIndex, sense }))
      );
      if (collocationNotes.length) {
        const collocationTitle = createHTMLElement(doc, "div");
        collocationTitle.textContent = `专业固定搭配（${collocationNotes.length}）`;
        addStyle(collocationTitle, "font-weight:700;margin:9px 0 4px");
        dictionaryContent.append(collocationTitle);
        for (const item of collocationNotes) {
          const box = createHTMLElement(doc, "div");
          addStyle(box, "padding:6px 7px;margin:4px 0;border:1px solid var(--fill-quinary,#ddd);border-radius:7px");
          const phrase = createHTMLElement(doc, "strong");
          phrase.textContent = item.phrase;
          box.append(phrase);
          previewText(box, "领域", item.domain || item.sense.domain || "通用");
          previewText(box, "专业含义", item.chinese_explanation || "待补充");
          previewText(box, "使用说明", item.usage_note || "待补充");
          dictionaryContent.append(box);
        }
      }

      const sensesTitle = createHTMLElement(doc, "div");
      sensesTitle.textContent = `多义项与例句（${entry.senses.length}）`;
      addStyle(sensesTitle, "font-weight:700;margin:8px 0 4px");
      dictionaryContent.append(sensesTitle);
      entry.senses.forEach((sense, index) => {
        const senseBox = createHTMLElement(doc, "section");
        addStyle(senseBox, "border-top:1px solid var(--fill-quinary,#ddd);padding:5px 0");
        const summary = createHTMLElement(doc, "div");
        summary.textContent = `义项 ${index + 1} · ${sense.chinese_definition || "释义待补充"}`;
        addStyle(summary, "font-weight:650;line-height:1.4");
        const senseBody = createHTMLElement(doc, "div");
        addStyle(senseBody, "padding:5px 4px 2px 14px");
        previewText(senseBody, "词性", sense.part_of_speech || "-");
        previewText(senseBody, "领域", sense.domain || "通用");
        previewText(senseBody, "扩展解释", sense.english_definition || "");
        if (sense.collocations?.length) {
          previewText(senseBody, "常见搭配", sense.collocations.join("；"));
        }
        (sense.ai_examples || []).forEach((example, exampleIndex) => {
          previewText(senseBody, `例句 ${exampleIndex + 1}`, example.english || "");
          previewText(senseBody, "翻译", example.chinese || "");
        });
        senseBox.append(summary, senseBody);
        dictionaryContent.append(senseBox);
      });

      const commitButton = createButton(
        doc,
        preview.needsMigration
          ? "更新为新版词条格式"
          : preview.saved || preview.duplicate
            ? "检查/恢复到 Obsidian"
            : "确认保存到 Obsidian",
        Boolean(preview.needsMigration || (!preview.saved && !preview.duplicate))
      );
      const cancelButton = createButton(doc, "关闭预览");
      dictionaryActions.replaceChildren(commitButton, cancelButton);
      dictionaryActions.style.display = "flex";

      commitButton.addEventListener("click", async () => {
        commitButton.disabled = true;
        commitButton.textContent = "正在保存…";
        try {
          const wasMigration = Boolean(preview.needsMigration);
          await commitVocabulary(preview);
          commitButton.textContent = preview.restored
            ? "已恢复到 Obsidian"
            : wasMigration
            ? "词条格式已更新"
            : preview.duplicate
              ? "该语境已存在"
              : "已保存到 Obsidian";
          commitButton.disabled = false;
          dictionaryStatus.textContent = preview.restored
            ? `词典状态：已把“${entry.lemma || entry.word}”恢复到 Obsidian。`
            : `词典状态：已把“${entry.lemma || entry.word}”保存到 Obsidian。`;
          showProgress("AI 词典", `已保存：${entry.lemma || entry.word}`);
        } catch (error) {
          Zotero.logError(error);
          commitButton.disabled = false;
          commitButton.textContent = "保存失败，点击重试";
          dictionaryStatus.textContent = `词典保存失败：${error.message}`;
        }
      });
      cancelButton.addEventListener("click", () => {
        vocabularyPreviews.delete(preview.attachmentID);
        renderDictionaryPreview(null);
        dictionaryStatus.textContent = "词典状态：预览已关闭，没有修改 Obsidian。";
      });
      fitDictionaryWorkspace();
    }

    const previewView = {
      body,
      async refresh(targetAttachmentID = null) {
        try {
          if (!body?.isConnected) return;
        } catch (_error) {
          return;
        }
        try {
          const attachment = await currentAttachment();
          if (targetAttachmentID && attachment.id !== targetAttachmentID) return;
          const preview = vocabularyPreviews.get(attachment.id) || null;
          renderDictionaryPreview(preview);
          if (preview && targetAttachmentID) showTab("dictionary");
        } catch (error) {
          try {
            if (body?.isConnected) renderDictionaryPreview(null);
          } catch (_deadObjectError) {
            vocabularyPreviewViews.delete(previewView);
          }
        }
      }
    };
    vocabularyPreviewViews.add(previewView);
    previewView.refresh();

    async function submit() {
      const question = ScholarBridgeCore.normalizeWhitespace(input.value);
      if (!question) return;
      input.value = "";
      askButton.disabled = true;
      chatStatus.textContent = `论文问答：正在以“${modeSelect.options[modeSelect.selectedIndex]?.textContent || modeSelect.value}”模式调用 ${getProviderConfig(modelSelect.value).model}…`;
      appendMessage(doc, messages, "user", question);
      try {
        const attachment = await currentAttachment();
        await ensureActivePaperSession(attachment);
        conversationFor(attachment.id).push({
          role: "user",
          text: question,
          time: new Date().toISOString()
        });
        await persistActivePaperSession(attachment);
        const placeholder = appendMessage(doc, messages, "assistant", "正在思考…");
        const result = await askPaper(
          attachment,
          question,
          modeSelect.value,
          modelSelect.value,
          (message) => { chatStatus.textContent = `论文问答：${message}`; }
        );
        renderScholarMarkdown(placeholder, result.answer);
        conversationFor(attachment.id).push({
          role: "assistant",
          text: result.answer,
          time: new Date().toISOString(),
          mode: result.mode,
          model: result.model,
          provider: result.provider,
          citations: ScholarBridgeCore.extractCitations(result.answer)
        });
        await persistActivePaperSession(attachment);
        await refreshSessionUI(attachment);
        chatStatus.textContent = `论文问答完成 · 阅读模式：${result.mode} · 模型：${result.model} · 已自动保存隐藏草稿；请按页码回到原文核对。`;
      } catch (error) {
        Zotero.logError(error);
        appendMessage(doc, messages, "assistant", `错误：${error.message}`);
        chatStatus.textContent = `论文问答失败：${error.message}`;
      } finally {
        askButton.disabled = false;
      }
    }

    askButton.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit();
      }
    });
    modelSelect.addEventListener("change", async () => {
      setPref("paperModelQuality", modelSelect.value);
      try {
        const attachment = await currentAttachment();
        await refreshMemoryStatus(attachment, true);
      } catch (error) {
        Zotero.logError(error);
        chatStatus.textContent = `论文模型已切换，但全文记忆状态检查失败：${error.message}`;
      }
    });
    answerOnlyButton.addEventListener("click", () => {
      modelChoicePanel.style.display = "none";
      chatStatus.textContent = `论文问答：后续回答改用 ${getProviderConfig(modelSelect.value).model}；现有全文记忆保持不变，没有重新阅读全文。`;
    });
    rebuildForModelButton.addEventListener("click", rebuildMemory);
    memoryButton.addEventListener("click", rebuildMemory);
    resumeButton.addEventListener("click", async () => {
      resumeButton.disabled = true;
      try {
        const attachment = await currentAttachment();
        await persistActivePaperSession(attachment);
        const { session } = await resumePaperSession(attachment, sessionSelect.value);
        renderConversation(session.entries);
        await refreshSessionUI(attachment);
        chatStatus.textContent = `论文问答：已恢复会话“${session.title || "阅读会话"}”。`;
      } catch (error) {
        Zotero.logError(error);
        chatStatus.textContent = `论文问答恢复会话失败：${error.message}`;
      } finally {
        resumeButton.disabled = false;
      }
    });
    newSessionButton.addEventListener("click", async () => {
      newSessionButton.disabled = true;
      try {
        const attachment = await currentAttachment();
        await persistActivePaperSession(attachment);
        const { session } = await startNewPaperSession(attachment);
        renderConversation(session.entries);
        await refreshSessionUI(attachment);
        chatStatus.textContent = "论文问答：已开始新的空白会话；上一会话已保留。";
      } catch (error) {
        Zotero.logError(error);
        chatStatus.textContent = `论文问答新建会话失败：${error.message}`;
      } finally {
        newSessionButton.disabled = false;
      }
    });
    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      try {
        const attachment = await currentAttachment();
        const filePath = await saveConversation(attachment);
        chatStatus.textContent = `论文问答：当前会话已保存或更新到 Obsidian。文件：${filePath}`;
        await refreshSessionUI(attachment);
        showProgress("AI 阅读会话", "已写入 Obsidian");
      } catch (error) {
        Zotero.logError(error);
        chatStatus.textContent = `论文问答保存失败：${error.message}`;
      } finally {
        saveButton.disabled = false;
      }
    });
    clearButton.addEventListener("click", async () => {
      try {
        const attachment = await currentAttachment();
        const { session } = await ensureActivePaperSession(attachment);
        if (session.publishedAt) {
          await startNewPaperSession(attachment);
          chatStatus.textContent = "论文问答：已发布的 Obsidian 会话保持不变，并已开始空白新会话。";
        } else {
          conversations.set(attachment.id, []);
          await persistActivePaperSession(attachment);
          chatStatus.textContent = "论文问答：尚未发布的当前草稿已清空；全文记忆和已发布会话未受影响。";
        }
        renderConversation([]);
        await refreshSessionUI(attachment);
      } catch (error) {
        Zotero.logError(error);
        chatStatus.textContent = `论文问答清空失败：${error.message}`;
      }
    });
    initializePaperWorkspace();
  }

  function renderChatUIWithFallback({ doc, body, item }) {
    try {
      renderChatUI(doc, body, item);
    } catch (error) {
      Zotero.logError(error);
      try {
        body.textContent = "";
        const errorBox = createHTMLElement(doc, "div");
        addStyle(errorBox, [
          "margin:8px",
          "padding:10px",
          "border:1px solid #d9534f",
          "border-radius:8px",
          "color:#b42318",
          "white-space:pre-wrap",
          "line-height:1.45"
        ].join(";"));
        errorBox.textContent = `论文 AI 工作台加载失败：${error?.message || String(error)}`;
        body.appendChild(errorBox);
      } catch (fallbackError) {
        Zotero.logError(fallbackError);
      }
    }
  }

  function registerPreferences() {
    Zotero.PreferencePanes.register({
      pluginID: ADDON_ID,
      src: rootURI + "chrome/content/preferences.xhtml",
      label: "Obsidian Scholar Bridge",
      image: rootURI + "chrome/content/icons/icon-48.svg"
    });
  }

  function onMainWindowLoad(window) {
    window.MozXULElement?.insertFTLIfNeeded("obsidian-scholar-bridge.ftl");
  }

  function onMainWindowUnload(window) {
    window.document.querySelector('[href="obsidian-scholar-bridge.ftl"]')?.remove();
  }

  async function testConnection() {
    const fast = await callModel({
      system: "Answer concisely.",
      user: "Return exactly: OK",
      structured: false,
      quality: "fast"
    });
    const fastConfig = getProviderConfig("fast");
    const deepConfig = getProviderConfig("deep");
    let deep = fast;
    if (deepConfig.model !== fastConfig.model) {
      deep = await callModel({
        system: "Answer concisely.",
        user: "Return exactly: OK",
        structured: false,
        quality: "deep"
      });
    }
    return `快速 ${fastConfig.model}: ${fast.trim()}；深度 ${deepConfig.model}: ${deep.trim()}`;
  }

  function migratePreferences() {
    const oldDeepSeek = String(pref("deepseek.model", ""));
    if (["deepseek-chat", "deepseek-reasoner"].includes(oldDeepSeek)) {
      setPref("deepseek.model", "deepseek-v4-flash");
      setPref("deepseek.deepModel", "deepseek-v4-pro");
    }
    if (String(pref("chatFolder", "")) === "Literature/AI Sessions") {
      setPref("chatFolder", "Literature");
    }
  }

  async function startup() {
    migratePreferences();
    registerPreferences();
    for (const window of Zotero.getMainWindows()) onMainWindowLoad(window);
    registerSelectionPopup();
    registerReaderToolbar();
    registerToolsMenu();
  }

  function shutdown() {
    // Zotero removes Reader listeners registered with pluginID automatically.
    // Do not call Reader.unregisterEventListener() here: Zotero 9.0.6's local
    // implementation uses an inverted filter and can remove other plugins'
    // listeners. Keeping cleanup plugin-scoped avoids breaking PDF Translate.
    selectionHandler = null;
    toolbarHandler = null;
    if (toolsMenuID) {
      Zotero.MenuManager.unregisterMenu(toolsMenuID);
      toolsMenuID = null;
    }
    for (const window of Zotero.getMainWindows()) onMainWindowUnload(window);
    textCache.clear();
    paperMemoryCache.clear();
    conversations.clear();
    paperSessionStates.clear();
    vocabularyIndex.clear();
    vocabularyIndexReady = false;
    vocabularyPreviews.clear();
    vocabularyPreviewViews.clear();
  }

  return {
    startup,
    shutdown,
    onMainWindowLoad,
    onMainWindowUnload,
    getAPIKey,
    setAPIKey,
    getProviderConfig,
    getProviderDefaults,
    pref,
    setPref,
    testConnection,
    saveVocabulary
  };
})();
