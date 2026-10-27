/** Runs one unchanged upstream module graph per root; never switches global prefs. */
import { HOST_PREFIX, CORE_PREFIX, ROOT_DEFAULTS, assertRootPath, normalizedPath, isWithin, relativeTo, rootBranch, createRootPrefs } from './rootConfig.mjs';

const PLUGIN_ID = 'watch-folder-multiroot@local.zotero';
const CONFIG_VERSION = 1;
const MARKER = '.zotero-watch-root.json';
const OPTION_TYPES = {
  mode: ['mode1', 'mode2', 'mode3'], autoRetrieveMetadata: 'boolean', metadataFallback: 'boolean',
  autoRename: 'boolean', renamePattern: 'string', maxFilenameLength: [30, 240],
  pollInterval: [2, 3600], maxConcurrentMetadata: [1, 10], fileTypes: 'string',
  adaptivePolling: 'boolean', smartRulesEnabled: 'boolean', smartRules: 'json',
};

export class MultiRootManager {
  constructor({ zotero = Zotero, io = IOUtils, paths = PathUtils, services = Services, loadEngine = null } = {}) {
    this.zotero = zotero; this.io = io; this.paths = paths; this.services = services;
    this.roots = []; this.transfers = []; this.engines = new Map(); this.contexts = new Map();
    this.rootURI = ''; this._timer = null; this._queue = Promise.resolve();
    this._closed = false; this._notifier = null; this._promptOpen = false;
    this._loadEngine = loadEngine; this._mute = new Set(); this._errors = new Map();
    this._inventory = new Map();
    this._ownership = new Map();
  }

  _enqueue(fn) {
    const next = this._queue.catch(() => {}).then(fn);
    this._queue = next.catch(e => this.zotero.logError('[WatchFolder MultiRoot] ' + (e.stack || e)));
    return next;
  }

  _get(id) {
    const root = this.roots.find(r => r.id === id);
    if (!root) throw new Error('监控目录已解除绑定或不存在');
    return root;
  }

  async start(rootURI) {
    this.rootURI = rootURI;
    const raw = this.zotero.Prefs.get(HOST_PREFIX + 'config', true);
    if (raw) {
      const config = JSON.parse(raw);
      if (config.version !== CONFIG_VERSION || !Array.isArray(config.roots)) throw new Error('监控配置版本无效，已停止启动');
      const ids = new Set(), keys = new Set();
      this.transfers = config.transfers || [];
      for (const r of config.roots) {
        rootBranch(r.id);
        if (ids.has(r.id) || keys.has(r.collectionKey)) throw new Error('监控配置包含重复绑定，已停止启动');
        ids.add(r.id); keys.add(r.collectionKey);
        assertRootPath(r.path, this.roots, this.zotero.DataDirectory.dir, !!this.zotero.isWin);
        this.roots.push({ ...r, enabled: r.enabled === true, conflicts: r.conflicts || [], status: '等待检查' });
      }
    }
    for (const root of this.roots) await this._loadOwnership(root);
    this._notifier = this.zotero.Notifier.registerObserver({ notify: (event, type, ids, extra) => {
      if (type !== 'collection') return;
      this._enqueue(() => this._rootEvents(event, ids, extra || {}));
    } }, ['collection'], 'watchFolderMultiRoot-roots');
    await this.zotero.PreferencePanes.register({
      pluginID: PLUGIN_ID, src: rootURI + 'content/multiRootPreferences.xhtml',
      label: 'Watch Folder 多目录', image: rootURI + 'content/icons/watch-folder-16.png',
      scripts: [rootURI + 'content/multiRootPreferences.js'],
    });
    await this._enqueue(() => this._cycle());
    this._schedule();
  }

  _save() {
    this.zotero.Prefs.set(HOST_PREFIX + 'config', JSON.stringify({ version: CONFIG_VERSION,
      transfers: this.transfers,
      roots: this.roots.map(({ status, error, ...root }) => root) }), true);
  }

  listRoots() {
    return this.roots.map(r => ({ ...r, conflicts: r.conflicts.map(c => ({ ...c })),
      error: this._errors.get(r.id) || '', status: !r.enabled ? '已暂停' : r.status }));
  }

  async _validateDirectory(path, excludeID = '') {
    assertRootPath(path, this.roots, this.zotero.DataDirectory.dir, !!this.zotero.isWin, excludeID);
    const stat = await this.io.stat(path);
    if (stat.type !== 'directory') throw new Error('请选择文件夹');
    // Reject junction/symlink roots as well as the symlinks skipped by the upstream scanner.
    if (typeof Components !== 'undefined') {
      const file = Components.classes['@mozilla.org/file/local;1'].createInstance(Components.interfaces.nsIFile);
      file.initWithPath(path);
      if (file.isSymlink()) throw new Error('请选择实际文件夹，不要选择目录链接');
    }
    await this.io.getChildren(path); // permissions must be proven before registering
  }

  async _checkLegacyWatcher() {
    const enabled = this.zotero.Prefs.get(CORE_PREFIX + 'enabled', true) === true;
    const path = this.zotero.Prefs.get(CORE_PREFIX + 'sourcePath', true);
    if (!enabled || !path) return;
    if (typeof ChromeUtils !== 'undefined') {
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      const addon = await AddonManager.getAddonByID('watch-folder@zotero-plugin.org');
      if (!addon?.isActive) return;
    }
    throw new Error('原版 Watch Folder 仍在监控。请先停用原版监控，避免两个插件同时整理文库');
  }

  addDirectory(path) { return this._enqueue(async () => {
    await this._checkLegacyWatcher();
    await this._validateDirectory(path);
    const id = 'r' + crypto.randomUUID().replace(/-/g, '');
    const collection = new this.zotero.Collection();
    collection.libraryID = this.zotero.Libraries.userLibraryID;
    collection.name = this.paths.filename(path.replace(/[\\/]+$/, ''));
    await collection.saveTx(); // existing collections are never silently adopted
    const root = { id, path, name: collection.name, collectionKey: collection.key,
      libraryID: collection.libraryID, enabled: true, conflicts: [], status: '正在初始化' };
    this.roots.push(root); this._save();
    await this.io.writeJSON(this.paths.join(path, MARKER), { version: 1, id }, { tmpPath: this.paths.join(path, MARKER + '.tmp') });
    await this._cycle();
    return id;
  }); }

  setEnabled(id, enabled) { return this._enqueue(async () => {
    const root = this._get(id); root.enabled = !!enabled; this._save();
    if (!enabled) await this._stop(root);
    else await this._cycle();
  }); }

  detach(id) { return this._enqueue(async () => {
    const root = this._get(id);
    if (this.transfers.some(t => t.sourceID === id || t.targetID === id)) throw new Error('此目录有未完成迁移，请先解决迁移冲突并完成迁移，再解除绑定');
    root.enabled = false;
    await this._stop(root);
    this.roots = this.roots.filter(r => r.id !== id); this._errors.delete(id); this._save();
    for (const [key, owner] of this._ownership) if (owner === id) this._ownership.delete(key);
    // Intentionally retain the tracking JSON and per-root prefs for recovery.
  }); }

  reconnect(id, path) { return this._enqueue(async () => {
    const root = this._get(id);
    await this._validateDirectory(path, id);
    const col = await this._collection(root);
    if (!col || col.deleted) throw new Error('根分类已删除，请先从 Zotero 回收站恢复');
    const engine = await this._engine(root);
    const records = engine.store().getAllOfType('file').filter(r => r.state === 'clean');
    for (const rec of records) {
      const p = this._abs(path, rec.localPath);
      if (!await this.io.exists(p) || (rec.lastSyncedHash && await engine.getFileHash(p) !== rec.lastSyncedHash)) {
        throw new Error('新目录与原目录内容不符，请选择移动后的原目录；不自动合并陌生目录');
      }
    }
    const old = root.path;
    root.path = path; root.pendingRelink = old; this._rebaseRootState(old, path); this._save();
    await this.io.writeJSON(this.paths.join(path, MARKER), { version: 1, id }, { tmpPath: this.paths.join(path, MARKER + '.tmp') });
    await this._relinkAll(root, old);
    delete root.pendingRelink;
    this._mute.add(id);
    try { col.name = this.paths.filename(path); await col.saveTx(); root.name = col.name; }
    finally { this._mute.delete(id); }
    this._save(); await this._cycle();
  }); }

  getOptions(id) {
    const root = this._get(id), prefs = createRootPrefs(this.zotero.Prefs, root);
    return Object.fromEntries(Object.keys(OPTION_TYPES).map(k => [k, prefs.get(CORE_PREFIX + k, true)]));
  }

  _validateOption(key, value) {
    const type = OPTION_TYPES[key];
    if (!type) throw new Error('此设置由多目录管理器维护');
    if (Array.isArray(type)) {
      if (typeof type[0] === 'number') {
        if (!Number.isInteger(value) || value < type[0] || value > type[1]) throw new Error('数值超出范围');
      } else if (!type.includes(value)) throw new Error('选项无效');
    } else if (type === 'json') {
      if (typeof value !== 'string' || !Array.isArray(JSON.parse(value))) throw new Error('规则必须是 JSON 数组');
    } else if (typeof value !== type) throw new Error('设置类型无效');
    if (key === 'fileTypes' && !/^pdf$/i.test(value.trim())) throw new Error('本版本仅监控 PDF，避免把工程临时文件导入文库');
  }
  setOptions(id, values) { return this._enqueue(async () => {
    const root = this._get(id), entries = Object.entries(values);
    for (const [key, value] of entries) this._validateOption(key, value);
    const prefs = createRootPrefs(this.zotero.Prefs, root);
    const previous = entries.map(([key]) => [key, prefs.get(CORE_PREFIX + key, true)]);
    await this._stop(root);
    try { for (const [key, value] of entries) prefs.set(CORE_PREFIX + key, value, true); }
    catch (e) { for (const [key, value] of previous) prefs.set(CORE_PREFIX + key, value, true); throw e; }
    await this._cycle();
  }); }
  setOption(id, key, value) { return this.setOptions(id, { [key]: value }); }

  scanNow() { return this._enqueue(() => this._cycle()); }
  retrieveMetadata(id) { return this._enqueue(async () => {
    const root = this._get(id);
    if (!root.enabled) throw new Error('请先恢复监控');
    return (await this._engine(root)).service().backfillStandaloneMetadata();
  }); }
  checkAndRepair(id) { return this._enqueue(async () => {
    const root = this._get(id), engine = await this._engine(root);
    return engine.reconcile.detect(); // upstream detect is read-only; no speculative repair
  }); }

  _abs(rootPath, rel) {
    if (/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(rel || '')) return rel;
    return rel ? this.paths.join(rootPath, ...rel.split('/')) : rootPath;
  }
  async _collection(root) { return this.zotero.Collections.getByLibraryAndKeyAsync(root.libraryID, root.collectionKey); }
  _conflicted(root, path) {
    return root.conflicts.some(c => [c.oldPath, c.localPath, c.zoteroPath, c.stagingPath, c.backupPath, ...(c.candidatePaths || []), ...(c.sourcePaths || [])].filter(Boolean).some(p => isWithin(path, p, !!this.zotero.isWin)));
  }
  _conflictOverlap(root, path, ignoredIDs = []) {
    return root.conflicts.filter(c => !ignoredIDs.includes(c.id)).some(c => [c.oldPath, c.localPath, c.zoteroPath, c.stagingPath, c.backupPath, ...(c.candidatePaths || []), ...(c.sourcePaths || [])].filter(Boolean)
      .some(p => isWithin(path, p, !!this.zotero.isWin) || isWithin(p, path, !!this.zotero.isWin)));
  }
  async _loadOwnership(root) {
    const file = this.paths.join(this.zotero.DataDirectory.dir, 'zotero-watch-folder-multiroot-' + root.id + '.json');
    if (!await this.io.exists(file)) return;
    const data = await this.io.readJSON(file);
    if (data.version !== 2 || !Array.isArray(data.files) || !Array.isArray(data.collections)) throw new Error('目录跟踪记录损坏，已停止同步：' + root.name);
    for (const rec of data.files) if (rec.zoteroAttachmentKey) this._ownership.set(rec.zoteroAttachmentKey, root.id);
  }
  _refreshOwnership(root, engine) {
    for (const [key, id] of this._ownership) if (id === root.id) this._ownership.delete(key);
    for (const rec of engine.store().getAllOfType('file')) if (rec.zoteroAttachmentKey) this._ownership.set(rec.zoteroAttachmentKey, root.id);
  }

  async _engine(root) {
    if (this.engines.has(root.id)) return this.engines.get(root.id);
    const host = this.zotero, observerIDs = new Set();
    const overrides = {
      Prefs: createRootPrefs(host.Prefs, root),
      WatchFolderMultiRootOwnership: { isOwnedElsewhere: key => {
        const owner = this._ownership.get(key);
        if (owner && owner !== root.id && this.roots.some(r => r.id === owner)) return true;
        if ([...this.engines.entries()].some(([id, engine]) => id !== root.id && !!engine.store()?.getByAttachmentKey(key))) return true;
        const att = host.Items.getByLibraryAndKey?.(root.libraryID, key), p = att?.getFilePath?.();
        return typeof p === 'string' && this.roots.some(r => r.id !== root.id && isWithin(p, r.path, !!host.isWin));
      } },
      Notifier: Object.assign(Object.create(host.Notifier), {
        registerObserver: (observer, types, name, ...rest) => {
          const id = host.Notifier.registerObserver({ notify: (event, type, ids, extra) => {
            if (!root.enabled || this._closed || this._mute.has(root.id)) return;
            // Zotero 10 awaits observer promises. Returning our queue promise here
            // would deadlock saveTx inside the very operation owning that queue.
            this._enqueue(async () => {
              if (!root.enabled || this.contexts.get(root.id)?.context !== context || !await this._available(root)) return;
              if (type === 'collection-item' || type === 'collection') await this._transferZoteroMoves();
              await this._checkConflicts(root);
              const filtered = ids.filter(id => !this._blockedID(root, type, id, extra));
              if (filtered.length) await observer.notify(event, type, filtered, extra);
            });
          } }, types, name + '-' + root.id, ...rest);
          observerIDs.add(id); return id;
        },
        unregisterObserver: id => { observerIDs.delete(id); return host.Notifier.unregisterObserver(id); },
      }),
    };
    const facade = new Proxy(host, {
      get: (t, k) => k in overrides ? overrides[k] : Reflect.get(t, k, t),
      set: (t, k, value) => { overrides[k] = value; return true; },
    });
    const io = new Proxy(this.io, { get: (t, k) => {
      if (['move', 'copy', 'remove', 'writeJSON', 'writeUTF8', 'write', 'makeDirectory'].includes(k)) return async (...args) => {
        const paths = k === 'move' || k === 'copy' ? args.slice(0, 2) : args.slice(0, 1);
        if (paths.some(p => typeof p === 'string' && (['move', 'copy', 'remove'].includes(k) ? this._conflictOverlap(root, p) : this._conflicted(root, p)))) throw new Error('对象存在同步冲突，已阻止文件改动');
        return t[k](...args);
      };
      if (k === 'getChildren') return async path => {
        if (this._conflicted(root, path)) return [];
        return (await t.getChildren(path)).filter(p => !this._conflicted(root, p));
      };
      if (k === 'exists') return async path => {
        // Fail closed: a paused conflict subtree must never look deleted to the core.
        if (this._conflicted(root, path)) return true;
        return t.exists(path);
      };
      return Reflect.get(t, k, t);
    } });
    const context = { Zotero: facade, IOUtils: io, PathUtils: this.paths, Services: this.services,
      Components: typeof Components === 'undefined' ? undefined : Components,
      ChromeUtils: typeof ChromeUtils === 'undefined' ? undefined : ChromeUtils,
      crypto, setTimeout, clearTimeout, console: typeof console === 'undefined' ? undefined : console };
    context._globalThis = context;
    let engine;
    try {
      engine = this._loadEngine ? await this._loadEngine(context, root) : (() => {
        this.services.scriptloader.loadSubScript(this.rootURI + 'content/scripts/rootEngine.js', context);
        return context._WatchFolderRootEngine;
      })();
      this.engines.set(root.id, engine); this.contexts.set(root.id, { context, observerIDs });
      this._mute.add(root.id);
      try { await this._loadOwnership(root); await engine.initialize(); this._refreshOwnership(root, engine); }
      finally { this._mute.delete(root.id); }
      return engine;
    } catch (error) {
      for (const id of observerIDs) host.Notifier.unregisterObserver(id);
      this.engines.delete(root.id); this.contexts.delete(root.id);
      throw error;
    }
  }

  _blockedID(root, type, id, extra) {
    const engine = this.engines.get(root.id);
    if (!engine) return true;
    if (type === 'collection') {
      const key = this.zotero.Collections.get(id)?.key || extra?.[id]?.key;
      return key === root.collectionKey || this._blockedCollection(root, key);
    }
    if (type === 'collection-item') {
      const key = this.zotero.Collections.get(Number(String(id).split('-')[0]))?.key;
      return this._blockedCollection(root, key);
    }
    const item = this.zotero.Items.get(id);
    if (!item) return false;
    return engine.store().getAllOfType('file').some(r => (r.zoteroAttachmentKey === item.key || r.zoteroItemKey === item.key)
      && this._conflicted(root, this._abs(root.path, r.localPath)));
  }

  _blockedCollection(root, key) {
    const store = this.engines.get(root.id)?.store();
    let cursor = key;
    for (let i = 0; cursor && i < 1024; i++) {
      if (root.conflicts.some(c => c.collectionKey === cursor)) return true;
      const record = store?.getCollectionRecord(cursor);
      if (record && this._conflictOverlap(root, this._abs(root.path, record.localPath))) return true;
      const col = this.zotero.Collections.getByLibraryAndKey?.(root.libraryID, cursor);
      cursor = col?.parentID ? this.zotero.Collections.get(col.parentID)?.key : record?.parentCollectionKey;
    }
    return false;
  }

  async _available(root) {
    try {
      if ((await this.io.stat(root.path)).type !== 'directory') return false;
      await this.io.getChildren(root.path);
      return true;
    } catch (_) { root.status = '目录不可访问，已停止同步'; return false; }
  }

  async _stop(root) {
    const engine = this.engines.get(root.id), record = this.contexts.get(root.id);
    if (!engine) return;
    this._mute.add(root.id);
    try { await engine.shutdown(); }
    finally {
      for (const id of record?.observerIDs || []) this.zotero.Notifier.unregisterObserver(id);
      this.engines.delete(root.id); this.contexts.delete(root.id); this._mute.delete(root.id);
    }
  }

  async _cycle() {
    if (this._closed) return;
    await this._checkLegacyWatcher();
    const active = [];
    for (const root of this.roots) {
      if (!root.enabled) continue;
      try {
        if (!await this._available(root) && !await this._findRenamedRoot(root)) continue;
        const col = await this._collection(root);
        if (!col || col.deleted) { root.status = '根分类已删除，等待处理'; await this._trashRoot(root); continue; }
        if (root.conflicts.some(c => c.type === 'root')) { root.status = '根目录冲突，等待选择'; continue; }
        if (this.getOptions(root.id).mode !== 'mode1') await this._syncRootName(root, col);
        const engine = await this._engine(root);
        if (root.pendingRelink) { await this._relinkAll(root, root.pendingRelink); delete root.pendingRelink; this._save(); }
        this._inventory.set(root.id, await this._scanFiles(root.path));
        await this._checkConflicts(root);
        active.push({ root, engine, files: this._inventory.get(root.id).filter(f => !this._conflicted(root, f.path)) });
      } catch (e) { root.status = '同步受阻'; this._errors.set(root.id, e.message); }
    }
    // Crucial order: claim cross-root moves before ANY core may trash/import them.
    for (const tx of [...this.transfers]) {
      try { await this._finishTransfer(tx); }
      catch (e) { this._markTransferConflict(tx, e); }
    }
    await this._transferLocalDirectories(active);
    await this._transferZoteroMoves();
    await this._transferMoves(active);
    for (const { root, engine } of active) {
      try {
        await this._replayZoteroChanges(root, engine);
        if (this.getOptions(root.id).mode !== 'mode1') await engine.recoverStoredRestores?.();
        await engine.activate(); await engine.scan();
        this._refreshOwnership(root, engine);
        root.status = root.conflicts.length ? '部分对象有冲突，其余正常同步' : '正在监控';
        this._errors.delete(root.id);
      } catch (e) { root.status = '同步受阻'; this._errors.set(root.id, e.message); }
    }
    this._save();
  }

  async _replayZoteroChanges(root, engine) {
    if (this.getOptions(root.id).mode === 'mode1') return;
    const executor = engine.mirrorExecutor;
    if (!executor) return;
    for (const rec of [...engine.store().getAllOfType('collection')]) {
      if (!rec.localPath || this._conflictOverlap(root, this._abs(root.path, rec.localPath))) continue;
      const col = await this.zotero.Collections.getByLibraryAndKeyAsync(root.libraryID, rec.zoteroCollectionKey);
      if (!col || col.deleted) {
        if (this.getOptions(root.id).mode === 'mode3' && rec.state === 'clean') await executor.execute({ type: 'zoteroCollectionDeleted',
          payload: { collectionKey: rec.zoteroCollectionKey, oldRelativePath: rec.localPath } });
        continue;
      }
      const desired = await engine.canonicalPath.collectionKeyToDiskRelativePath(col.key);
      if (desired && desired !== rec.localPath && await this.io.exists(this._abs(root.path, rec.localPath))) {
        await executor.execute({ type: 'moveFolder', payload: { collectionKey: col.key, oldRelativePath: rec.localPath,
          newRelativePath: desired, newName: col.name, newParentCollectionKey: col.parentID ? this.zotero.Collections.get(col.parentID)?.key : root.collectionKey } });
      }
    }
    const trashedIDs = new Set();
    for (const rec of engine.store().getAllOfType('file')) {
      if (rec.state !== 'clean' || this._conflicted(root, this._abs(root.path, rec.localPath))) continue;
      const att = await this.zotero.Items.getByLibraryAndKeyAsync(root.libraryID, rec.zoteroAttachmentKey);
      // RecognizeDocument or a manual reparent may have changed the owner while
      // this root was paused. The live attachment relation outranks old tracking.
      const parent = att?.parentItem || (rec.zoteroItemKey && rec.zoteroItemKey !== rec.zoteroAttachmentKey
        ? await this.zotero.Items.getByLibraryAndKeyAsync(root.libraryID, rec.zoteroItemKey) : null);
      if (parent?.key && parent.key !== rec.zoteroItemKey) engine.store().update(rec.localPath, { zoteroItemKey: parent.key });
      if (parent?.deleted) trashedIDs.add(parent.id);
      else if (att?.deleted) trashedIDs.add(att.id);
      else if (att && !att.deleted) {
        const owner = att.parentItem || parent || att;
        const canonical = await engine.canonicalPath.chooseCanonicalCollection?.(owner, await this._collection(root), { existingTrackingRecord: rec });
        if (canonical?.key && canonical.key !== rec.canonicalCollectionKey) {
          const rel = await engine.canonicalPath.collectionKeyToDiskRelativePath(canonical.key);
          if (rel !== null) await executor.execute({ type: 'moveItem', payload: {
            attachmentKey: rec.zoteroAttachmentKey, oldCanonicalPath: rec.canonicalLocalPath || rec.localPath,
            newCanonicalPath: (rel ? rel + '/' : '') + rec.localPath.replace(/\\/g, '/').split('/').pop(), newCanonicalCollectionKey: canonical.key,
          } });
        }
      }
    }
    if (trashedIDs.size && this.getOptions(root.id).mode === 'mode3') await engine.service()._handleZoteroTrash([...trashedIDs]);
  }

  async _transferZoteroMoves() {
    await this._transferDirectories();
    for (const source of this.roots.filter(r => r.enabled && this.getOptions(r.id).mode !== 'mode1')) {
      const engine = this.engines.get(source.id);
      if (!engine || !await this._available(source)) continue;
      for (const rec of engine.store().getAllOfType('file')) {
        if (!['clean', 'out-of-scope-suppressed'].includes(rec.state) || this._conflicted(source, this._abs(source.path, rec.localPath))) continue;
        if (this.transfers.some(t => t.record?.zoteroAttachmentKey === rec.zoteroAttachmentKey || t.files?.some(f => f.zoteroAttachmentKey === rec.zoteroAttachmentKey))) continue;
        const att = await this.zotero.Items.getByLibraryAndKeyAsync(source.libraryID, rec.zoteroAttachmentKey);
        if (!att || att.deleted) continue;
        const owner = att.parentItem || att;
        if (!engine.canonicalPath.chooseCanonicalCollection) continue;
        if (await engine.canonicalPath.chooseCanonicalCollection(owner, await this._collection(source), { existingTrackingRecord: rec })) continue;
        const targets = [];
        for (const target of this.roots.filter(r => r.id !== source.id && r.enabled && this.getOptions(r.id).mode !== 'mode1')) {
          const targetEngine = this.engines.get(target.id);
          if (!targetEngine || !await this._available(target)) continue;
          const col = await targetEngine.canonicalPath.chooseCanonicalCollection(owner, await this._collection(target), {});
          if (col) targets.push({ target, targetEngine, col });
        }
        if (targets.length !== 1) continue;
        const { target, targetEngine, col } = targets[0];
        const relDir = await targetEngine.canonicalPath.collectionKeyToDiskRelativePath(col.key);
        if (relDir === null) continue;
        const rel = (relDir ? relDir + '/' : '') + rec.localPath.replace(/\\/g, '/').split('/').pop();
        const tx = { id: 't' + crypto.randomUUID().replace(/-/g, ''), sourceID: source.id, targetID: target.id,
          record: { ...rec, state: 'clean' }, sourcePath: this._abs(source.path, rec.localPath),
          targetPath: this._abs(target.path, rel), targetRelativePath: rel, collectionKey: col.key, diskMovePending: true };
        this.transfers.push(tx); this._save();
        try { await this._finishTransfer(tx); }
        catch (e) { this._markTransferConflict(tx, e); }
      }
    }
  }

  _schedule() {
    if (this._closed) return;
    this._timer = setTimeout(async () => {
      try { await this.scanNow(); }
      catch (e) { this.zotero.logError(e); }
      this._schedule();
    }, Math.min(...this.roots.filter(r => r.enabled).map(r => {
      const options = this.getOptions(r.id);
      return options.adaptivePolling ? (this.engines.get(r.id)?.service()._currentInterval || options.pollInterval * 1000) : options.pollInterval * 1000;
    }), this.roots.some(r => r.enabled) ? Infinity : 5000));
  }

  async _scanFiles(path, depth = 10) {
    const files = [];
    if (depth < 0) return files;
    for (const child of await this.io.getChildren(path)) {
      const name = this.paths.filename(child);
      if (name.startsWith('.') || ['node_modules', 'imported'].includes(name)) continue;
      if (typeof Components !== 'undefined') {
        const file = Components.classes['@mozilla.org/file/local;1'].createInstance(Components.interfaces.nsIFile);
        file.initWithPath(child); if (file.isSymlink()) continue;
      }
      const stat = await this.io.stat(child);
      if (stat.type === 'directory') files.push(...await this._scanFiles(child, depth - 1));
      else if (/\.pdf$/i.test(name)) files.push({ path: child });
    }
    return files;
  }

  async _transferMoves(active) {
    const missing = [], candidates = [], hashes = new Map();
    for (const entry of active) {
      const store = entry.engine.store();
      for (const rec of store.getAllOfType('file')) {
        const abs = this._abs(entry.root.path, rec.localPath);
        if (rec.state === 'clean' && rec.lastSyncedHash && !this._conflicted(entry.root, abs) && !await this.io.exists(abs)) missing.push({ ...entry, rec, abs });
      }
      for (const f of entry.files) {
        const rel = relativeTo(f.path, entry.root.path, !!this.zotero.isWin);
        if (!store.hasPath(rel) && !store.hasPath(f.path) && !this._conflicted(entry.root, f.path)) candidates.push({ ...entry, path: f.path, rel });
      }
    }
    for (const c of candidates) hashes.set(c.path, await c.engine.getFileHash(c.path));
    for (const src of missing) {
      const matches = candidates.filter(c => c.root.id !== src.root.id && hashes.get(c.path) === src.rec.lastSyncedHash);
      const sources = missing.filter(s => s.rec.lastSyncedHash === src.rec.lastSyncedHash);
      if (!matches.length) continue;
      if (matches.length !== 1 || sources.length !== 1) {
        this._markAmbiguousMove(src, matches); continue;
      }
      const dest = matches[0];
      const attachment = await this.zotero.Items.getByLibraryAndKeyAsync(src.root.libraryID, src.rec.zoteroAttachmentKey);
      if (!attachment || attachment.deleted || !attachment.isLinkedFileAttachment?.()) continue;
      const col = await dest.engine.canonicalPath.relativePathToCollection(dest.rel.split('/').slice(0, -1).join('/'), { createIfMissing: true });
      if (!col) continue;
      const owner = attachment.parentItem || attachment;
      const tx = { id: 't' + crypto.randomUUID().replace(/-/g, ''), sourceID: src.root.id, targetID: dest.root.id,
        record: { ...src.rec }, sourcePath: src.abs, targetPath: dest.path, targetRelativePath: dest.rel, collectionKey: col.key };
      this.transfers.push(tx); this._save(); // durable intent BEFORE changing the attachment
      try { await this._finishTransfer(tx); }
      catch (e) { this._markTransferConflict(tx, e); }
      candidates.splice(candidates.indexOf(dest), 1);
    }
  }

  _markAmbiguousMove(src, matches) {
    const id = 'a' + crypto.randomUUID().replace(/-/g, '');
    const conflict = { id, type: 'ambiguousMove', sourceID: src.root.id,
      record: { ...src.rec }, oldPath: src.abs, candidatePaths: matches.map(c => c.path),
      targetIDs: matches.map(c => c.root.id),
      message: '多个同内容文件的位置变化无法唯一匹配，请指定原附件的迁移目标，或确认按独立文件处理：' + src.rec.localPath };
    if (src.root.conflicts.some(c => c.type === 'ambiguousMove' && c.record?.zoteroAttachmentKey === src.rec.zoteroAttachmentKey)) return;
    for (const root of new Set([src.root, ...matches.map(c => c.root)])) root.conflicts.push({ ...conflict });
    this._save();
  }

  _markTransferConflict(tx, error) {
    for (const id of [tx.sourceID, tx.targetID]) {
      const root = this.roots.find(r => r.id === id);
      if (!root) continue;
      if (!root.conflicts.some(c => c.id === tx.id)) root.conflicts.push({ id: tx.id, type: 'transfer',
        oldPath: tx.sourcePath, localPath: tx.targetPath, stagingPath: tx.stagingPath, backupPath: tx.backupPath,
        message: '跨目录迁移未完成，已保护原附件；检查目标文件后可重试：' + error.message });
    }
    this._save();
  }

  async _directoryCandidates(root, depth = 0) {
    if (depth > 256) throw new Error('目录层级过深');
    const found = [];
    for (const child of await this.io.getChildren(root)) {
      const name = this.paths.filename(child);
      if (name.startsWith('.') || ['node_modules', 'imported'].includes(name)) continue;
      if ((await this.io.stat(child)).type !== 'directory') continue;
      found.push(child, ...await this._directoryCandidates(child, depth + 1));
    }
    return found;
  }

  async _matchesDirectoryDestination(engine, rec, candidate, destinationEngine) {
    const under = p => p === rec.localPath || p.startsWith(rec.localPath + '/');
    const files = engine.store().getAllOfType('file').filter(r => under(r.localPath));
    if (files.some(r => r.state !== 'clean' || !r.lastSyncedHash)) return false;
    if (files.length) {
      for (const f of files) {
        const p = this._abs(candidate, f.localPath.slice(rec.localPath.length + 1));
        if (!await this.io.exists(p) || await destinationEngine.getFileHash(p) !== f.lastSyncedHash) return false;
      }
      return true;
    }
    const cols = engine.store().getAllOfType('collection').filter(r => under(r.localPath));
    const tree = await this._snapshotTree(candidate, destinationEngine);
    const expected = cols.map(c => c.localPath.slice(rec.localPath.length).replace(/^\//, '')).sort();
    return !tree.some(e => e.type !== 'directory') && JSON.stringify(tree.map(e => e.path).sort()) === JSON.stringify(expected);
  }

  async _transferLocalDirectories(active) {
    for (const { root: source, engine } of active) {
      const records = [...engine.store().getAllOfType('collection')].filter(r => r.localPath).sort((a, b) => a.localPath.length - b.localPath.length);
      for (const rec of records) {
        const sourcePath = this._abs(source.path, rec.localPath);
        if (!engine.store().getCollectionRecord(rec.zoteroCollectionKey) || await this.io.exists(sourcePath) || this._conflictOverlap(source, sourcePath)) continue;
        const under = p => p === rec.localPath || p.startsWith(rec.localPath + '/');
        const files = engine.store().getAllOfType('file').filter(r => under(r.localPath));
        const cols = engine.store().getAllOfType('collection').filter(r => under(r.localPath));
        if (files.some(r => r.state !== 'clean' || !r.lastSyncedHash)) continue;
        const candidates = [];
        for (const { root: target, engine: dest } of active.filter(e => e.root.id !== source.id && e.root.libraryID === source.libraryID)) {
          for (const candidate of await this._directoryCandidates(target.path)) {
            if (this._conflictOverlap(target, candidate)) continue;
            const rel = relativeTo(candidate, target.path, !!this.zotero.isWin);
            if (dest.store().getAllOfType('collection').some(r => r.localPath === rel || r.localPath.startsWith(rel + '/'))
              || dest.store().getAllOfType('file').some(r => r.localPath === rel || r.localPath.startsWith(rel + '/'))) continue;
            if (!await this._matchesDirectoryDestination(engine, rec, candidate, dest)) continue;
            candidates.push({ target, path: candidate, rel });
          }
        }
        if (!candidates.length) continue;
        const competingSources = [];
        for (const { root: other, engine: otherEngine } of active) {
          for (const otherRecord of otherEngine.store().getAllOfType('collection')) {
            if (!otherRecord.localPath || otherRecord.zoteroCollectionKey === rec.zoteroCollectionKey) continue;
            const old = this._abs(other.path, otherRecord.localPath);
            if (await this.io.exists(old)) continue;
            for (const candidate of candidates) {
              if (candidate.target.id === other.id) continue;
              const dest = this.engines.get(candidate.target.id);
              if (await this._matchesDirectoryDestination(otherEngine, otherRecord, candidate.path, dest)) {
                competingSources.push({ root: other, path: old }); break;
              }
            }
          }
        }
        if (candidates.length !== 1 || competingSources.length) {
          const id = 'c' + crypto.randomUUID().replace(/-/g, '');
          const conflict = { id, type: 'ambiguousDirectoryMove', sourceID: source.id, collectionKey: rec.zoteroCollectionKey,
            oldPath: sourcePath, oldRelativePath: rec.localPath, candidatePaths: candidates.map(c => c.path), sourcePaths: competingSources.map(s => s.path),
            message: '目录移动存在多个同内容目标，请选择原目录的新位置：' + rec.localPath };
          for (const root of new Set([source, ...candidates.map(c => c.target), ...competingSources.map(s => s.root)])) root.conflicts.push({ ...conflict });
          this._save(); continue;
        }
        try { await this._claimLocalDirectory(source, engine, rec, candidates[0]); }
        catch (error) { this.zotero.logError(error); }
      }
    }
  }

  async _claimLocalDirectory(source, engine, rec, candidate) {
    const { target, path, rel } = candidate;
    const under = p => p === rec.localPath || p.startsWith(rec.localPath + '/');
    const dest = await this._engine(target);
    const parentRel = rel.split('/').slice(0, -1).join('/');
    const parent = await dest.canonicalPath.relativePathToCollection(parentRel, { createIfMissing: true });
    if (!parent?.key) throw new Error('无法定位目标父分类');
    const tx = { id: 't' + crypto.randomUUID().replace(/-/g, ''), kind: 'directory', sourceID: source.id, targetID: target.id,
      collectionKey: rec.zoteroCollectionKey, sourceRelativePath: rec.localPath, targetRelativePath: rel,
      sourcePath: this._abs(source.path, rec.localPath), targetPath: path, diskMovePending: false,
      localCollectionMovePending: true, parentCollectionKey: parent.key, newName: this.paths.filename(path), resolvesConflictID: candidate.resolvesConflictID,
      collections: engine.store().getAllOfType('collection').filter(r => under(r.localPath)).map(r => ({ ...r })),
      files: engine.store().getAllOfType('file').filter(r => under(r.localPath)).map(r => ({ ...r })),
      diskEntries: await this._snapshotTree(path, dest) };
    for (const f of tx.files) {
      const entry = tx.diskEntries.find(e => e.path === f.localPath.slice(rec.localPath.length + 1));
      if (!f.lastSyncedHash || entry?.hash !== f.lastSyncedHash) throw new Error('本地迁移目标内容已改变');
    }
    this.transfers.push(tx); this._save();
    try { await this._finishTransfer(tx); } catch (error) { this._markTransferConflict(tx, error); }
  }

  // A collection crossing a root boundary owns its complete subtree, including empty folders.
  async _transferDirectories() {
    for (const source of this.roots.filter(r => r.enabled && this.getOptions(r.id).mode !== 'mode1')) {
      const engine = this.engines.get(source.id);
      if (!engine || !await this._available(source)) continue;
      const records = [...engine.store().getAllOfType('collection')].filter(r => r.localPath).sort((a, b) => a.localPath.length - b.localPath.length);
      for (const rec of records) {
        if (!engine.store().getCollectionRecord(rec.zoteroCollectionKey) || this._conflictOverlap(source, this._abs(source.path, rec.localPath))) continue;
        if (this.transfers.some(t => t.collectionKey === rec.zoteroCollectionKey)) continue;
        if (await engine.canonicalPath.collectionKeyToDiskRelativePath(rec.zoteroCollectionKey) !== null) continue;
        const destinations = [];
        for (const target of this.roots.filter(r => r.id !== source.id && r.enabled && r.libraryID === source.libraryID && this.getOptions(r.id).mode !== 'mode1')) {
          const dest = this.engines.get(target.id);
          if (!dest || !await this._available(target)) continue;
          const rel = await dest.canonicalPath.collectionKeyToDiskRelativePath(rec.zoteroCollectionKey);
          if (rel) destinations.push({ target, rel });
        }
        if (destinations.length !== 1) continue;
        const { target, rel } = destinations[0];
        if (this._conflictOverlap(target, this._abs(target.path, rel))) continue;
        const under = p => p === rec.localPath || p.startsWith(rec.localPath + '/');
        const tx = { id: 't' + crypto.randomUUID().replace(/-/g, ''), kind: 'directory', sourceID: source.id, targetID: target.id,
          collectionKey: rec.zoteroCollectionKey, sourceRelativePath: rec.localPath, targetRelativePath: rel,
          sourcePath: this._abs(source.path, rec.localPath), targetPath: this._abs(target.path, rel), diskMovePending: true,
          collections: engine.store().getAllOfType('collection').filter(r => under(r.localPath)).map(r => ({ ...r })),
          files: engine.store().getAllOfType('file').filter(r => under(r.localPath)).map(r => ({ ...r })) };
        this.transfers.push(tx); this._save();
        try { await this._finishTransfer(tx); } catch (error) { this._markTransferConflict(tx, error); }
      }
    }
  }

  async _snapshotTree(path, engine) {
    const entries = [];
    const walk = async (p, rel, depth = 0) => {
      if (depth > 256) throw new Error('目录层级过深，已暂停迁移');
      if (typeof Components !== 'undefined') {
        const file = Components.classes['@mozilla.org/file/local;1'].createInstance(Components.interfaces.nsIFile);
        file.initWithPath(p);
        if (file.isSymlink?.()) throw new Error('目录含符号链接，已暂停迁移');
      }
      const st = await this.io.stat(p);
      if (st.type === 'directory') {
        entries.push({ path: rel, type: 'directory' });
        for (const child of (await this.io.getChildren(p)).sort()) await walk(child, rel ? rel + '/' + this.paths.filename(child) : this.paths.filename(child), depth + 1);
      } else if (st.type === 'regular') {
        const hash = await engine.getFileHash(p);
        if (!hash) throw new Error('无法验证文件内容，已暂停迁移');
        entries.push({ path: rel, type: 'regular', hash });
      }
      else throw new Error('目录含不支持的文件类型，已暂停迁移');
    };
    await walk(path, '');
    return entries;
  }

  async _verifyTransferTree(path, entries, engine) {
    const actual = await this._snapshotTree(path, engine);
    if (JSON.stringify(actual) !== JSON.stringify(entries)) throw new Error('迁移文件清单或内容发生变化，已保留源文件');
  }

  async _moveTransferDisk(tx, engine) {
    if (!tx.diskEntries) {
      if (await this.io.exists(tx.targetPath)) throw new Error('目标已有同名对象，不能覆盖');
      const entries = await this._snapshotTree(tx.sourcePath, engine);
      if (tx.kind !== 'directory' && (entries.length !== 1 || entries[0].hash !== tx.record.lastSyncedHash)) throw new Error('本地内容已改变，暂停移动');
      for (const rec of tx.files || []) {
        const rel = rec.localPath.slice(tx.sourceRelativePath.length + 1);
        const entry = entries.find(e => e.path === rel);
        if (!rec.lastSyncedHash || entry?.hash !== rec.lastSyncedHash) throw new Error('目录中的受管文件已改变，暂停移动');
      }
      tx.diskEntries = entries;
      const targetRoot = this._get(tx.targetID), sourceRoot = this._get(tx.sourceID);
      tx.stagingPath = this.paths.join(targetRoot.path, '.zotero-watch-trash', 'transfers', tx.id + '-' + this.paths.filename(tx.targetPath));
      tx.backupPath = this.paths.join(sourceRoot.path, '.zotero-watch-trash', 'transfers', tx.id + '-' + this.paths.filename(tx.sourcePath));
      this._save();
    }
    await this.io.makeDirectory(this.paths.parent(tx.targetPath), { ignoreExisting: true, createAncestors: true });
    const sourceExists = await this.io.exists(tx.sourcePath);
    if (await this.io.exists(tx.targetPath)) {
      // Only our persisted publish intent permits recovery of an existing destination.
      if (!tx.publishPending) throw new Error('目标已有同名对象，不能覆盖');
      await this._verifyTransferTree(tx.targetPath, tx.diskEntries, engine);
    } else {
      if (!sourceExists) throw new Error('迁移源和目标均不存在');
      await this._verifyTransferTree(tx.sourcePath, tx.diskEntries, engine);
      if (!tx.copyStarted) {
        try {
          tx.publishPending = true; this._save();
          await this.io.move(tx.sourcePath, tx.targetPath, { noOverwrite: true });
        } catch (error) {
          // A cross-device rename can fail. Never remove the source until a verified copy is published.
          if (await this.io.exists(tx.targetPath)) { tx.publishPending = false; this._save(); throw error; }
          tx.publishPending = false; tx.copyStarted = true; this._save();
        }
      }
      if (!await this.io.exists(tx.targetPath)) {
        await this.io.makeDirectory(this.paths.parent(tx.stagingPath), { ignoreExisting: true, createAncestors: true });
        for (const entry of tx.diskEntries) {
          const dst = entry.path ? this._abs(tx.stagingPath, entry.path) : tx.stagingPath;
          if (entry.type === 'directory') await this.io.makeDirectory(dst, { ignoreExisting: true, createAncestors: true });
          else if (await this.io.exists(dst)) {
            if (await engine.getFileHash(dst) !== entry.hash) throw new Error('暂存副本内容不符，已保留源文件');
          } else await this.io.copy(entry.path ? this._abs(tx.sourcePath, entry.path) : tx.sourcePath, dst, { noOverwrite: true });
        }
        await this._verifyTransferTree(tx.stagingPath, tx.diskEntries, engine);
        await this._verifyTransferTree(tx.sourcePath, tx.diskEntries, engine);
        tx.publishPending = true; this._save();
        await this.io.move(tx.stagingPath, tx.targetPath, { noOverwrite: true });
      }
      await this._verifyTransferTree(tx.targetPath, tx.diskEntries, engine);
    }
    if (await this.io.exists(tx.sourcePath)) {
      await this._verifyTransferTree(tx.sourcePath, tx.diskEntries, engine);
      await this.io.makeDirectory(this.paths.parent(tx.backupPath), { ignoreExisting: true, createAncestors: true });
      // Same-volume rename retains a recoverable source copy. A concurrent writer
      // can change the moved bytes, so verify again and fail closed without erasing.
      await this.io.move(tx.sourcePath, tx.backupPath, { noOverwrite: true });
    }
    if (await this.io.exists(tx.backupPath)) await this._verifyTransferTree(tx.backupPath, tx.diskEntries, engine);
  }

  async _finishDirectoryTransfer(tx, source, target, srcEngine, destEngine) {
    if (!tx.localCollectionMovePending) {
      const desired = await destEngine.canonicalPath.collectionKeyToDiskRelativePath(tx.collectionKey);
      if (desired !== tx.targetRelativePath) throw new Error('分类目标再次变化，暂停原迁移');
    }
    if (tx.diskMovePending) await this._moveTransferDisk(tx, srcEngine);
    tx.diskMovePending = false; this._save();
    await this._verifyTransferTree(tx.targetPath, tx.diskEntries, destEngine);
    if (await this.io.exists(tx.sourcePath)) throw new Error('源目录仍存在，暂停迁移');
    const rebase = p => tx.targetRelativePath + p.slice(tx.sourceRelativePath.length);
    this._mute.add(source.id); this._mute.add(target.id);
    try {
      if (tx.localCollectionMovePending) {
        const col = await this.zotero.Collections.getByLibraryAndKeyAsync(source.libraryID, tx.collectionKey);
        const parent = await this.zotero.Collections.getByLibraryAndKeyAsync(target.libraryID, tx.parentCollectionKey);
        if (!col || col.deleted || !parent || parent.deleted) throw new Error('迁移分类不可用');
        col.parentID = parent.id; col.name = tx.newName; await col.saveTx();
        tx.localCollectionMovePending = false; this._save();
      }
      for (const rec of tx.files) {
        const att = await this.zotero.Items.getByLibraryAndKeyAsync(source.libraryID, rec.zoteroAttachmentKey);
        if (!att || att.deleted || !att.isLinkedFileAttachment?.()) throw new Error('原附件不可用');
        const rel = rebase(rec.localPath);
        await att.relinkAttachmentFile(this._abs(target.path, rel));
        destEngine.store().add(destEngine.createFileRecord({ ...rec, localPath: rel, canonicalLocalPath: rel }));
      }
      for (const rec of tx.collections) {
        const col = await this.zotero.Collections.getByLibraryAndKeyAsync(target.libraryID, rec.zoteroCollectionKey);
        if (!col || col.deleted) throw new Error('迁移分类不可用');
        destEngine.store().add(destEngine.createCollectionRecord({ ...rec, localPath: rebase(rec.localPath),
          parentCollectionKey: col.parentID ? this.zotero.Collections.get(col.parentID)?.key : target.collectionKey }));
      }
      await destEngine.store().flush();
      for (const rec of tx.files) srcEngine.store().remove(rec.localPath);
      for (const rec of tx.collections) srcEngine.store().removeCollectionRecord(rec.zoteroCollectionKey);
      await srcEngine.store().flush();
      for (const rec of tx.files) this._ownership.set(rec.zoteroAttachmentKey, target.id);
      this.transfers = this.transfers.filter(t => t.id !== tx.id);
      for (const root of [source, target]) root.conflicts = root.conflicts.filter(c => c.id !== tx.id);
      this._save();
    } finally { this._mute.delete(source.id); this._mute.delete(target.id); }
  }

  async _finishTransfer(tx) {
      const source = this._get(tx.sourceID), target = this._get(tx.targetID);
      if (!source.enabled || !target.enabled) throw new Error('迁移涉及的目录已暂停');
      const ignored = [tx.id, tx.resolvesConflictID].filter(Boolean);
      if (this._conflictOverlap(source, tx.sourcePath, ignored) || this._conflictOverlap(target, tx.targetPath, ignored)) throw new Error('迁移对象存在其他同步冲突，已停止迁移');
      const srcEngine = await this._engine(source), destEngine = await this._engine(target);
      if (!await this._available(source) || !await this._available(target)) throw new Error('迁移涉及的目录不可访问');
      if (tx.kind === 'directory') return this._finishDirectoryTransfer(tx, source, target, srcEngine, destEngine);
      if (tx.diskMovePending) await this._moveTransferDisk(tx, srcEngine);
      tx.diskMovePending = false; this._save();
      if (await this.io.exists(tx.sourcePath) || !await this.io.exists(tx.targetPath)
        || await destEngine.getFileHash(tx.targetPath) !== tx.record.lastSyncedHash) throw new Error('文件位置或内容与迁移记录不符');
      const attachment = await this.zotero.Items.getByLibraryAndKeyAsync(source.libraryID, tx.record.zoteroAttachmentKey);
      if (!attachment || attachment.deleted || !attachment.isLinkedFileAttachment?.()) throw new Error('原附件不可用');
      const col = await this.zotero.Collections.getByLibraryAndKeyAsync(target.libraryID, tx.collectionKey);
      if (!col || col.deleted) throw new Error('目标分类不可用');
      const owner = attachment.parentItem || attachment;
      this._mute.add(source.id); this._mute.add(target.id);
      try {
        await attachment.relinkAttachmentFile(tx.targetPath);
        if (tx.record.canonicalCollectionKey) {
          const old = await this.zotero.Collections.getByLibraryAndKeyAsync(source.libraryID, tx.record.canonicalCollectionKey);
          const siblingRemains = srcEngine.store().getAllOfType('file').some(r => r.zoteroAttachmentKey !== tx.record.zoteroAttachmentKey
            && r.zoteroItemKey === tx.record.zoteroItemKey && r.canonicalCollectionKey === tx.record.canonicalCollectionKey);
          if (old && !siblingRemains) owner.removeFromCollection(old.id);
        }
        owner.addToCollection(col.id); await owner.saveTx();
        destEngine.store().add(destEngine.createFileRecord({ ...tx.record, localPath: tx.targetRelativePath,
          canonicalLocalPath: tx.targetRelativePath, canonicalCollectionKey: col.key, collectionMembershipKeys: [col.key] }));
        await destEngine.store().flush();
        srcEngine.store().remove(tx.record.localPath); await srcEngine.store().flush();
        this._ownership.set(tx.record.zoteroAttachmentKey, target.id);
        this.transfers = this.transfers.filter(t => t.id !== tx.id);
        for (const r of [source, target]) r.conflicts = r.conflicts.filter(c => c.id !== tx.id);
        this._save();
      } finally { this._mute.delete(source.id); this._mute.delete(target.id); }
  }

  async _checkConflicts(root) {
    const engine = this.engines.get(root.id);
    if (!engine) return;
    for (const rec of engine.store().getAllOfType('collection')) {
      if (!rec.localPath || root.conflicts.some(c => c.collectionKey === rec.zoteroCollectionKey)) continue;
      const desired = await engine.canonicalPath.collectionKeyToDiskRelativePath(rec.zoteroCollectionKey);
      if (desired === null || desired === rec.localPath) continue;
      const oldPath = this._abs(root.path, rec.localPath);
      if (await this.io.exists(oldPath)) continue; // Zotero-only edit; original executor owns it
      const local = await this._locateFolder(root, rec.localPath);
      // A matching disk destination is a completed same-name edit, not a conflict.
      if (local.length === 1 && normalizedPath(local[0], !!this.zotero.isWin) === normalizedPath(this._abs(root.path, desired), !!this.zotero.isWin)) continue;
      // Both old location missing AND Zotero path changed: never guess which edit wins.
      const id = 'c' + crypto.randomUUID().replace(/-/g, '');
      root.conflicts.push({ id, collectionKey: rec.zoteroCollectionKey, oldPath,
        zoteroPath: this._abs(root.path, desired), localPath: local.length === 1 ? local[0] : null,
        oldRelativePath: rec.localPath, candidatePaths: local,
        message: '目录位置在本地已变化，Zotero 分类也已改动：' + rec.localPath });
      this._save();
    }
  }

  async resolveConflict(id, conflictID, side, selectedPath) { return this._enqueue(async () => {
    const root = this._get(id), conflict = root.conflicts.find(c => c.id === conflictID);
    if (!conflict || !['local', 'zotero'].includes(side)) throw new Error('冲突选项无效');
    if (conflict.type === 'ambiguousDirectoryMove') {
      const source = this._get(conflict.sourceID), engine = await this._engine(source);
      if (!conflict.candidatePaths.includes(selectedPath)) throw new Error('请选择冲突列表中的目录');
      const target = this.roots.find(r => r.enabled && r.id !== source.id && isWithin(selectedPath, r.path, !!this.zotero.isWin));
      if (!target) throw new Error('目标监控目录不可用');
      const rec = engine.store().getCollectionRecord(conflict.collectionKey);
      if (!rec) throw new Error('原目录记录不存在');
      await this._claimLocalDirectory(source, engine, rec, { target, path: selectedPath, rel: relativeTo(selectedPath, target.path, !!this.zotero.isWin), resolvesConflictID: conflictID });
      if (this.transfers.some(t => t.collectionKey === conflict.collectionKey)) throw new Error('迁移尚未完成，请处理迁移冲突后重试');
      for (const r of this.roots) r.conflicts = r.conflicts.filter(c => c.id !== conflictID);
      this._save(); await this._cycle(); return;
    }
    if (conflict.type === 'ambiguousMove') {
      const source = this._get(conflict.sourceID), srcEngine = await this._engine(source);
      if (side === 'local') {
        // User explicitly chose delete+new imports instead of preserving identity.
        srcEngine.store().update(conflict.record.localPath, { state: 'dirty' });
        await srcEngine.store().flush();
      } else {
        const target = this.roots.find(r => r.enabled && isWithin(selectedPath || '', r.path, !!this.zotero.isWin));
        if (!target) throw new Error('请选择其他监控目录中的目标 PDF');
        const destEngine = await this._engine(target), rel = relativeTo(selectedPath, target.path, !!this.zotero.isWin);
        if (!rel || destEngine.store().hasPath(rel)) throw new Error('目标文件已被管理，请选择未关联的迁移目标');
        const col = await destEngine.canonicalPath.relativePathToCollection(rel.split('/').slice(0, -1).join('/'), { createIfMissing: true });
        const tx = { id: 't' + crypto.randomUUID().replace(/-/g, ''), sourceID: source.id, targetID: target.id,
          record: conflict.record, sourcePath: conflict.oldPath, targetPath: selectedPath, targetRelativePath: rel, collectionKey: col.key };
        this.transfers.push(tx); this._save(); await this._finishTransfer(tx);
      }
      for (const r of this.roots) r.conflicts = r.conflicts.filter(c => c.id !== conflictID);
      this._save(); await this._cycle(); return;
    }
    if (conflict.type === 'transfer') {
      const tx = this.transfers.find(t => t.id === conflictID);
      if (!tx) throw new Error('找不到迁移记录，请重新检查');
      await this._finishTransfer(tx); await this._cycle(); return;
    }
    if (conflict.type === 'root') {
      const old = root.path, col = await this._collection(root);
      if (!col) throw new Error('请先恢复根分类');
      const path = side === 'local' ? conflict.localPath : conflict.zoteroPath;
      if (side === 'zotero' && normalizedPath(path, !!this.zotero.isWin) !== normalizedPath(conflict.localPath, !!this.zotero.isWin)) {
        await this._validateDestination(path, root.id);
        await this.io.move(conflict.localPath, path, { noOverwrite: true });
      }
      root.path = path; root.name = this.paths.filename(path); root.pendingRelink = old;
      this._rebaseRootState(old, path); this._save();
      this._mute.add(root.id);
      try { col.name = root.name; await col.saveTx(); await this._relinkAll(root, old); delete root.pendingRelink; }
      finally { this._mute.delete(root.id); }
      root.conflicts = root.conflicts.filter(c => c.id !== conflictID);
      this._save(); await this._cycle(); return;
    }
    const engine = await this._engine(root);
    const possible = await this._locateFolder(root, conflict.oldRelativePath);
    if (possible.length !== 1) throw new Error('无法唯一定位本地目录，请先将它移回原位置后重新检查。不会自动猜测或覆盖文件。');
    const localPath = possible[0];
    conflict.localPath = localPath;
    if (side === 'zotero') {
      if (normalizedPath(localPath, !!this.zotero.isWin) !== normalizedPath(conflict.zoteroPath, !!this.zotero.isWin)) {
        if (await this.io.exists(conflict.zoteroPath)) throw new Error('Zotero 对应的目标位置已存在，请先处理重名');
        await this.io.makeDirectory(this.paths.parent(conflict.zoteroPath), { ignoreExisting: true, createAncestors: true });
        await this.io.move(localPath, conflict.zoteroPath, { noOverwrite: true });
      }
    }
    root.conflicts = root.conflicts.filter(c => c.id !== conflictID);
    this._mute.add(id);
    try {
      const record = engine.store().getCollectionRecord(conflict.collectionKey);
      await engine.service()._renameTrackedCollection(record, side === 'local' ? localPath : conflict.zoteroPath);
      await engine.store().flush();
    } finally { this._mute.delete(id); }
    this._save(); await this._cycle();
  }); }

  async _locateFolder(root, oldRelativePath) {
    const engine = this.engines.get(root.id);
    if (!engine) return [];
    const files = await this._scanFiles(root.path);
    const records = engine.store().getAllOfType('file').filter(r => r.lastSyncedHash && r.localPath.startsWith(oldRelativePath + '/'));
    const possible = new Set();
    for (const rec of records) {
      const suffix = rec.localPath.slice(oldRelativePath.length + 1);
      for (const f of files) {
        if (!f.path.replace(/\\/g, '/').endsWith('/' + suffix)) continue;
        if (await engine.getFileHash(f.path) === rec.lastSyncedHash) possible.add(f.path.replace(/\\/g, '/').slice(0, -suffix.length - 1));
      }
    }
    return [...possible];
  }

  async _validateDestination(path, id) {
    assertRootPath(path, this.roots, this.zotero.DataDirectory.dir, !!this.zotero.isWin, id);
    if (await this.io.exists(path)) throw new Error('目标目录已存在，不能覆盖');
  }

  async _findRenamedRoot(root) {
    if (root.conflicts.some(c => c.type === 'root')) return true;
    let children;
    try { children = await this.io.getChildren(this.paths.parent(root.path)); }
    catch (_) { return false; }
    const matches = [];
    for (const path of children) {
      try { if ((await this.io.readJSON(this.paths.join(path, MARKER))).id === root.id) matches.push(path); }
      catch (_) { /* not a root marker */ }
    }
    if (matches.length !== 1) {
      if (matches.length > 1) this._errors.set(root.id, '发现多个相同目录标记，请使用重新定位指定原目录');
      return false;
    }
    const col = await this._collection(root);
    if (!col || col.deleted) return false;
    if (col.name !== root.name) {
      root.conflicts.push({ id: 'c' + crypto.randomUUID().replace(/-/g, ''), type: 'root',
        localPath: matches[0], oldPath: root.path,
        zoteroPath: this.paths.join(this.paths.parent(root.path), col.name),
        message: '根目录和 Zotero 顶层分类同时改名，请选择保留哪边' });
      this._save(); return true;
    }
    const old = root.path;
    await this._validateDirectory(matches[0], root.id);
    root.path = matches[0]; root.name = this.paths.filename(root.path); root.pendingRelink = old;
    this._rebaseRootState(old, root.path); this._save();
    this._mute.add(root.id);
    try { col.name = root.name; await col.saveTx(); await this._relinkAll(root, old); delete root.pendingRelink; }
    finally { this._mute.delete(root.id); }
    this._save(); return true;
  }

  async _syncRootName(root, collection) {
    if (collection.parentID) throw new Error('监控根分类需保留在顶层；请移回顶层再继续同步');
    if (collection.name === root.name) return;
    const name = collection.name;
    if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('分类名称不能用于本地目录，请修改名称');
    const destination = this.paths.join(this.paths.parent(root.path), name);
    assertRootPath(destination, this.roots, this.zotero.DataDirectory.dir, !!this.zotero.isWin, root.id);
    if (await this.io.exists(destination)) throw new Error('改名目标已经存在，已停止该目录同步');
    const old = root.path;
    await this.io.move(old, destination, { noOverwrite: true });
    root.path = destination; root.name = name; root.pendingRelink = old;
    this._rebaseRootState(old, destination); this._save();
    if (this.engines.has(root.id)) { await this._relinkAll(root, old); delete root.pendingRelink; this._save(); }
  }

  _rebaseRootState(old, next) {
    const rebase = p => typeof p === 'string' && isWithin(p, old, !!this.zotero.isWin)
      ? this._abs(next, relativeTo(p, old, !!this.zotero.isWin)) : p;
    for (const root of this.roots) for (const c of root.conflicts) {
      for (const key of ['oldPath', 'localPath', 'zoteroPath']) if (c[key]) c[key] = rebase(c[key]);
      if (c.candidatePaths) c.candidatePaths = c.candidatePaths.map(rebase);
      if (c.sourcePaths) c.sourcePaths = c.sourcePaths.map(rebase);
    }
    for (const tx of this.transfers) { tx.sourcePath = rebase(tx.sourcePath); tx.targetPath = rebase(tx.targetPath); if (tx.stagingPath) tx.stagingPath = rebase(tx.stagingPath); if (tx.backupPath) tx.backupPath = rebase(tx.backupPath); }
  }

  async _relinkAll(root, oldPath) {
    const engine = await this._engine(root);
    for (const rec of engine.store().getAllOfType('file')) {
      const rel = relativeTo(rec.localPath, oldPath, !!this.zotero.isWin) ?? rec.localPath;
      const att = await this.zotero.Items.getByLibraryAndKeyAsync(root.libraryID, rec.zoteroAttachmentKey);
      const next = this._abs(root.path, rel);
      if (att && !att.deleted && att.isLinkedFileAttachment?.() && await this.io.exists(next)) await att.relinkAttachmentFile(next);
      if (rel !== rec.localPath) { engine.store().remove(rec.localPath); engine.store().add({ ...rec, localPath: rel, canonicalLocalPath: rel }); }
    }
    await engine.store().flush();
  }

  async _rootEvents(event, ids, extra) {
    for (const root of this.roots) {
      if (!root.enabled || this._mute.has(root.id)) continue;
      const matches = ids.some(id => (this.zotero.Collections.get(id)?.key || extra[id]?.key) === root.collectionKey);
      if (!matches) continue;
      if (event === 'modify') {
        if (this.getOptions(root.id).mode === 'mode1') continue;
        const col = await this._collection(root);
        if (col && await this._available(root)) {
          try { await this._syncRootName(root, col); }
          catch (e) { root.status = '根目录改名受阻'; this._errors.set(root.id, e.message); }
        }
      } else if (event === 'delete' || event === 'trash') {
        await this._trashRoot(root);
      }
    }
  }

  _confirm(title, message) {
    if (this._promptOpen || !this.services.prompt?.confirmEx) return false;
    this._promptOpen = true;
    try {
      const p = this.services.prompt;
      return p.confirmEx(this.zotero.getMainWindow?.() || null, title, message,
        p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING | p.BUTTON_POS_1 * p.BUTTON_TITLE_CANCEL | p.BUTTON_POS_1_DEFAULT,
        '确认', null, null, null, {}) === 0;
    } finally { this._promptOpen = false; }
  }

  async _trashRoot(root) {
    if (this.getOptions(root.id).mode !== 'mode3') {
      root.enabled = false; root.status = '根分类已删除，此模式保留本地文件';
      await this._stop(root); this._save(); return;
    }
    const engine = this.engines.get(root.id);
    if (engine) {
      for (const rec of engine.store().getAllOfType('file')) {
        const path = this._abs(root.path, rec.localPath);
        if (!await this.io.exists(path)) continue;
        if (!rec.lastSyncedHash || await engine.getFileHash(path) !== rec.lastSyncedHash) {
          root.status = '根分类已删除，但本地文件有变化；已保留目录'; root.enabled = false;
          await this._stop(root); this._save(); return;
        }
      }
    }
    root.enabled = false; this._save();
    await this._stop(root);
    if (!await this._available(root)) return;
    if (!this._confirm('删除整个监控目录', 'Zotero 根分类已删除。是否将整个对应目录移入同盘的插件回收区？\n\n' + root.path + '\n\n取消会保留本地文件并暂停此绑定。')) return;
    const trash = this.paths.join(this.paths.parent(root.path), '.zotero-watch-trash-' + root.id);
    await this.io.makeDirectory(trash, { ignoreExisting: true });
    const dest = this.paths.join(trash, Date.now() + '-' + root.name);
    await this.io.move(root.path, dest, { noOverwrite: true });
    root.trashPath = dest; root.status = '根目录已移入插件回收区'; this._save();
  }

  async shutdown() {
    this._closed = true; clearTimeout(this._timer);
    if (this._notifier) this.zotero.Notifier.unregisterObserver(this._notifier);
    await this._queue;
    for (const root of this.roots) await this._stop(root);
    this._save();
  }
}

let manager;
export const hooks = {
  _rootURI: '',
  async onStartup() { manager = new MultiRootManager(); await manager.start(this._rootURI); },
  async onShutdown() { if (manager) await manager.shutdown(); },
};
export function listRoots() { return manager?.listRoots() || []; }
export const addDirectory = path => manager.addDirectory(path);
export const setEnabled = (id, value) => manager.setEnabled(id, value);
export const detach = id => manager.detach(id);
export const reconnect = (id, path) => manager.reconnect(id, path);
export const scanNow = () => manager.scanNow();
export const getOptions = id => manager.getOptions(id);
export const setOption = (id, key, value) => manager.setOption(id, key, value);
export const setOptions = (id, values) => manager.setOptions(id, values);
export const resolveConflict = (id, conflictID, side, path) => manager.resolveConflict(id, conflictID, side, path);
export const retrieveMetadata = id => manager.retrieveMetadata(id);
export const checkAndRepair = id => manager.checkAndRepair(id);
