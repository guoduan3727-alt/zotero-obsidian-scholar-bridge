/* global Zotero, ChromeUtils */

var ObsidianScholarBridgePrefs = {
  bridge: null,
  win: null,
  doc: null,

  async init(prefWindow) {
    if (!prefWindow?.document) throw new Error("设置页窗口不可用");
    this.bridge = Zotero.ObsidianScholarBridge;
    this.win = prefWindow;
    this.doc = prefWindow.document;
    const provider = this.get("bridge-provider");
    provider.value = String(this.bridge.pref("provider", "openai"));

    this.get("bridge-vault-path").value = String(this.bridge.pref("vaultPath", ""));
    this.get("bridge-vocabulary-folder").value = String(
      this.bridge.pref("vocabularyFolder", "Vocabulary")
    );
    this.get("bridge-chat-folder").value = String(
      this.bridge.pref("chatFolder", "Literature")
    );
    this.get("bridge-answer-language").value = String(
      this.bridge.pref("answerLanguage", "zh-CN")
    );
    this.get("bridge-reading-mode").value = String(
      this.bridge.pref("readingMode", "deep")
    );
    this.get("bridge-paper-model-quality").value = String(
      this.bridge.pref("paperModelQuality", "deep")
    ) === "fast" ? "fast" : "deep";

    const switchProvider = async () => {
      this.bridge.setPref("provider", provider.value);
      await this.loadProvider();
    };
    provider.addEventListener("input", switchProvider);
    provider.addEventListener("change", switchProvider);
    this.get("bridge-base-url").addEventListener("change", () => this.saveProviderFields());
    this.get("bridge-model").addEventListener("change", () => this.saveProviderFields());
    this.get("bridge-deep-model").addEventListener("change", () => this.saveProviderFields());
    this.get("bridge-vault-path").addEventListener("change", () => this.saveOutputFields());
    this.get("bridge-vocabulary-folder").addEventListener("change", () => this.saveOutputFields());
    this.get("bridge-chat-folder").addEventListener("change", () => this.saveOutputFields());
    this.get("bridge-answer-language").addEventListener("change", () => this.saveOutputFields());
    this.get("bridge-reading-mode").addEventListener("change", () => this.saveOutputFields());
    this.get("bridge-paper-model-quality").addEventListener("change", () => this.saveOutputFields());
    this.get("bridge-browse").addEventListener("click", () => this.chooseVault());
    this.get("bridge-provider-preset").addEventListener("click", () => {
      this.applyRecommendedProviderConfig();
    });
    this.get("bridge-test").addEventListener("click", () => this.saveAndTest());
    await this.loadProvider();
  },

  get(id) {
    return this.doc.getElementById(id);
  },

  setStatus(message, isError = false) {
    const status = this.get("bridge-status");
    status.textContent = message;
    status.style.color = isError ? "#c0392b" : "inherit";
  },

  async loadProvider() {
    const provider = this.get("bridge-provider").value;
    const defaults = this.bridge.getProviderDefaults(provider);
    this.get("bridge-base-url").value = String(
      this.bridge.pref(`${provider}.baseURL`, defaults.baseURL)
    ).trim() || defaults.baseURL;
    this.get("bridge-model").value = String(
      this.bridge.pref(`${provider}.model`, defaults.model)
    ).trim() || defaults.model;
    this.get("bridge-deep-model").value = String(
      this.bridge.pref(`${provider}.deepModel`, defaults.deepModel)
    ).trim() || defaults.deepModel || this.get("bridge-model").value;
    this.get("bridge-api-key").value = await this.bridge.getAPIKey(provider);
    const labels = {
      openai: "OpenAI · Responses API",
      deepseek: "DeepSeek · Chat Completions · Flash/Pro 1M",
      generic: "通用 OpenAI-compatible / 本地模型"
    };
    this.setStatus(`当前服务商：${labels[provider] || provider}`);
  },

  applyRecommendedProviderConfig() {
    const provider = this.get("bridge-provider").value;
    const defaults = this.bridge.getProviderDefaults(provider);
    this.get("bridge-base-url").value = defaults.baseURL;
    this.get("bridge-model").value = defaults.model;
    this.get("bridge-deep-model").value = defaults.deepModel;
    this.saveProviderFields();
    this.setStatus(provider === "deepseek"
      ? "已应用 DeepSeek 推荐配置：V4 Flash（快速）+ V4 Pro（深度），均支持 1M 上下文。"
      : "已应用该服务商的推荐配置。"
    );
  },

  saveProviderFields() {
    const provider = this.get("bridge-provider").value;
    this.bridge.setPref("provider", provider);
    this.bridge.setPref(`${provider}.baseURL`, this.get("bridge-base-url").value.trim());
    this.bridge.setPref(`${provider}.model`, this.get("bridge-model").value.trim());
    this.bridge.setPref(
      `${provider}.deepModel`,
      this.get("bridge-deep-model").value.trim() || this.get("bridge-model").value.trim()
    );
  },

  saveOutputFields() {
    this.bridge.setPref("vaultPath", this.get("bridge-vault-path").value.trim());
    this.bridge.setPref(
      "vocabularyFolder",
      this.get("bridge-vocabulary-folder").value.trim() || "Vocabulary"
    );
    this.bridge.setPref(
      "chatFolder",
      this.get("bridge-chat-folder").value.trim() || "Literature"
    );
    this.bridge.setPref("answerLanguage", this.get("bridge-answer-language").value);
    this.bridge.setPref("readingMode", this.get("bridge-reading-mode").value);
    this.bridge.setPref(
      "paperModelQuality",
      this.get("bridge-paper-model-quality").value === "fast" ? "fast" : "deep"
    );
  },

  async chooseVault() {
    try {
      const { FilePicker } = ChromeUtils.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs"
      );
      const picker = new FilePicker();
      picker.init(this.win, "选择 Obsidian Vault 根目录", picker.modeGetFolder);
      const result = await picker.show();
      const selectedPath = typeof picker.file === "string" ? picker.file : picker.file?.path;
      if (result === picker.returnOK && selectedPath) {
        this.get("bridge-vault-path").value = selectedPath;
        this.saveOutputFields();
        this.setStatus(`Vault 已选择：${selectedPath}`);
      }
    } catch (error) {
      Zotero.logError(error);
      this.setStatus(`无法打开目录选择器：${error.message}`, true);
    }
  },

  async saveAndTest() {
    const button = this.get("bridge-test");
    button.disabled = true;
    this.setStatus("正在保存并测试连接…");
    try {
      this.saveProviderFields();
      this.saveOutputFields();
      const provider = this.get("bridge-provider").value;
      await this.bridge.setAPIKey(provider, this.get("bridge-api-key").value.trim());
      const response = await this.bridge.testConnection();
      this.setStatus(`连接成功：${response.slice(0, 120)}`);
    } catch (error) {
      Zotero.logError(error);
      this.setStatus(`连接失败：${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }
};
