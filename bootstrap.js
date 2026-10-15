var chromeHandle;

function install() {}

async function startup({ resourceURI, rootURI }) {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;

  rootURI ||= resourceURI.spec;
  const startupService = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = startupService.registerChrome(manifestURI, [
    ["content", "obsidian-scholar-bridge", rootURI + "chrome/content/"]
  ]);

  const context = { rootURI };
  context._globalThis = context;
  context.self = context;
  context.window = context;
  context.globalThis = context;
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/scripts/core.js",
    context
  );
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/vendor/katex/katex.min.js",
    context
  );
  context.ScholarBridgeKatex = context.katex?.default || context.katex;
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/scripts/scholarBridge.js",
    context
  );
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/scripts/preferences.js",
    context
  );

  Zotero.ObsidianScholarBridge = context.ObsidianScholarBridge;
  Zotero.ObsidianScholarBridgePrefs = context.ObsidianScholarBridgePrefs;
  await Zotero.ObsidianScholarBridge.startup();
}

async function onMainWindowLoad({ window }) {
  Zotero.ObsidianScholarBridge?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  Zotero.ObsidianScholarBridge?.onMainWindowUnload(window);
}

function shutdown(_data, reason) {
  if (reason === APP_SHUTDOWN) return;
  Zotero.ObsidianScholarBridge?.shutdown();
  delete Zotero.ObsidianScholarBridge;
  delete Zotero.ObsidianScholarBridgePrefs;
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}
