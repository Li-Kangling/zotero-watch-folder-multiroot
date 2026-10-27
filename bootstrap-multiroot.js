/** Independent local fork; upstream bootstrap/prefs and identity are not replaced. */
var multiRootChrome;
var multiRootAPI;
function install() {}
async function startup({ rootURI }, reason) {
  const service = Components.classes['@mozilla.org/addons/addon-manager-startup;1'].getService(Components.interfaces.amIAddonManagerStartup);
  multiRootChrome = service.registerChrome(Services.io.newURI(rootURI + 'manifest.json'), [
    ['content', 'zotero-watch-folder-multiroot', rootURI + 'content/'],
  ]);
  await Zotero.initializationPromise;
  const context = { Zotero, IOUtils, PathUtils, Services, Components, ChromeUtils, crypto, setTimeout, clearTimeout };
  Services.scriptloader.loadSubScript(rootURI + 'content/scripts/multiRoot.js', context);
  multiRootAPI = context._WatchFolderMultiRoot;
  Zotero.WatchFolderMultiRoot = multiRootAPI;
  multiRootAPI.hooks._rootURI = rootURI;
  try { await multiRootAPI.hooks.onStartup(); }
  catch (e) { Zotero.logError('[WatchFolder MultiRoot] 启动失败：' + e.stack); }
}
async function shutdown() {
  try { if (multiRootAPI) await multiRootAPI.hooks.onShutdown(); }
  finally {
    if (multiRootChrome) multiRootChrome.destruct();
    multiRootChrome = null;
    if (Zotero.WatchFolderMultiRoot === multiRootAPI) delete Zotero.WatchFolderMultiRoot;
    multiRootAPI = null;
  }
}
async function onMainWindowLoad() {}
async function onMainWindowUnload() {}
function uninstall() {}
