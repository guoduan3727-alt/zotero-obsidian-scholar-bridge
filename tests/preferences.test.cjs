const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element(value = "") {
  const listeners = new Map();
  return {
    value,
    textContent: "",
    disabled: false,
    style: {},
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    async dispatch(type) {
      return listeners.get(type)?.();
    }
  };
}

const elements = new Map([
  ["bridge-provider", element("openai")],
  ["bridge-base-url", element()],
  ["bridge-model", element()],
  ["bridge-deep-model", element()],
  ["bridge-api-key", element()],
  ["bridge-provider-preset", element()],
  ["bridge-vault-path", element()],
  ["bridge-vocabulary-folder", element()],
  ["bridge-chat-folder", element()],
  ["bridge-answer-language", element("zh-CN")],
  ["bridge-reading-mode", element("deep")],
  ["bridge-paper-model-quality", element("deep")],
  ["bridge-browse", element()],
  ["bridge-test", element()],
  ["bridge-status", element()]
]);

const stored = new Map();
const defaults = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
    deepModel: "gpt-5.6-sol"
  },
  deepseek: {
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    deepModel: "deepseek-v4-pro"
  },
  generic: {
    baseURL: "http://localhost:11434/v1",
    model: "",
    deepModel: ""
  }
};

const bridge = {
  pref(name, fallback) {
    return stored.has(name) ? stored.get(name) : fallback;
  },
  setPref(name, value) {
    stored.set(name, value);
  },
  getProviderDefaults(provider) {
    return { ...defaults[provider] };
  },
  async getAPIKey() {
    return "";
  },
  async setAPIKey() {},
  async testConnection() {
    return "OK";
  }
};

const fakeDocument = { getElementById: (id) => elements.get(id) };
const fakeWindow = { document: fakeDocument };
let pickerParent = null;
const context = {
  document: fakeDocument,
  Zotero: { ObsidianScholarBridge: bridge, logError() {} },
  ChromeUtils: {
    importESModule() {
      return {
        FilePicker: class {
          modeGetFolder = 2;
          returnOK = 0;
          file = "C:\\Research\\Vault";
          init(parent) {
            pickerParent = parent;
          }
          async show() {
            return this.returnOK;
          }
        }
      };
    }
  },
  console
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "chrome", "content", "scripts", "preferences.js"), "utf8"),
  context
);

(async () => {
  const prefs = context.ObsidianScholarBridgePrefs;
  await prefs.init(fakeWindow);
  assert.equal(elements.get("bridge-model").value, "gpt-5.6-luna");
  assert.equal(elements.get("bridge-paper-model-quality").value, "deep");

  elements.get("bridge-paper-model-quality").value = "fast";
  await elements.get("bridge-paper-model-quality").dispatch("change");
  assert.equal(stored.get("paperModelQuality"), "fast");

  elements.get("bridge-provider").value = "deepseek";
  await elements.get("bridge-provider").dispatch("change");
  assert.equal(stored.get("provider"), "deepseek");
  assert.equal(elements.get("bridge-base-url").value, "https://api.deepseek.com");
  assert.equal(elements.get("bridge-model").value, "deepseek-v4-flash");
  assert.equal(elements.get("bridge-deep-model").value, "deepseek-v4-pro");

  prefs.applyRecommendedProviderConfig();
  assert.equal(stored.get("deepseek.baseURL"), "https://api.deepseek.com");
  assert.equal(stored.get("deepseek.model"), "deepseek-v4-flash");
  assert.equal(stored.get("deepseek.deepModel"), "deepseek-v4-pro");
  assert.match(elements.get("bridge-status").textContent, /DeepSeek/);

  await prefs.chooseVault();
  assert.equal(pickerParent, fakeWindow);
  assert.equal(elements.get("bridge-vault-path").value, "C:\\Research\\Vault");
  assert.equal(stored.get("vaultPath"), "C:\\Research\\Vault");
  console.log("preferences provider switching tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
