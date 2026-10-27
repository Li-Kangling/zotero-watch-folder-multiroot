import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { MultiRootManager } from '../../content/multiRoot.mjs';
import { createRootPrefs, assertRootPath, CORE_PREFIX, HOST_PREFIX } from '../../content/rootConfig.mjs';

function fixture() {
  const prefs = new Map(), callbacks = new Map(), records = new Map();
  const nodes = new Map([['/papers', null], ['/papers/A', null], ['/papers/B', null], ['/papers/C', null], ['/data', null]]);
  const collections = new Map(), attachments = new Map();
  const io = {
    exists: vi.fn(async p => nodes.has(p)),
    stat: vi.fn(async p => { if (!nodes.has(p)) throw new Error('not found'); return { type: nodes.get(p) === null ? 'directory' : 'regular' }; }),
    getChildren: vi.fn(async p => [...nodes.keys()].filter(n => n !== p && path.posix.dirname(n) === p)),
    readJSON: vi.fn(async p => JSON.parse(nodes.get(p))),
    writeJSON: vi.fn(async (p, value) => { nodes.set(p, JSON.stringify(value)); }),
    makeDirectory: vi.fn(async p => { nodes.set(p, null); }),
    move: vi.fn(async (src, dst) => {
      if (nodes.has(dst)) throw new Error('already exists');
      for (const [p, value] of [...nodes]) if (p === src || p.startsWith(src + '/')) { nodes.delete(p); nodes.set(dst + p.slice(src.length), value); }
    }),
    copy: vi.fn(async (src, dst) => { if (nodes.has(dst)) throw new Error('already exists'); nodes.set(dst, nodes.get(src)); }), remove: vi.fn(async src => { for (const p of [...nodes.keys()]) if (p === src || p.startsWith(src + '/')) nodes.delete(p); }), writeUTF8: vi.fn(), write: vi.fn(),
  };
  let counter = 0;
  const zotero = {
    isWin: false, DataDirectory: { dir: '/data' }, Libraries: { userLibraryID: 1 },
    debug: vi.fn(), logError: vi.fn(), getMainWindow: () => null,
    Prefs: {
      get: vi.fn(k => prefs.get(k)), set: vi.fn((k, v) => prefs.set(k, v)),
      registerObserver: vi.fn(() => 'pref-observer'), unregisterObserver: vi.fn(),
    },
    Notifier: {
      registerObserver: vi.fn(observer => { const id = 'o' + ++counter; callbacks.set(id, observer); return id; }),
      unregisterObserver: vi.fn(id => callbacks.delete(id)),
    },
    PreferencePanes: { register: vi.fn() },
    Collections: {
      getByLibraryAndKeyAsync: vi.fn(async (_lib, key) => collections.get(key)),
      getByLibraryAndKey: vi.fn((_lib, key) => collections.get(key)),
      get: vi.fn(id => [...collections.values()].find(c => c.id === id)),
    },
    Items: {
      getByLibraryAndKeyAsync: vi.fn(async (_lib, key) => attachments.get(key)),
      get: vi.fn(id => [...attachments.values()].find(a => a.id === id)),
    },
  };
  const services = { prompt: { confirmEx: vi.fn(() => 0) } };
  const engines = new Map(), contexts = new Map();
  const loadEngine = async (ctx, root) => {
    contexts.set(root.id, ctx);
    const files = new Map(); records.set(root.id, files);
    const colRecords = new Map();
    const store = {
      getAllOfType: type => [...(type === 'file' ? files : colRecords).values()],
      getByAttachmentKey: key => [...files.values()].find(f => f.zoteroAttachmentKey === key),
      getCollectionRecord: key => colRecords.get(key),
      hasPath: p => files.has(p), add: rec => rec.type === 'collection' ? colRecords.set(rec.zoteroCollectionKey, rec) : files.set(rec.localPath, rec),
      removeCollectionRecord: key => colRecords.delete(key),
      remove: p => files.delete(p), update: (p, data) => files.set(p, { ...files.get(p), ...data }),
      flush: vi.fn(async () => {}),
    };
    const service = { _currentInterval: 5000, backfillStandaloneMetadata: vi.fn(), _renameTrackedCollection: vi.fn() };
    const engine = {
      initialize: vi.fn(async () => {}), activate: vi.fn(async () => {}), scan: vi.fn(async () => {}), shutdown: vi.fn(async () => {}),
      service: () => service, store: () => store, createCollectionRecord: record => ({ type: 'collection', state: 'clean', ...record }), createFileRecord: record => ({ type: 'file', state: 'clean', ...record }),
      getFileHash: async p => nodes.get(p),
      canonicalPath: {
        relativePathToCollection: vi.fn(async () => collections.get(root.collectionKey)),
        collectionKeyToDiskRelativePath: vi.fn(async key => colRecords.get(key)?.localPath ?? null),
      },
    };
    engines.set(root.id, engine);
    return engine;
  };
  const manager = new MultiRootManager({ zotero, io, paths: { join: path.posix.join, parent: path.posix.dirname, filename: path.posix.basename }, services, loadEngine });
  function root(id, name) {
    const r = { id, name, path: '/papers/' + name, collectionKey: 'COL' + name, libraryID: 1, enabled: true, conflicts: [] };
    manager.roots.push(r);
    collections.set(r.collectionKey, { id: name.charCodeAt(0), key: r.collectionKey, name, parentID: false, saveTx: vi.fn() });
    return r;
  }
  function attachment(key, parentKey = key) {
    const owner = { key: parentKey, getCollections: vi.fn(() => []), removeFromCollection: vi.fn(), addToCollection: vi.fn(), saveTx: vi.fn() };
    const att = { key, id: attachments.size + 1, parentItem: owner, isLinkedFileAttachment: () => true, relinkAttachmentFile: vi.fn(), deleted: false };
    attachments.set(key, att); return att;
  }
  return { manager, zotero, io, nodes, root, attachment, engines, records, collections, prefs, callbacks, contexts };
}

describe('multi-root bounds and preference isolation', () => {
  it('keeps read/write/observer branches isolated and rejects widening scope', () => {
    const f = fixture(), a = f.root('ra', 'A'), b = f.root('rb', 'B');
    const pa = createRootPrefs(f.zotero.Prefs, a), pb = createRootPrefs(f.zotero.Prefs, b);
    pa.set(CORE_PREFIX + 'autoRename', true, true);
    expect(pa.get(CORE_PREFIX + 'autoRename', true)).toBe(true);
    expect(pb.get(CORE_PREFIX + 'autoRename', true)).toBe(false);
    expect(pa.get(CORE_PREFIX + 'trackingFileName', true)).not.toBe(pb.get(CORE_PREFIX + 'trackingFileName', true));
    pa.registerObserver(CORE_PREFIX + 'mode', vi.fn(), true);
    expect(f.zotero.Prefs.registerObserver.mock.calls[0][0]).toBe(HOST_PREFIX + 'roots.ra.mode');
    expect(() => pa.set(CORE_PREFIX + 'scopeMode', 'library')).toThrow();
    expect(f.prefs.has(CORE_PREFIX + 'autoRename')).toBe(false);
  });
  it('rejects Windows case aliases, parent/child overlap and data-directory overlap', () => {
    const roots = [{ id: 'a', path: 'F:\\Papers\\AMS' }];
    for (const p of ['f:/papers/ams', 'F:/Papers', 'F:/Papers/AMS/sub']) expect(() => assertRootPath(p, roots, 'C:/Zotero', true)).toThrow();
    expect(() => assertRootPath('c:/zotero/storage', [], 'C:/Zotero', true)).toThrow();
    expect(() => assertRootPath('F:/Elsewhere', roots, 'C:/Zotero', true)).not.toThrow();
  });
});

describe('manager lifecycle and safety', () => {
  it('does not deadlock when Zotero awaits observer return values during saveTx', async () => {
    const f = fixture(), r = f.root('ra', 'A');
    const engine = await f.manager._engine(r), ctx = f.contexts.get(r.id), seen = vi.fn();
    ctx.Zotero.Notifier.registerObserver({ notify: seen }, ['item'], 'test');
    const obs = [...f.callbacks.values()].at(-1);
    engine.scan.mockImplementation(async () => { await Promise.resolve(obs.notify('modify', 'item', [1], {})); });
    await f.manager.scanNow(); await f.manager._queue;
    expect(seen).toHaveBeenCalledTimes(1);
  });
  it('drops pending notifications from an old runtime after pause/restart', async () => {
    const f = fixture(), r = f.root('ra', 'A');
    await f.manager._engine(r); const ctx = f.contexts.get(r.id), seen = vi.fn();
    ctx.Zotero.Notifier.registerObserver({ notify: seen }, ['item'], 'test');
    const obs = [...f.callbacks.values()].at(-1);
    await f.manager.setEnabled(r.id, false);
    obs.notify('trash', 'item', [1], {}); await f.manager._queue;
    expect(seen).not.toHaveBeenCalled(); expect(f.io.move).not.toHaveBeenCalled();
  });
  it('detach preserves both filesystem and Zotero records', async () => {
    const f = fixture(), r = f.root('ra', 'A');
    await f.manager._engine(r); await f.manager.detach(r.id);
    expect(f.manager.roots).toHaveLength(0); expect(f.nodes.has('/papers/A')).toBe(true);
    expect(f.collections.has('COLA')).toBe(true); expect(f.io.remove).not.toHaveBeenCalled();
  });
  it('does not trash a root in mode2 and does not rename it in mode1', async () => {
    const f = fixture(), r = f.root('ra', 'A');
    f.prefs.set(HOST_PREFIX + 'roots.ra.mode', 'mode2');
    await f.manager._trashRoot(r); expect(f.io.move).not.toHaveBeenCalled();
    r.enabled = true; f.prefs.set(HOST_PREFIX + 'roots.ra.mode', 'mode1');
    f.collections.get('COLA').name = 'New';
    await f.manager._rootEvents('modify', [65], {});
    expect(f.io.move).not.toHaveBeenCalled();
  });
  it('validates all options before any write and shuts down before mode writes', async () => {
    const f = fixture(), r = f.root('ra', 'A');
    const engine = await f.manager._engine(r); f.zotero.Prefs.set.mockClear();
    await expect(f.manager.setOptions(r.id, { autoRename: true, pollInterval: 0 })).rejects.toThrow();
    expect(f.zotero.Prefs.set).not.toHaveBeenCalled();
    let stopped = false; engine.shutdown.mockImplementation(async () => { stopped = true; });
    f.zotero.Prefs.set.mockImplementation((k, v) => { if (k.endsWith('.mode')) expect(stopped).toBe(true); f.prefs.set(k, v); });
    await f.manager.setOptions(r.id, { mode: 'mode2' });
  });
  it('refuses any write inside a conflicted subtree, including descendants', async () => {
    const f = fixture(), r = f.root('ra', 'A');
    r.conflicts.push({ id: 'c', collectionKey: 'PAUSED', oldPath: '/papers/A/conflict' });
    await f.manager._engine(r); const ctx = f.contexts.get(r.id);
    await expect(ctx.IOUtils.move('/papers/A/conflict/sub/a.pdf', '/papers/A/x.pdf')).rejects.toThrow();
    expect(f.io.move).not.toHaveBeenCalled();
    expect(await ctx.IOUtils.exists('/papers/A/conflict/sub')).toBe(true);
    await expect(ctx.IOUtils.move('/papers/A', '/papers/Renamed')).rejects.toThrow();
    expect(f.io.move).not.toHaveBeenCalled();
  });
  it('rebases conflicts and unfinished transactions when a root path changes', () => {
    const f = fixture(), r = f.root('ra', 'A');
    r.conflicts.push({ oldPath: '/papers/A/old', localPath: '/papers/A/local', candidatePaths: ['/papers/A/candidate'] });
    f.manager.transfers.push({ sourcePath: '/papers/A/old.pdf', targetPath: '/papers/B/new.pdf' });
    f.manager._rebaseRootState('/papers/A', '/papers/Renamed');
    expect(r.conflicts[0].oldPath).toBe('/papers/Renamed/old');
    expect(r.conflicts[0].candidatePaths).toEqual(['/papers/Renamed/candidate']);
    expect(f.manager.transfers[0].sourcePath).toBe('/papers/Renamed/old.pdf');
    expect(f.manager.transfers[0].targetPath).toBe('/papers/B/new.pdf');
  });
  it('replays collection moves that happened while the watcher was paused', async () => {
    const f = fixture(), r = f.root('ra', 'A'), engine = await f.manager._engine(r);
    engine.store().getAllOfType = type => type === 'collection' ? [{ localPath: 'Old', zoteroCollectionKey: 'CHILD', state: 'clean' }] : [];
    f.collections.set('CHILD', { key: 'CHILD', name: 'New', parentID: 65 });
    f.nodes.set('/papers/A/Old', null);
    engine.canonicalPath.collectionKeyToDiskRelativePath.mockResolvedValue('New');
    engine.mirrorExecutor = { execute: vi.fn() };
    await f.manager._replayZoteroChanges(r, engine);
    expect(engine.mirrorExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'moveFolder', payload: expect.objectContaining({ oldRelativePath: 'Old', newRelativePath: 'New' }) }));
  });
  it('replays item membership moves in mode2 without enabling deletion', async () => {
    const f = fixture(), r = f.root('ra', 'A'), engine = await f.manager._engine(r);
    f.prefs.set(HOST_PREFIX + 'roots.ra.mode', 'mode2');
    const att = f.attachment('ATT');
    engine.store().add({ type: 'file', localPath: 'Old/a.pdf', canonicalLocalPath: 'Old/a.pdf', canonicalCollectionKey: 'OLD', state: 'clean', zoteroAttachmentKey: 'ATT' });
    engine.canonicalPath.chooseCanonicalCollection = vi.fn(async () => ({ key: 'NEW' }));
    engine.canonicalPath.collectionKeyToDiskRelativePath.mockResolvedValue('New');
    engine.mirrorExecutor = { execute: vi.fn() };
    await f.manager._replayZoteroChanges(r, engine);
    expect(engine.mirrorExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'moveItem', payload: expect.objectContaining({ newCanonicalPath: 'New/a.pdf' }) }));
  });
  it('retries interrupted root relinks before allowing a scan', async () => {
    const f = fixture(), r = f.root('ra', 'A'), engine = await f.manager._engine(r);
    r.pendingRelink = '/papers/Old';
    const relink = vi.spyOn(f.manager, '_relinkAll').mockRejectedValueOnce(new Error('IO')).mockResolvedValue(undefined);
    await f.manager.scanNow(); expect(engine.scan).not.toHaveBeenCalled();
    await f.manager.scanNow(); expect(relink).toHaveBeenCalledTimes(2); expect(engine.scan).toHaveBeenCalledOnce();
  });
});

describe('cross-root identity and durable transfers', () => {
  async function setup() {
    const f = fixture(), a = f.root('ra', 'A'), b = f.root('rb', 'B');
    const ea = await f.manager._engine(a), eb = await f.manager._engine(b);
    const att = f.attachment('ATT00001', 'PARENT01');
    const rec = { type: 'file', localPath: 'old.pdf', state: 'clean', lastSyncedHash: 'hash',
      zoteroAttachmentKey: att.key, zoteroItemKey: 'PARENT01', canonicalCollectionKey: 'COLA' };
    ea.store().add(rec); f.nodes.set('/papers/B/new.pdf', 'hash');
    const active = [{ root: a, engine: ea, files: [] }, { root: b, engine: eb, files: [{ path: '/papers/B/new.pdf' }] }];
    return { ...f, a, b, ea, eb, att, rec, active };
  }
  it('moves identity without creating another attachment and persists target first', async () => {
    const f = await setup();
    await f.manager._transferMoves(f.active);
    expect(f.att.relinkAttachmentFile).toHaveBeenCalledWith('/papers/B/new.pdf');
    expect(f.ea.store().getByAttachmentKey(f.att.key)).toBeUndefined();
    expect(f.eb.store().getByAttachmentKey(f.att.key).localPath).toBe('new.pdf');
    expect(f.manager.transfers).toHaveLength(0);
  });
  it('persists a journal and blocks objects after flush failure, then recovers idempotently', async () => {
    const f = await setup();
    f.eb.store().flush.mockRejectedValueOnce(new Error('disk full'));
    await f.manager._transferMoves(f.active);
    expect(f.manager.transfers).toHaveLength(1); expect(f.a.conflicts[0].type).toBe('transfer');
    expect(JSON.parse(f.prefs.get(HOST_PREFIX + 'config')).transfers).toHaveLength(1);
    await f.manager._finishTransfer(f.manager.transfers[0]);
    expect(f.manager.transfers).toHaveLength(0); expect(f.a.conflicts).toHaveLength(0);
    expect(f.ea.store().getByAttachmentKey(f.att.key)).toBeUndefined();
  });
  it('blocks ambiguous same-content moves instead of silently deleting/importing', async () => {
    const f = await setup(); f.nodes.set('/papers/B/another.pdf', 'hash');
    f.active[1].files.push({ path: '/papers/B/another.pdf' });
    await f.manager._transferMoves(f.active);
    expect(f.att.relinkAttachmentFile).not.toHaveBeenCalled();
    expect(f.a.conflicts[0].type).toBe('ambiguousMove');
    expect(f.manager._conflicted(f.b, '/papers/B/new.pdf')).toBe(true);
    expect(f.manager._conflicted(f.b, '/papers/B/another.pdf')).toBe(true);
  });
  it('does not claim a conflict-paused file as a move source', async () => {
    const f = await setup(); f.a.conflicts.push({ id: 'blocked', oldPath: '/papers/A/old.pdf' });
    await f.manager._transferMoves(f.active);
    expect(f.att.relinkAttachmentFile).not.toHaveBeenCalled();
  });
  it('retains source membership when a sibling PDF remains under the same parent', async () => {
    const f = await setup();
    f.ea.store().add({ ...f.rec, localPath: 'translation.pdf', zoteroAttachmentKey: 'ATT00002' });
    f.nodes.set('/papers/A/translation.pdf', 'other');
    await f.manager._transferMoves(f.active);
    expect(f.att.parentItem.removeFromCollection).not.toHaveBeenCalled();
    expect(f.att.parentItem.addToCollection).toHaveBeenCalled();
  });
});


describe('whole directory root-boundary transfers', () => {
  async function setupDirectory() {
    const f = fixture(), a = f.root('ra', 'A'), b = f.root('rb', 'B');
    const ea = await f.manager._engine(a), eb = await f.manager._engine(b);
    f.collections.set('CHILD', { id: 101, key: 'CHILD', parentID: 66, name: 'X' });
    f.collections.set('EMPTY', { id: 102, key: 'EMPTY', parentID: 101, name: 'Empty' });
    for (const [key, rel, parent] of [['CHILD', 'X', 'COLA'], ['EMPTY', 'X/Empty', 'CHILD']]) {
      ea.store().add({ type: 'collection', localPath: rel, zoteroCollectionKey: key, parentCollectionKey: parent, state: 'clean' });
      f.nodes.set('/papers/A/' + rel, null);
    }
    const att = f.attachment('ATT', 'PARENT');
    ea.store().add({ type: 'file', localPath: 'X/a.pdf', zoteroAttachmentKey: 'ATT', zoteroItemKey: 'PARENT', lastSyncedHash: 'hash', canonicalCollectionKey: 'CHILD', state: 'clean' });
    f.nodes.set('/papers/A/X/a.pdf', 'hash');
    ea.canonicalPath.collectionKeyToDiskRelativePath.mockResolvedValue(null);
    eb.canonicalPath.collectionKeyToDiskRelativePath.mockImplementation(async key => key === 'CHILD' ? 'X' : key === 'EMPTY' ? 'X/Empty' : null);
    return { ...f, a, b, ea, eb, att };
  }
  it('moves the complete subtree, empty folders and collection records without recreating source', async () => {
    const f = await setupDirectory();
    await f.manager._transferZoteroMoves();
    expect(f.nodes.has('/papers/A/X')).toBe(false);
    expect(f.nodes.has('/papers/B/X/Empty')).toBe(true);
    expect(f.ea.store().getAllOfType('collection')).toHaveLength(0);
    expect(f.eb.store().getCollectionRecord('CHILD')).toMatchObject({ localPath: 'X', parentCollectionKey: 'COLB' });
    expect(f.eb.store().getCollectionRecord('EMPTY')).toMatchObject({ localPath: 'X/Empty', parentCollectionKey: 'CHILD' });
    expect(f.att.relinkAttachmentFile).toHaveBeenCalledWith('/papers/B/X/a.pdf');
    expect(f.manager.transfers).toHaveLength(0);
  });
  it('retries a partially committed directory transfer from its persisted journal', async () => {
    const f = await setupDirectory();
    f.eb.store().flush.mockRejectedValueOnce(new Error('disk full'));
    await f.manager._transferZoteroMoves();
    expect(f.manager.transfers).toHaveLength(1);
    const tx = JSON.parse(f.prefs.get(HOST_PREFIX + 'config')).transfers[0];
    expect(tx.kind).toBe('directory');
    expect(f.ea.store().getAllOfType('collection')).toHaveLength(2);
    await f.manager._finishTransfer(tx);
    expect(f.ea.store().getAllOfType('collection')).toHaveLength(0);
    expect(f.manager.transfers).toHaveLength(0);
  });
  it('copies and verifies across volumes before removing the original directory', async () => {
    const f = await setupDirectory(), move = f.io.move.getMockImplementation();
    f.io.move.mockImplementation(async (src, dst, options) => { if (src === '/papers/A/X' && dst === '/papers/B/X') throw new Error('EXDEV'); return move(src, dst, options); });
    await f.manager._transferZoteroMoves();
    expect(f.io.copy).toHaveBeenCalled();
    expect(f.io.remove).not.toHaveBeenCalled();
    expect([...f.nodes.keys()].some(p => p.startsWith('/papers/A/.zotero-watch-trash/transfers/') && p.endsWith('/a.pdf'))).toBe(true);
    expect(f.nodes.get('/papers/B/X/a.pdf')).toBe('hash');
    expect(f.manager.transfers).toHaveLength(0);
  });
  it('keeps the source and blocks both subtrees when a copied file fails verification', async () => {
    const f = await setupDirectory();
    f.io.move.mockRejectedValue(new Error('EXDEV'));
    f.io.copy.mockImplementation(async (_src, dst) => f.nodes.set(dst, 'corrupt'));
    await f.manager._transferZoteroMoves();
    expect(f.nodes.has('/papers/A/X')).toBe(true);
    expect(f.io.remove).not.toHaveBeenCalled();
    expect(f.manager.transfers).toHaveLength(1);
    expect(f.a.conflicts[0].type).toBe('transfer');
    expect(f.att.relinkAttachmentFile).not.toHaveBeenCalled();
  });
  it('preserves collection and attachment identities when a complete local directory crosses roots', async () => {
    const f = await setupDirectory();
    f.collections.get('CHILD').parentID = 65;
    f.collections.get('CHILD').saveTx = vi.fn();
    await f.io.move('/papers/A/X', '/papers/B/X');
    await f.manager._transferLocalDirectories([{ root: f.a, engine: f.ea }, { root: f.b, engine: f.eb }]);
    expect(f.collections.get('CHILD').parentID).toBe(66);
    expect(f.att.relinkAttachmentFile).toHaveBeenCalledWith('/papers/B/X/a.pdf');
    expect(f.ea.store().getCollectionRecord('CHILD')).toBeUndefined();
    expect(f.eb.store().getCollectionRecord('EMPTY')).toMatchObject({ localPath: 'X/Empty', zoteroCollectionKey: 'EMPTY' });
  });
  it('matches a unique empty local directory tree and blocks ambiguous duplicate trees', async () => {
    const f = await setupDirectory();
    f.collections.get('CHILD').parentID = 65; f.collections.get('CHILD').saveTx = vi.fn();
    f.ea.store().remove('X/a.pdf'); f.nodes.delete('/papers/A/X/a.pdf');
    await f.io.move('/papers/A/X', '/papers/B/X');
    await f.manager._transferLocalDirectories([{ root: f.a, engine: f.ea }, { root: f.b, engine: f.eb }]);
    expect(f.eb.store().getCollectionRecord('CHILD')).toBeDefined();
    const g = await setupDirectory(); g.collections.get('CHILD').parentID = 65;
    await g.io.move('/papers/A/X', '/papers/B/X');
    g.nodes.set('/papers/B/Y', null); g.nodes.set('/papers/B/Y/a.pdf', 'hash'); g.nodes.set('/papers/B/Y/Empty', null);
    await g.manager._transferLocalDirectories([{ root: g.a, engine: g.ea }, { root: g.b, engine: g.eb }]);
    expect(g.a.conflicts[0].type).toBe('ambiguousDirectoryMove');
    expect(g.att.relinkAttachmentFile).not.toHaveBeenCalled();
    expect(g.manager._conflicted(g.b, '/papers/B/X/a.pdf')).toBe(true);
  });
  it('refuses directory transfer into a conflict-paused target subtree', async () => {
    const f = await setupDirectory();
    f.b.conflicts.push({ id: 'other', oldPath: '/papers/B/X' });
    await f.manager._transferZoteroMoves();
    expect(f.io.move).not.toHaveBeenCalled(); expect(f.manager.transfers).toHaveLength(0);
  });
  it('blocks directory journal replay when another conflict overlaps its target', async () => {
    const f = await setupDirectory(); f.eb.store().flush.mockRejectedValueOnce(new Error('disk full'));
    await f.manager._transferZoteroMoves();
    const tx = f.manager.transfers[0]; f.b.conflicts.push({ id: 'other', oldPath: '/papers/B/X' });
    f.att.relinkAttachmentFile.mockClear();
    await expect(f.manager._finishTransfer(tx)).rejects.toThrow('其他同步冲突');
    expect(f.att.relinkAttachmentFile).not.toHaveBeenCalled(); expect(f.manager.transfers).toHaveLength(1);
  });
  it('hides failed-copy staging data from root engines and retains both copies on a concurrent source write', async () => {
    const f = await setupDirectory(); f.io.move.mockRejectedValue(new Error('EXDEV'));
    f.io.copy.mockImplementation(async (_src, dst) => f.nodes.set(dst, 'corrupt'));
    await f.manager._transferZoteroMoves();
    const tx = f.manager.transfers[0];
    expect(tx.stagingPath).toContain('/papers/B/.zotero-watch-trash/transfers/');
    expect(f.b.conflicts[0].stagingPath).toBe(tx.stagingPath);
    const ctx = f.contexts.get(f.b.id);
    expect(await ctx.IOUtils.getChildren('/papers/B/.zotero-watch-trash/transfers')).toEqual([]);
    const g = await setupDirectory(), move = g.io.move.getMockImplementation();
    g.io.move.mockImplementation(async (src, dst, opts) => {
      if (src === '/papers/A/X' && dst === '/papers/B/X') throw new Error('EXDEV');
      await move(src, dst, opts);
      if (src === '/papers/A/X') g.nodes.set(dst + '/a.pdf', 'concurrent edit');
    });
    await g.manager._transferZoteroMoves();
    const journal = g.manager.transfers[0];
    expect(g.nodes.get(journal.backupPath + '/a.pdf')).toBe('concurrent edit');
    expect(g.nodes.get('/papers/B/X/a.pdf')).toBe('hash');
    expect(g.io.remove).not.toHaveBeenCalled(); expect(g.att.relinkAttachmentFile).not.toHaveBeenCalled();
  });
  it('does not let two missing identical source directories race for one destination', async () => {
    const f = await setupDirectory(), c = f.root('rc', 'C'), ec = await f.manager._engine(c);
    ec.store().add({ type: 'collection', localPath: 'Y', zoteroCollectionKey: 'OTHER', state: 'clean' });
    ec.store().add({ type: 'file', localPath: 'Y/a.pdf', zoteroAttachmentKey: 'OTHERATT', lastSyncedHash: 'hash', state: 'clean' });
    await f.io.move('/papers/A/X', '/papers/B/X');
    await f.manager._transferLocalDirectories([{ root: f.a, engine: f.ea }, { root: f.b, engine: f.eb }, { root: c, engine: ec }]);
    expect(f.a.conflicts[0].type).toBe('ambiguousDirectoryMove');
    expect(f.manager._conflicted(c, '/papers/C/Y/a.pdf')).toBe(true);
    expect(f.att.relinkAttachmentFile).not.toHaveBeenCalled();
  });
  it('refuses an existing target and preserves changed managed bytes', async () => {
    const f = await setupDirectory(); f.nodes.set('/papers/B/X', null);
    await f.manager._transferZoteroMoves();
    expect(f.nodes.has('/papers/A/X')).toBe(true); expect(f.io.move).not.toHaveBeenCalled();
    const g = await setupDirectory(); g.nodes.set('/papers/A/X/a.pdf', 'changed');
    await g.manager._transferZoteroMoves();
    expect(g.nodes.get('/papers/A/X/a.pdf')).toBe('changed'); expect(g.io.move).not.toHaveBeenCalled();
  });
});


it('replays deletion against the live parent after an attachment was reparented while paused', async () => {
  const f = fixture(), r = f.root('ra', 'A'), engine = await f.manager._engine(r);
  const att = f.attachment('ATT');
  att.parentItem = { key: 'PARENT', id: 99, deleted: true };
  engine.store().add({ type: 'file', localPath: 'a.pdf', zoteroAttachmentKey: 'ATT', zoteroItemKey: 'ATT', state: 'clean' });
  engine.mirrorExecutor = { execute: vi.fn() };
  engine.service()._handleZoteroTrash = vi.fn();
  await f.manager._replayZoteroChanges(r, engine);
  expect(engine.service()._handleZoteroTrash).toHaveBeenCalledWith([99]);
  expect(engine.store().getByAttachmentKey('ATT').zoteroItemKey).toBe('PARENT');
});

it('verifies a file copied across volumes before source removal and keeps its identity', async () => {
  const f = fixture(), a = f.root('ra', 'A'), b = f.root('rb', 'B');
  const ea = await f.manager._engine(a), eb = await f.manager._engine(b), att = f.attachment('ATT');
  const rec = { type: 'file', localPath: 'a.pdf', zoteroAttachmentKey: 'ATT', state: 'clean', lastSyncedHash: 'hash' };
  ea.store().add(rec); f.nodes.set('/papers/A/a.pdf', 'hash');
  const move = f.io.move.getMockImplementation();
  f.io.move.mockImplementation(async (src, dst, opts) => { if (src === '/papers/A/a.pdf' && dst === '/papers/B/a.pdf') throw new Error('EXDEV'); return move(src, dst, opts); });
  const tx = { id: 'tx-file', sourceID: a.id, targetID: b.id, record: rec, sourcePath: '/papers/A/a.pdf', targetPath: '/papers/B/a.pdf', targetRelativePath: 'a.pdf', collectionKey: 'COLB', diskMovePending: true };
  f.manager.transfers.push(tx);
  await f.manager._finishTransfer(tx);
  expect(f.io.remove).not.toHaveBeenCalled();
  expect(f.nodes.get('/papers/A/.zotero-watch-trash/transfers/tx-file-a.pdf')).toBe('hash');
  expect(att.relinkAttachmentFile).toHaveBeenCalledWith('/papers/B/a.pdf');
  expect(eb.store().getByAttachmentKey('ATT').localPath).toBe('a.pdf');
});


it('blocks file journal replay on another overlapping conflict but permits its own recovery conflict', async () => {
  const f = fixture(), a = f.root('ra', 'A'), b = f.root('rb', 'B');
  await f.manager._engine(a); await f.manager._engine(b);
  const tx = { id: 'tx', sourceID: a.id, targetID: b.id, sourcePath: '/papers/A/a.pdf', targetPath: '/papers/B/a.pdf' };
  f.manager.transfers.push(tx); b.conflicts.push({ id: 'other', oldPath: '/papers/B/a.pdf' });
  await expect(f.manager._finishTransfer(tx)).rejects.toThrow('其他同步冲突');
  expect(f.io.move).not.toHaveBeenCalled();
});

it('refuses detach during an unfinished transfer without discarding either root or its journal', async () => {
  const f = fixture(), a = f.root('ra', 'A'), b = f.root('rb', 'B');
  const tx = { id: 'tx', sourceID: a.id, targetID: b.id }; f.manager.transfers.push(tx);
  await expect(f.manager.detach(a.id)).rejects.toThrow('未完成迁移');
  expect(f.manager.roots).toHaveLength(2); expect(a.enabled).toBe(true); expect(f.manager.transfers).toEqual([tx]);
});


describe('Gecko absolute-only PathUtils.filename compatibility', () => {
  function absoluteFilenameOnly(f) {
    f.manager.paths.filename = vi.fn(p => {
      if (!path.posix.isAbsolute(p)) throw new Error('PathUtils.filename requires an absolute path');
      return path.posix.basename(p);
    });
  }
  it('replays a restored attachment with null canonical collection using a relative tracking path', async () => {
    const f = fixture(), r = f.root('ra', 'A'), engine = await f.manager._engine(r);
    absoluteFilenameOnly(f);
    f.attachment('ATT');
    engine.store().add({ type: 'file', localPath: 'Restored/a.pdf', canonicalLocalPath: 'Restored/a.pdf', canonicalCollectionKey: null, state: 'clean', zoteroAttachmentKey: 'ATT' });
    engine.canonicalPath.chooseCanonicalCollection = vi.fn(async () => ({ key: 'NEW' }));
    engine.canonicalPath.collectionKeyToDiskRelativePath.mockResolvedValue('New');
    engine.mirrorExecutor = { execute: vi.fn() };
    await expect(f.manager._replayZoteroChanges(r, engine)).resolves.toBeUndefined();
    expect(engine.mirrorExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'moveItem', payload: expect.objectContaining({ newCanonicalPath: 'New/a.pdf' }) }));
  });
  it('moves a Zotero attachment across roots without calling PathUtils.filename on its relative path', async () => {
    const f = fixture(), a = f.root('ra', 'A'), b = f.root('rb', 'B');
    const ea = await f.manager._engine(a), eb = await f.manager._engine(b);
    absoluteFilenameOnly(f);
    const att = f.attachment('ATT');
    ea.store().add({ type: 'file', localPath: 'Old/a.pdf', canonicalLocalPath: 'Old/a.pdf', canonicalCollectionKey: 'COLA', state: 'clean', lastSyncedHash: 'hash', zoteroAttachmentKey: 'ATT' });
    f.nodes.set('/papers/A/Old', null); f.nodes.set('/papers/A/Old/a.pdf', 'hash');
    ea.canonicalPath.chooseCanonicalCollection = vi.fn(async () => null);
    eb.canonicalPath.chooseCanonicalCollection = vi.fn(async () => f.collections.get('COLB'));
    eb.canonicalPath.collectionKeyToDiskRelativePath.mockResolvedValue('');
    await expect(f.manager._transferZoteroMoves()).resolves.toBeUndefined();
    expect(f.manager.transfers).toHaveLength(0);
    expect(att.relinkAttachmentFile).toHaveBeenCalledWith('/papers/B/a.pdf');
    expect(eb.store().getByAttachmentKey('ATT')).toMatchObject({ localPath: 'a.pdf' });
  });
});
