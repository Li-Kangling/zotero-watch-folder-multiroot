/** Multi-root configuration adapter. The upstream preference branch is untouched. */
export const HOST_PREFIX = 'extensions.zotero.watchFolderMultiRoot.';
export const CORE_PREFIX = 'extensions.zotero.watchFolder.';
export const ROOT_DEFAULTS = Object.freeze({
  pollInterval: 5, fileTypes: 'pdf', mode: 'mode3', autoRetrieveMetadata: true,
  metadataFallback: true, autoRename: false,
  renamePattern: '{firstCreator} - {year} - {title}', maxFilenameLength: 150,
  maxConcurrentMetadata: 2, adaptivePolling: true, smartRulesEnabled: false, smartRules: '[]',
  duplicateCheck: false, duplicateMatchDOI: true, duplicateMatchISBN: true,
  duplicateMatchTitle: true, duplicateTitleThreshold: 85, duplicateMatchHash: true,
  duplicateAction: 'import', pdfStorageStrategy: 'linked_watch_folder', importMode: 'linked',
  postImportAction: 'leave', localTrashFolderName: '.zotero-watch-trash',
  diskDeleteOnTrash: 'plugin_trash', diskDeleteSync: 'auto', scopeMode: 'collection',
  baselineCompletedForRoot: '', watchRootTopLevelFingerprint: '',
  mode3LibraryDeleteAcknowledged: false, multiRootMode: true, independentFiles: true,
});

/** Lexical comparison only; real roots are additionally checked through nsIFile. */
export function normalizedPath(path, windows = false) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('目录路径无效');
  let value = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!value) value = '/';
  if (value.split('/').some(p => p === '.' || p === '..')) throw new Error('目录不能包含 . 或 ..');
  return windows ? value.toLowerCase() : value;
}

export function isWithin(path, root, windows = false) {
  const p = normalizedPath(path, windows), r = normalizedPath(root, windows);
  return p === r || p.startsWith(r === '/' ? '/' : r + '/');
}

export function assertRootPath(path, roots, dataDir, windows = false, excludeID = '') {
  const n = normalizedPath(path, windows);
  if (!(n.startsWith('/') || /^[a-z]:\//i.test(n))) throw new Error('请选择绝对目录路径');
  if (n === '/' || /^[a-z]:$/i.test(n)) throw new Error('请勿监控整个磁盘');
  if (isWithin(path, dataDir, windows) || isWithin(dataDir, path, windows)) {
    throw new Error('监控目录不能与 Zotero 数据目录重叠');
  }
  for (const root of roots) {
    if (root.id === excludeID) continue;
    if (isWithin(path, root.path, windows) || isWithin(root.path, path, windows)) {
      throw new Error('监控目录重复或存在父子目录重叠：' + root.path);
    }
  }
}

export function relativeTo(path, root, windows = false) {
  if (!isWithin(path, root, windows)) return null;
  return path.replace(/\\/g, '/').replace(/\/+$/, '').slice(root.replace(/\\/g, '/').replace(/\/+$/, '').length).replace(/^\//, '');
}

export function rootBranch(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('监控标识无效');
  return HOST_PREFIX + 'roots.' + id + '.';
}

/** Translate all three preference operations, including observers, per root. */
export function createRootPrefs(host, root) {
  const branch = rootBranch(root.id);
  const map = name => name.startsWith(CORE_PREFIX) ? branch + name.slice(CORE_PREFIX.length) : name;
  return {
    get(name, global) {
      if (!name.startsWith(CORE_PREFIX)) return host.get(name, global);
      const key = name.slice(CORE_PREFIX.length);
      const fixed = {
        sourcePath: root.path, syncRootCollectionKey: root.collectionKey,
        syncRootLibraryID: root.libraryID, enabled: root.enabled, setupCompleted: true,
        trackingFileName: 'zotero-watch-folder-multiroot-' + root.id + '.json',
      };
      if (key in fixed) return fixed[key];
      // These bounds cannot be widened through a stale upstream dialog.
      if (['scopeMode', 'multiRootMode', 'independentFiles', 'postImportAction',
        'pdfStorageStrategy', 'importMode', 'diskDeleteOnTrash', 'diskDeleteSync', 'duplicateCheck'].includes(key)) return ROOT_DEFAULTS[key];
      const value = host.get(map(name), true);
      return value === undefined || value === null ? ROOT_DEFAULTS[key] : value;
    },
    set(name, value, global) {
      if (name.startsWith(CORE_PREFIX)) {
        const key = name.slice(CORE_PREFIX.length);
        if (['sourcePath', 'syncRootCollectionKey', 'syncRootLibraryID', 'enabled', 'setupCompleted',
          'trackingFileName', 'scopeMode', 'multiRootMode', 'independentFiles', 'postImportAction',
          'pdfStorageStrategy', 'importMode', 'diskDeleteOnTrash', 'diskDeleteSync', 'duplicateCheck'].includes(key)) {
          throw new Error('目录绑定和文件策略须通过多目录管理器修改');
        }
        return host.set(map(name), value, true);
      }
      return host.set(name, value, global);
    },
    registerObserver(name, callback, global) { return host.registerObserver(map(name), callback, name.startsWith(CORE_PREFIX) ? true : global); },
    unregisterObserver(id) { return host.unregisterObserver(id); },
  };
}
