import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../content/utils.mjs', async () => ({
  ...await vi.importActual('../../content/utils.mjs'),
  getPref: vi.fn(), setPref: vi.fn(), getFileHash: vi.fn(async () => 'HASH'),
}));
vi.mock('../../content/canonicalPath.mjs', async () => ({
  ...await vi.importActual('../../content/canonicalPath.mjs'),
  resolveSyncRoot: vi.fn(), relativePathToCollection: vi.fn(),
  chooseCanonicalCollection: vi.fn(), collectionKeyToDiskRelativePath: vi.fn(),
}));
vi.mock('../../content/fileImporter.mjs', () => ({
  importFile: vi.fn(), handlePostImportAction: vi.fn(),
}));
vi.mock('../../content/duplicateDetector.mjs', () => ({
  checkForDuplicate: vi.fn(), getDuplicateDetector: vi.fn(),
}));
vi.mock('../../content/fileRenamer.mjs', async () => ({
  ...await vi.importActual('../../content/fileRenamer.mjs'), renameAttachment: vi.fn(),
}));

import { getPref, getFileHash } from '../../content/utils.mjs';
import { resolveSyncRoot, relativePathToCollection, chooseCanonicalCollection, collectionKeyToDiskRelativePath } from '../../content/canonicalPath.mjs';
import { TrackingStore, createFileRecord, createCollectionRecord, createTombstoneRecord, STATE } from '../../content/trackingStore.mjs';
import { isBulkDelete, __test_resetPromptInFlight } from '../../content/bulkGuard.mjs';
import { execute, init, reset, canSafelyTrashZoteroAttachment, relinkLinkedAttachment } from '../../content/mirrorExecutor.mjs';
import { WatchFolderService } from '../../content/watchFolder.mjs';
import { importFile } from '../../content/fileImporter.mjs';
import { checkForDuplicate, getDuplicateDetector } from '../../content/duplicateDetector.mjs';
import { clear as clearHashCache } from '../../content/_hashCache.mjs';
import { renameAttachment } from '../../content/fileRenamer.mjs';

let prefs, store, service, attachment;
it('passes a native Windows root to Gecko when resolving normalized tracking paths', () => {
  const oldWin = Zotero.isWin, oldJoin = PathUtils.join;
  Zotero.isWin = true;
  PathUtils.join = vi.fn((root, ...parts) => {
    if (root.includes('/')) throw new Error('NS_ERROR_FILE_UNRECOGNIZED_PATH');
    return [root, ...parts].join('\\');
  });
  try {
    expect(new WatchFolderService()._resolveTrackedAbs('Sub/file.pdf', 'F:/papers/A')).toBe('F:\\papers\\A\\Sub\\file.pdf');
  } finally { Zotero.isWin = oldWin; PathUtils.join = oldJoin; }
});
beforeEach(() => {
  vi.clearAllMocks();
  clearHashCache();
  prefs = { multiRootMode: true, sourcePath: '/watch', mode: 'mode3', scopeMode: 'collection',
    pdfStorageStrategy: 'linked_watch_folder', autoRetrieveMetadata: false };
  getPref.mockImplementation((k) => prefs[k]);
  getFileHash.mockResolvedValue('HASH');
  resolveSyncRoot.mockResolvedValue({ collection: { id: 1, key: 'ROOT' }, libraryID: 1 });
  relativePathToCollection.mockResolvedValue({ id: 1, key: 'ROOT', libraryID: 1 });
  chooseCanonicalCollection.mockResolvedValue({ key: 'ROOT' });
  collectionKeyToDiskRelativePath.mockResolvedValue('');
  Zotero.WatchFolderMultiRootOwnership = undefined;
  IOUtils.exists = vi.fn(async () => true);
  IOUtils.stat = vi.fn(async (p) => ({ type: p === '/watch' ? 'directory' : 'regular', size: 100, lastModified: 1 }));
  IOUtils.getChildren = vi.fn(async () => []);
  IOUtils.move = vi.fn(async () => {});
  IOUtils.copy = vi.fn(async () => {});
  IOUtils.remove = vi.fn(async () => {});
  IOUtils.writeJSON = vi.fn(async () => {});
  IOUtils.makeDirectory = vi.fn(async () => {});
  Services.prompt.confirmEx = vi.fn(() => 0);
  __test_resetPromptInFlight();
  attachment = { key: 'ATT', id: 2, deleted: false, parentID: null,
    isAttachment: () => true, isLinkedFileAttachment: () => true,
    getFilePath: () => '/watch/a.pdf', getFilePathAsync: async () => false,
    relinkAttachmentFile: vi.fn(async () => {}), saveTx: vi.fn(async () => {}) };
  Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
  Zotero.Items.getAsync = vi.fn();
  store = new TrackingStore(Infinity);
  store._initialized = true;
  store.dataFile = '/data/root.json';
  store.save = vi.fn(async () => {});
  service = new WatchFolderService();
  service._trackingStore = store;
  service._waitForFileStable = vi.fn(async () => true);
  importFile.mockResolvedValue(attachment);
  checkForDuplicate.mockResolvedValue({ isDuplicate: false });
  reset();
  init({ trackingStore: store });
});

describe('independent tracking persistence', () => {
  it('keeps the default tracking filename when the override is absent', async () => {
    Zotero.DataDirectory = { dir: '/data' };
    const s = new TrackingStore();
    s.load = vi.fn();
    await s.init();
    expect(s.dataFile).toBe('/data/zotero-watch-folder-tracking-v2.json');
  });
  it('uses a separate validated JSON basename for a root', async () => {
    Zotero.DataDirectory = { dir: '/data' };
    prefs.trackingFileName = 'zotero-watch-folder-multiroot-abc123.json';
    const s = new TrackingStore();
    s.load = vi.fn();
    await s.init();
    expect(s.dataFile).toBe('/data/zotero-watch-folder-multiroot-abc123.json');
  });
  it.each(['../other.json', 'C:\\other.json', '/other.json', 'a/b.json', 'a\\b.json', '..json', 'a.txt'])('refuses an unsafe tracking basename: %s', async (name) => {
    Zotero.DataDirectory = { dir: '/data' };
    prefs.trackingFileName = name;
    const s = new TrackingStore();
    s.load = vi.fn();
    await s.init();
    expect(s.dataFile).toBeNull();
    expect(s.load).not.toHaveBeenCalled();
  });
  it('selects a tombstone by hash AND original path without changing upstream hash lookup', () => {
    store.add(createTombstoneRecord({ originalHash: 'HASH', localPath: 'a.pdf', zoteroAttachmentKey: 'A', deletedAt: '2026-01-01' }));
    store.add(createTombstoneRecord({ originalHash: 'HASH', localPath: 'b.pdf', zoteroAttachmentKey: 'B', deletedAt: '2026-01-02' }));
    expect(store.findTombstoneByHash('HASH').zoteroAttachmentKey).toBe('B');
    expect(store.findTombstoneByHash('HASH', 'a.pdf').zoteroAttachmentKey).toBe('A');
    expect(store.findTombstoneByHash('HASH', 'c.pdf')).toBeNull();
  });
});

describe('independent file imports', () => {
  it.each([
    ['paused', 'stamp'], ['destroyed', 'stamp'], ['paused', 'rename'], ['destroyed', 'rename'],
  ])('stops metadata side effects when %s during the awaited %s lookup', async (state, phase) => {
    prefs.enabled = true;
    prefs.autoRetrieveMetadata = true;
    prefs.autoRename = true;
    service._initialized = true;
    service._metadataRetriever = { queueItem: vi.fn() };
    await service._processNewFile('/watch/a.pdf');
    const storeContentHash = vi.fn(async () => {});
    getDuplicateDetector.mockReturnValue({ storeContentHash });
    let completeLookup, lookupStarted;
    const started = new Promise(resolve => { lookupStarted = resolve; });
    const lookup = new Promise(resolve => { completeLookup = resolve; });
    if (phase === 'rename') Zotero.Items.getAsync.mockResolvedValueOnce(attachment);
    Zotero.Items.getAsync.mockImplementationOnce(() => { lookupStarted(); return lookup; });
    const completion = service._metadataRetriever.queueItem.mock.calls[0][1](true, attachment.id);
    await started;
    if (state === 'paused') prefs.enabled = false;
    else service._initialized = false;
    completeLookup(attachment);
    await completion;
    expect(storeContentHash).toHaveBeenCalledTimes(phase === 'stamp' ? 0 : 1);
    expect(renameAttachment).not.toHaveBeenCalled();
  });
  it.each(['paused', 'destroyed'])('ignores a late metadata callback after the root is %s', async state => {
    prefs.enabled = true;
    prefs.autoRetrieveMetadata = true;
    prefs.autoRename = true;
    service._initialized = true;
    service._metadataRetriever = { queueItem: vi.fn() };
    await service._processNewFile('/watch/a.pdf');
    const callback = service._metadataRetriever.queueItem.mock.calls[0][1];
    if (state === 'paused') prefs.enabled = false;
    else service._initialized = false;
    const update = vi.spyOn(store, 'update');
    await callback(true, attachment.id);
    expect(update).not.toHaveBeenCalled();
    expect(Zotero.Items.getAsync).not.toHaveBeenCalled();
    expect(renameAttachment).not.toHaveBeenCalled();
  });
  it('still runs metadata completion and rename for an active multi-root engine', async () => {
    prefs.enabled = true;
    prefs.autoRetrieveMetadata = true;
    prefs.autoRename = true;
    service._initialized = true;
    service._metadataRetriever = { queueItem: vi.fn() };
    await service._processNewFile('/watch/a.pdf');
    Zotero.Items.getAsync.mockResolvedValue(attachment);
    renameAttachment.mockResolvedValue({ success: true, oldName: 'a.pdf', newName: 'renamed.pdf' });
    await service._metadataRetriever.queueItem.mock.calls[0][1](true, attachment.id);
    expect(renameAttachment).toHaveBeenCalledWith(attachment);
  });
  it('imports a second physical copy with its own attachment instead of a shared shadow', async () => {
    store.add(createFileRecord({ localPath: 'old.pdf', lastSyncedHash: 'HASH', zoteroAttachmentKey: 'OLD' }));
    await service._processNewFile('/watch/a.pdf');
    expect(importFile).toHaveBeenCalledOnce();
    expect(checkForDuplicate).not.toHaveBeenCalled();
    expect(store.getByLocalPath('a.pdf').zoteroAttachmentKey).toBe('ATT');
    expect(store.getByLocalPath('old.pdf').zoteroAttachmentKey).toBe('OLD');
  });
  it('preserves upstream same-hash dedup when multiRootMode is absent', async () => {
    prefs.multiRootMode = undefined;
    store.add(createFileRecord({ localPath: 'old.pdf', lastSyncedHash: 'HASH', zoteroAttachmentKey: 'OLD' }));
    await service._processNewFile('/watch/a.pdf');
    expect(importFile).not.toHaveBeenCalled();
    expect(store.getByLocalPath('a.pdf').zoteroAttachmentKey).toBe('OLD');
  });
  it('does not restore an unrelated same-hash tombstone for a new copy', async () => {
    store.add(createTombstoneRecord({ localPath: 'old.pdf', originalHash: 'HASH', zoteroAttachmentKey: 'OLD' }));
    await service._processNewFile('/watch/a.pdf');
    expect(importFile).toHaveBeenCalledOnce();
    expect(store.findTombstoneByAttachmentKey('OLD')).not.toBeNull();
  });
});

describe('safe linked-file deletion gate', () => {
  const rec = () => createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'ATT', lastSyncedHash: 'HASH' });
  function missingFile() {
    IOUtils.exists.mockImplementation(async (p) => p !== '/watch/a.pdf');
    IOUtils.stat.mockImplementation(async (p) => {
      if (p === '/watch/a.pdf') throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      return { type: 'directory' };
    });
  }
  it('allows the exact missing linked attachment under a readable root', async () => {
    missingFile();
    expect(await canSafelyTrashZoteroAttachment(rec(), attachment)).toEqual({ ok: true });
    expect(getFileHash).not.toHaveBeenCalled();
  });
  it('retains upstream file-unavailable refusal outside multi-root mode', async () => {
    prefs.multiRootMode = false;
    missingFile();
    expect((await canSafelyTrashZoteroAttachment(rec(), attachment)).reason).toBe('file-unavailable');
  });
  it('does not weaken the gate for stored attachments', async () => {
    attachment.isLinkedFileAttachment = () => false;
    missingFile();
    expect((await canSafelyTrashZoteroAttachment(rec(), attachment)).reason).toBe('file-unavailable');
  });
  it('blocks a linked attachment whose recorded path does not match', async () => {
    missingFile();
    attachment.getFilePath = () => '/elsewhere/a.pdf';
    expect((await canSafelyTrashZoteroAttachment(rec(), attachment)).reason).toBe('linked-path-mismatch');
  });
  it('blocks when the root is unreadable', async () => {
    missingFile();
    IOUtils.getChildren.mockRejectedValue(new Error('access denied'));
    expect((await canSafelyTrashZoteroAttachment(rec(), attachment)).ok).toBe(false);
  });
  it('blocks when a missing-file probe is actually an IO error', async () => {
    missingFile();
    IOUtils.stat.mockImplementation(async (p) => {
      if (p === '/watch') return { type: 'directory' };
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    });
    expect((await canSafelyTrashZoteroAttachment(rec(), attachment)).reason).toBe('io-error');
  });
});

describe('recoverable deletion policy', () => {
  it('restores the original attachment and parent when a locally deleted PDF reappears', async () => {
    store.add(createTombstoneRecord({ localPath: 'a.pdf', originalHash: 'HASH',
      zoteroAttachmentKey: 'ATT', zoteroItemKey: 'PARENT', deletedFrom: 'local' }));
    attachment.deleted = true;
    attachment.parentID = 50;
    const parent = { deleted: true, saveTx: vi.fn() };
    Zotero.Items.getAsync.mockResolvedValue(parent);
    await service._processNewFile('/watch/a.pdf');
    expect(parent.deleted).toBe(false);
    expect(attachment.deleted).toBe(false);
    expect(attachment.relinkAttachmentFile).toHaveBeenCalledWith('/watch/a.pdf');
    expect(importFile).not.toHaveBeenCalled();
    expect(store.getByLocalPath('a.pdf').zoteroAttachmentKey).toBe('ATT');
    expect(store.findTombstoneByAttachmentKey('ATT')).toBeNull();
  });
  it('relinks the original attachment to the collision-safe path when restoring from plugin trash', async () => {
    Zotero.Items.get = vi.fn(() => attachment);
    store.add(createTombstoneRecord({ localPath: 'a.pdf', canonicalLocalPath: 'a.pdf', originalHash: 'HASH',
      zoteroAttachmentKey: 'ATT', trashPath: '.zotero-watch-trash/a.pdf', deletedFrom: 'zotero' }));
    await service._handleZoteroRestore([2]);
    expect(attachment.relinkAttachmentFile).toHaveBeenCalledWith(expect.stringMatching(/^\/watch\/a\.restored\.\d+\.pdf$/));
    expect(IOUtils.move).toHaveBeenCalledWith('/watch/.zotero-watch-trash/a.pdf', expect.stringContaining('.restored.'), { noOverwrite: true });
    expect(store.getAllOfType('file')[0].zoteroAttachmentKey).toBe('ATT');
  });
  it('confirms every multi-file batch while retaining the original upstream thresholds', () => {
    expect(isBulkDelete(1, 100)).toBe(false);
    expect(isBulkDelete(2, 100)).toBe(true);
    prefs.multiRootMode = false;
    expect(isBulkDelete(2, 100)).toBe(false);
  });
  it.each(['zoteroCollectionDeleted', 'localFolderDeleted'])('confirms even an empty folder before %s', async (type) => {
    Services.prompt.confirmEx.mockReturnValue(1);
    const result = await execute({ type, payload: { collectionKey: 'COL', oldRelativePath: 'empty' } });
    expect(result.reason).toBe('bulk-confirm-denied');
    expect(Services.prompt.confirmEx).toHaveBeenCalledOnce();
    expect(IOUtils.move).not.toHaveBeenCalled();
  });
  it('keeps a file if neither plugin trash nor OS trash is available', async () => {
    const original = globalThis.Components;
    globalThis.Components = undefined;
    try {
      await expect(service._moveToOSTrash('/watch/a.pdf')).rejects.toThrow('Recoverable trash');
      expect(IOUtils.remove).not.toHaveBeenCalled();
    } finally { globalThis.Components = original; }
  });
});

describe('move identity and overwrite protection', () => {
  it('does not steal another tracked identical PDF as the destination of a deleted file', async () => {
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'ATT', lastSyncedHash: 'HASH' }));
    store.add(createFileRecord({ localPath: 'b.pdf', zoteroAttachmentKey: 'OTHER', lastSyncedHash: 'HASH' }));
    IOUtils.exists.mockImplementation(async p => p === '/watch' || p === '/watch/b.pdf');
    IOUtils.stat.mockImplementation(async p => {
      if (p === '/watch') return { type: 'directory' };
      if (p === '/watch/b.pdf') return { type: 'regular', size: 100, lastModified: 1 };
      throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
    });
    const moves = vi.spyOn(service, '_handleFileMoves');
    await service._handleExternalDeletions(new Set(['/watch/b.pdf']), [{ path: '/watch/b.pdf' }]);
    expect(moves).not.toHaveBeenCalled();
    expect(attachment.deleted).toBe(true);
    expect(store.getByLocalPath('b.pdf').zoteroAttachmentKey).toBe('OTHER');
    expect(store.findTombstoneByAttachmentKey('ATT')).toMatchObject({ localPath: 'a.pdf', deletedFrom: 'local', originalHash: 'HASH' });
  });
  it('detects a renamed Windows folder with native backslash scan paths', async () => {
    prefs.sourcePath = 'F:\\papers';
    service._listSubdirectories = vi.fn(async () => ['F:\\papers\\dest']);
    const collection = { name: 'old', parentID: 1, saveTx: vi.fn() };
    Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => collection);
    store.add(createCollectionRecord({ localPath: 'old', zoteroCollectionKey: 'COL' }));
    store.add(createFileRecord({ localPath: 'old/a.pdf', zoteroAttachmentKey: 'ATT', lastSyncedHash: 'HASH' }));
    await service._detectFolderRenames([{ path: 'F:\\papers\\dest\\a.pdf', relativePath: 'dest/a.pdf', size: 100, mtime: 1 }], 'F:\\papers');
    expect(store.getCollectionRecord('COL').localPath).toBe('dest');
    expect(store.getByLocalPath('dest/a.pdf').zoteroAttachmentKey).toBe('ATT');
    expect(attachment.relinkAttachmentFile).toHaveBeenCalledWith('F:/papers/dest/a.pdf');
  });
  it('relinks the existing attachment after a Zotero-side file move', async () => {
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'ATT', lastSyncedHash: 'HASH' }));
    expect((await execute({ type: 'moveItem', payload: { attachmentKey: 'ATT', oldCanonicalPath: 'a.pdf', newCanonicalPath: 'b.pdf' } })).ok).toBe(true);
    expect(attachment.relinkAttachmentFile).toHaveBeenCalledWith('/watch/b.pdf');
    expect(store.getByLocalPath('b.pdf').zoteroAttachmentKey).toBe('ATT');
  });
  it('relinks every tracked linked child after a Zotero folder rename', async () => {
    store.add(createFileRecord({ localPath: 'old/a.pdf', zoteroAttachmentKey: 'ATT', lastSyncedHash: 'HASH' }));
    const result = await execute({ type: 'moveFolder', payload: { collectionKey: 'COL', oldRelativePath: 'old', newRelativePath: 'new' } });
    expect(result.ok).toBe(true);
    expect(attachment.relinkAttachmentFile).toHaveBeenCalledWith('/watch/new/a.pdf');
  });
  it('does not overwrite or clean up an existing destination after a failed move', async () => {
    IOUtils.move.mockRejectedValue(new Error('target exists'));
    const result = await execute({ type: 'moveFolder', payload: { collectionKey: 'COL', oldRelativePath: 'old', newRelativePath: 'existing' } });
    expect(result.reason).toBe('destination-exists');
    expect(IOUtils.copy).not.toHaveBeenCalled();
    expect(IOUtils.remove).not.toHaveBeenCalled();
  });
  it('uses noOverwrite for cross-drive copies and keeps a failed copy destination', async () => {
    IOUtils.move.mockRejectedValue(new Error('cross drive'));
    IOUtils.exists.mockResolvedValue(false);
    IOUtils.copy.mockRejectedValue(new Error('copy race'));
    await execute({ type: 'moveFolder', payload: { collectionKey: 'COL', oldRelativePath: 'old', newRelativePath: 'new' } });
    expect(IOUtils.copy).toHaveBeenCalledWith('/watch/old', '/watch/new', { recursive: true, noOverwrite: true });
    expect(IOUtils.remove).not.toHaveBeenCalled();
  });
  it('moves collection membership on the parent item and relinks the same attachment after a local move', async () => {
    const parent = { getCollections: () => [3], removeFromCollection: vi.fn(), addToCollection: vi.fn(), saveTx: vi.fn() };
    attachment.parentID = 50;
    Zotero.Items.getAsync.mockResolvedValue(parent);
    relativePathToCollection.mockImplementation(async (rel) => rel === 'old' ? { id: 3, key: 'OLD' } : { id: 4, key: 'NEW' });
    const r = createFileRecord({ localPath: 'old/a.pdf', zoteroAttachmentKey: 'ATT', lastSyncedHash: 'HASH', canonicalCollectionKey: 'OLD' });
    store.add(r);
    await service._handleFileMoves([{ record: r, newPath: '/watch/new/a.pdf' }]);
    expect(parent.removeFromCollection).toHaveBeenCalledWith(3);
    expect(parent.addToCollection).toHaveBeenCalledWith(4);
    expect(attachment.relinkAttachmentFile).toHaveBeenCalledWith('/watch/new/a.pdf');
    expect(store.getByLocalPath('new/a.pdf').zoteroAttachmentKey).toBe('ATT');
  });
  it('updates a moved local folder parent and preserves the linked child key', async () => {
    const collection = { name: 'old', parentID: 1, saveTx: vi.fn() };
    Zotero.Collections.getByLibraryAndKeyAsync = vi.fn(async () => collection);
    relativePathToCollection.mockResolvedValue({ id: 7, key: 'DEST' });
    store.add(createCollectionRecord({ localPath: 'old', zoteroCollectionKey: 'COL' }));
    store.add(createFileRecord({ localPath: 'old/a.pdf', zoteroAttachmentKey: 'ATT' }));
    await service._renameTrackedCollection(store.getCollectionRecord('COL'), '/watch/dest/new');
    expect(collection.parentID).toBe(7);
    expect(collection.name).toBe('new');
    expect(attachment.relinkAttachmentFile).toHaveBeenCalledWith('/watch/dest/new/a.pdf');
    expect(store.getByLocalPath('dest/new/a.pdf').zoteroAttachmentKey).toBe('ATT');
  });
  it('marks a moved attachment blocked when relinking fails', async () => {
    attachment.relinkAttachmentFile.mockRejectedValue(new Error('busy'));
    store.add(createFileRecord({ localPath: 'a.pdf', zoteroAttachmentKey: 'ATT', lastSyncedHash: 'HASH' }));
    await execute({ type: 'moveItem', payload: { attachmentKey: 'ATT', oldCanonicalPath: 'a.pdf', newCanonicalPath: 'b.pdf' } });
    expect(store.getByLocalPath('b.pdf').state).toBe(STATE.CONFLICT_BLOCKED);
  });
});


describe('restored stored PDF recovery without lost identities', () => {
  let nodes, owner;
  beforeEach(() => {
    prefs.enabled = true;
    service._initialized = true;
    owner = { key: 'PARENT', deleted: false };
    Object.assign(attachment, {
      parentItem: owner, attachmentFilename: 'paper.pdf', attachmentContentType: 'application/pdf',
      isStoredFileAttachment: () => true, isLinkedFileAttachment: () => false,
      getFilePathAsync: async () => '/storage/ATT/paper.pdf',
    });
    Zotero.Items.get = vi.fn(() => attachment);
    nodes = new Map([['/watch', 'DIR'], ['/storage/ATT/paper.pdf', 'PDF-BYTES']]);
    IOUtils.exists.mockImplementation(async p => nodes.has(p));
    IOUtils.stat.mockImplementation(async p => {
      if (!nodes.has(p)) throw new Error('missing');
      return { type: nodes.get(p) === 'DIR' ? 'directory' : 'regular', size: nodes.get(p).length, lastModified: 42 };
    });
    IOUtils.makeDirectory.mockImplementation(async p => nodes.set(p, 'DIR'));
    IOUtils.copy.mockImplementation(async (src, dst, options) => {
      if (!nodes.has(src)) throw new Error('source missing');
      if (options?.noOverwrite && nodes.has(dst)) throw new Error('destination exists');
      nodes.set(dst, nodes.get(src));
    });
    IOUtils.move.mockImplementation(async (src, dst, options) => {
      if (!nodes.has(src)) throw new Error('source missing');
      if (options?.noOverwrite && nodes.has(dst)) throw new Error('destination exists');
      nodes.set(dst, nodes.get(src)); nodes.delete(src);
    });
    IOUtils.remove.mockImplementation(async p => nodes.delete(p));
    getFileHash.mockImplementation(async p => nodes.get(p) === 'PDF-BYTES' ? 'HASH' : 'OTHER-HASH');
  });
  it('rebuilds tracking for the same stored attachment and preserves the internal PDF', async () => {
    collectionKeyToDiskRelativePath.mockResolvedValue('Sub');
    chooseCanonicalCollection.mockResolvedValue({ key: 'SUB' });
    await service._handleZoteroRestore([2]);
    expect(nodes.get('/watch/Sub/paper.pdf')).toBe('PDF-BYTES');
    expect(nodes.get('/storage/ATT/paper.pdf')).toBe('PDF-BYTES');
    expect(IOUtils.copy).toHaveBeenCalledWith('/storage/ATT/paper.pdf', '/watch/Sub/paper.pdf', { noOverwrite: true });
    expect(store.getByAttachmentKey('ATT')).toMatchObject({ zoteroItemKey: 'PARENT', canonicalCollectionKey: 'SUB', lastSyncedSize: 9, lastSyncedMtime: 42 });
    expect(importFile).not.toHaveBeenCalled();
    expect(attachment.relinkAttachmentFile).not.toHaveBeenCalled();
  });
  it('uses the current naming template for untracked and tombstone stored restores', async () => {
    Object.assign(owner, { getCreators: () => [{ lastName: 'Cantoro' }],
      getField: field => ({ title: 'Scan Networks', date: '2018', year: '2018' }[field] || '') });
    prefs.autoRename = true; prefs.renamePattern = '{title} - {year} - {firstCreator}';
    await service._handleZoteroRestore([2]);
    expect(store.getByAttachmentKey('ATT').localPath).toBe('Scan Networks - 2018 - Cantoro.pdf');
    attachment.deleted = true; await service._handleZoteroTrash([2]);
    prefs.renamePattern = '{year} - {title}'; attachment.deleted = false;
    await service._handleZoteroRestore([2]);
    expect(store.getByAttachmentKey('ATT').localPath).toBe('2018 - Scan Networks.pdf');
    expect(nodes.get('/storage/ATT/paper.pdf')).toBe('PDF-BYTES');
    expect(nodes.get('/watch/2018 - Scan Networks.pdf')).toBe('PDF-BYTES');
  });
  it('keeps the old name when automatic renaming is disabled even with metadata', async () => {
    Object.assign(owner, { getCreators: () => [{ lastName: 'Cantoro' }], getField: () => 'Scan Networks' });
    prefs.autoRename = false; await service._handleZoteroRestore([2]);
    expect(store.getByAttachmentKey('ATT').localPath).toBe('paper.pdf');
  });
  it('renames an already restored stored mirror through the guarded executor', async () => {
    await service._handleZoteroRestore([2]);
    Object.assign(owner, { getCreators: () => [{ lastName: 'Cantoro' }], getField: field => ({ title: 'Scan Networks', year: '2018' }[field] || '') });
    prefs.autoRename = true; prefs.renamePattern = '{title} - {year} - {firstCreator}';
    await service._applyStoredMirrorName(attachment, store.getByAttachmentKey('ATT'));
    expect(store.getByAttachmentKey('ATT').localPath).toBe('Scan Networks - 2018 - Cantoro.pdf');
    expect(nodes.get('/watch/Scan Networks - 2018 - Cantoro.pdf')).toBe('PDF-BYTES');
    expect(nodes.get('/storage/ATT/paper.pdf')).toBe('PDF-BYTES');
  });
  it('supports three complete trash and restore cycles after repairing a missing record', async () => {
    await service._handleZoteroRestore([2]);
    for (let cycle = 0; cycle < 3; cycle++) {
      attachment.deleted = true;
      await service._handleZoteroTrash([2]);
      expect(nodes.has('/watch/paper.pdf')).toBe(false);
      expect(store.findTombstoneByAttachmentKey('ATT')).not.toBeNull();
      attachment.deleted = false;
      await service._handleZoteroRestore([2]);
      expect(nodes.get('/watch/paper.pdf')).toBe('PDF-BYTES');
      expect(store.getByAttachmentKey('ATT')).toMatchObject({ canonicalCollectionKey: 'ROOT', lastSyncedSize: 9, lastSyncedMtime: 42, state: STATE.CLEAN });
      expect(store.findTombstoneByAttachmentKey('ATT')).toBeNull();
    }
    expect(IOUtils.copy).toHaveBeenCalledTimes(1);
    expect(nodes.get('/storage/ATT/paper.pdf')).toBe('PDF-BYTES');
  });
  it.each([null, '.zotero-watch-trash/missing.pdf'])('falls back to the stored PDF for an unavailable trash source: %s', async trashPath => {
    store.add(createTombstoneRecord({ localPath: 'paper.pdf', canonicalLocalPath: 'paper.pdf', originalHash: 'HASH', zoteroAttachmentKey: 'ATT', trashPath, deletedFrom: 'zotero' }));
    await service._handleZoteroRestore([2]);
    expect(nodes.get('/watch/paper.pdf')).toBe('PDF-BYTES');
    expect(store.findTombstoneByAttachmentKey('ATT')).toBeNull();
    expect(store.getByAttachmentKey('ATT')).not.toBeNull();
  });
  it.each(['disabled', 'uninitialized', 'attachment deleted', 'owner deleted', 'outside scope', 'owned elsewhere', 'already tracked', 'source missing'])('does not repair when %s', async reason => {
    if (reason === 'disabled') prefs.enabled = false;
    if (reason === 'uninitialized') service._initialized = false;
    if (reason === 'attachment deleted') attachment.deleted = true;
    if (reason === 'owner deleted') owner.deleted = true;
    if (reason === 'outside scope') chooseCanonicalCollection.mockResolvedValue(null);
    if (reason === 'owned elsewhere') Zotero.WatchFolderMultiRootOwnership = { isOwnedElsewhere: async () => true };
    if (reason === 'already tracked') store.add(createFileRecord({ localPath: 'existing.pdf', zoteroAttachmentKey: 'ATT' }));
    if (reason === 'source missing') nodes.delete('/storage/ATT/paper.pdf');
    await service._handleZoteroRestore([2]);
    expect(nodes.has('/watch/paper.pdf')).toBe(false);
    expect(IOUtils.copy).not.toHaveBeenCalled();
  });
  it('leaves a different file untouched and restores to an attachment-specific suffix', async () => {
    nodes.set('/watch/paper.pdf', 'OTHER-PDF');
    await service._handleZoteroRestore([2]);
    expect(nodes.get('/watch/paper.pdf')).toBe('OTHER-PDF');
    expect(nodes.get('/watch/paper.restored.ATT.pdf')).toBe('PDF-BYTES');
    expect(store.getByAttachmentKey('ATT').localPath).toBe('paper.restored.ATT.pdf');
  });
  it('refuses to overwrite a conflicting suffix destination', async () => {
    nodes.set('/watch/paper.pdf', 'OTHER-PDF');
    nodes.set('/watch/paper.restored.ATT.pdf', 'OTHER-PDF');
    await expect(service._handleZoteroRestore([2])).rejects.toThrow('different content');
    expect(IOUtils.copy).not.toHaveBeenCalled();
    expect(store.getByAttachmentKey('ATT')).toBeFalsy();
  });
});
