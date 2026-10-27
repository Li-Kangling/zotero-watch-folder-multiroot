/* Isolated-profile test driver. This file is NOT included in the delivered XPI. */
var resultPath;
var liveResults = [];
function install() {}
function shutdown() {}
function uninstall() {}
function startup(data) { liveResults = []; setTimeout(() => runSmoke(data), 1000); }
async function runSmoke({ rootURI }) {
  await Zotero.initializationPromise;
  const base = Zotero.Prefs.get('extensions.zotero.multiRootSmoke.base', true);
  const safeNorm = p => String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  if (!base || safeNorm(Zotero.DataDirectory.dir) !== safeNorm(PathUtils.join(base, 'data'))
      || !safeNorm(base).includes('/watch-folder-multiroot/test/live')) {
    throw new Error('Smoke driver refuses to operate outside its isolated test data directory');
  }
  resultPath = PathUtils.join(base, 'result.json');
  const write = async () => IOUtils.writeJSON(resultPath, { results: liveResults, error: null }, { tmpPath: resultPath + '.tmp' });
  const assert = async (name, ok, detail = '') => {
    liveResults.push({ name, passed: !!ok, detail }); await write();
    if (!ok) throw new Error(name + ': ' + detail);
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const norm = p => String(p).replace(/\\/g, '/').toLowerCase();
  try {
    for (let i = 0; i < 200 && !Zotero.WatchFolderMultiRoot; i++) await wait(100);
    const api = Zotero.WatchFolderMultiRoot;
    await assert('plugin started', !!api);
    let manager;
    const originalCycle = api.MultiRootManager.prototype._cycle;
    api.MultiRootManager.prototype._cycle = function () { manager = this; return originalCycle.call(this); };
    for (const root of api.listRoots()) {
      if (!safeNorm(root.path).startsWith(safeNorm(base) + '/')
        && !safeNorm(root.path).startsWith('d:/temp/zotero-watch-folder-multiroot-test/')) throw new Error('Unexpected non-test watch root');
      await api.detach(root.id);
    }
    const run = PathUtils.join(base, 'runs', 'run-' + Date.now());
    const a = PathUtils.join(run, 'papers', 'A'), b = PathUtils.join(run, 'papers', 'B');
    await IOUtils.makeDirectory(a, { createAncestors: true, ignoreExisting: true });
    await IOUtils.makeDirectory(b, { createAncestors: true, ignoreExisting: true });
    const idA = await api.addDirectory(a), idB = await api.addDirectory(b);
    await api.setOptions(idA, { autoRetrieveMetadata: false, pollInterval: 3600 });
    await api.setOptions(idB, { autoRetrieveMetadata: false, pollInterval: 3600 });
    await assert('two roots', api.listRoots().length === 2);
    const rootA = api.listRoots().find(r => r.id === idA), rootB = api.listRoots().find(r => r.id === idB);
    await assert('top collections independent', rootA.collectionKey !== rootB.collectionKey);
    const pdf = await IOUtils.read(PathUtils.join(base, 'fixture.pdf'));
    const fileA = PathUtils.join(a, 'original.pdf'), fileB = PathUtils.join(b, 'copy.pdf');
    await IOUtils.write(fileA, pdf); await IOUtils.write(fileB, pdf); await api.scanNow();
    const track = async id => IOUtils.readJSON(PathUtils.join(Zotero.DataDirectory.dir, 'zotero-watch-folder-multiroot-' + id + '.json'));
    let ta = await track(idA), tb = await track(idB);
    await assert('both PDFs imported', ta.files.length === 1 && tb.files.length === 1, JSON.stringify([ta.files.length, tb.files.length, api.listRoots()]));
    const keyA = ta.files[0].zoteroAttachmentKey, keyB = tb.files[0].zoteroAttachmentKey;
    await assert('copies have separate identities', keyA !== keyB);
    const att = await Zotero.Items.getByLibraryAndKeyAsync(rootA.libraryID, keyA);
    const parent = new Zotero.Item('journalArticle'); parent.libraryID = rootA.libraryID; parent.setField('title', 'MultiRoot smoke paper');
    parent.setCollections([Zotero.Collections.getByLibraryAndKey(rootA.libraryID, rootA.collectionKey).id]); await parent.saveTx();
    att.parentID = parent.id; await att.saveTx(); await api.scanNow();
    const annotation = new Zotero.Item('annotation'); annotation.libraryID = rootA.libraryID; annotation.parentID = att.id;
    annotation.annotationType = 'highlight'; annotation.annotationText = 'smoke annotation'; annotation.annotationComment = 'preserve me';
    annotation.annotationColor = '#ffff00'; annotation.annotationPageLabel = '1'; annotation.annotationSortIndex = '00000|000000|00000';
    annotation.annotationPosition = JSON.stringify({ pageIndex: 0, rects: [[10,10,20,20]] }); await annotation.saveTx();
    const sub = PathUtils.join(a, 'Sub'); await IOUtils.makeDirectory(sub, { ignoreExisting: true });
    const movedA = PathUtils.join(sub, 'original.pdf'); await IOUtils.move(fileA, movedA, { noOverwrite: true }); await api.scanNow();
    await assert('local move relinks original attachment', norm(await att.getFilePathAsync()) === norm(movedA), String(await att.getFilePathAsync()));
    await assert('annotation identity preserved after local move', Zotero.Items.get(annotation.id).parentID === att.id);
    await api.setEnabled(idA, false);
    const child = Zotero.Collections.getByParent(Zotero.Collections.getByLibraryAndKey(rootA.libraryID, rootA.collectionKey).id, rootA.libraryID).find(c => c.name === 'Sub');
    child.name = 'RenamedWhilePaused'; await child.saveTx();
    await assert('paused leaves local folder untouched', await IOUtils.exists(sub));
    await api.setEnabled(idA, true);
    const resumedPath = PathUtils.join(a, 'RenamedWhilePaused', 'original.pdf');
    await assert('resume replays Zotero directory rename', await IOUtils.exists(resumedPath), JSON.stringify(api.listRoots()));
    const target = PathUtils.join(b, 'transferred.pdf'); await IOUtils.move(resumedPath, target, { noOverwrite: true }); await api.scanNow();
    ta = await track(idA); tb = await track(idB);
    await assert('cross-root move preserves key', !ta.files.some(r => r.zoteroAttachmentKey === keyA) && tb.files.some(r => r.zoteroAttachmentKey === keyA), JSON.stringify([ta.files,tb.files]));
    await assert('cross-root move preserves annotation', Zotero.Items.get(annotation.id).parentID === att.id && norm(await att.getFilePathAsync()) === norm(target));
    await api.setEnabled(idB, false);
    parent.deleted = true; await parent.saveTx();
    await assert('paused trash does not delete file', await IOUtils.exists(target));
    await api.setEnabled(idB, true);
    await assert('resume propagates Zotero trash recoverably', !await IOUtils.exists(target) && await IOUtils.exists(PathUtils.join(b, '.zotero-watch-trash')), JSON.stringify(api.listRoots()));
    parent.deleted = false; await parent.saveTx(); att.deleted = false; await att.saveTx(); await api.scanNow();
    await assert('Zotero restore returns linked PDF', !!await att.getFilePathAsync() && await IOUtils.exists(await att.getFilePathAsync()), String(await att.getFilePathAsync()));
    await IOUtils.remove(fileB); await api.scanNow();
    const copyAtt = await Zotero.Items.getByLibraryAndKeyAsync(rootB.libraryID, keyB);
    await assert('local deletion trashes corresponding item only', copyAtt.deleted && !parent.deleted,
      JSON.stringify({ copyDeleted: copyAtt.deleted, parentDeleted: parent.deleted, fileExists: await IOUtils.exists(fileB), roots: api.listRoots(), tracking: await track(idB),
        service: manager?.engines.get(idB)?.service().getStats(), config: api.getOptions(idB),
        corePref: manager?.contexts.get(idB)?.context.Zotero.Prefs.get('extensions.zotero.watchFolder.diskDeleteSync', true) }));
    const treeA = PathUtils.join(a, 'Tree'), treeB = PathUtils.join(b, 'Tree');
    await IOUtils.makeDirectory(PathUtils.join(treeA, 'Empty'), { createAncestors: true });
    await IOUtils.write(PathUtils.join(treeA, 'tree.pdf'), pdf); await api.scanNow();
    ta = await track(idA);
    const treeRecord = ta.collections.find(r => r.localPath === 'Tree');
    const treeFile = ta.files.find(r => r.localPath === 'Tree/tree.pdf');
    const treeCollection = Zotero.Collections.getByLibraryAndKey(rootA.libraryID, treeRecord.zoteroCollectionKey);
    await api.setEnabled(idA, false); await api.setEnabled(idB, false);
    treeCollection.parentID = Zotero.Collections.getByLibraryAndKey(rootB.libraryID, rootB.collectionKey).id; await treeCollection.saveTx();
    await api.setEnabled(idA, true); await api.setEnabled(idB, true); await api.scanNow();
    await assert('Zotero cross-root directory move includes empty child', !await IOUtils.exists(treeA) && await IOUtils.exists(PathUtils.join(treeB, 'Empty')), JSON.stringify(api.listRoots()));
    ta = await track(idA); tb = await track(idB);
    await assert('directory transfer retains original collection and attachment keys', !ta.collections.some(r => r.zoteroCollectionKey === treeCollection.key)
      && tb.collections.some(r => r.zoteroCollectionKey === treeCollection.key) && tb.files.some(r => r.zoteroAttachmentKey === treeFile.zoteroAttachmentKey));
    await IOUtils.move(treeB, treeA, { noOverwrite: true }); await api.scanNow();
    ta = await track(idA); tb = await track(idB);
    await assert('local cross-root directory move preserves collection identity', ta.collections.some(r => r.zoteroCollectionKey === treeCollection.key)
      && !tb.collections.some(r => r.zoteroCollectionKey === treeCollection.key), JSON.stringify(api.listRoots()));
    const storedParent = new Zotero.Item('journalArticle'); storedParent.libraryID = rootA.libraryID;
    storedParent.setField('title', 'Stored attachment repeated recovery');
    storedParent.setCollections([Zotero.Collections.getByLibraryAndKey(rootA.libraryID, rootA.collectionKey).id]); await storedParent.saveTx();
    const storedAtt = await Zotero.Attachments.importFromFile({ file: PathUtils.join(base, 'fixture.pdf'), parentItemID: storedParent.id });
    await api.scanNow();
    const internalPath = await storedAtt.getFilePathAsync();
    for (let cycle = 1; cycle <= 3; cycle++) {
      const before = (await track(idA)).files.find(r => r.zoteroAttachmentKey === storedAtt.key);
      await assert('stored mapping available before cycle ' + cycle, !!before);
      const mirror = PathUtils.join(a, ...before.localPath.split('/'));
      storedParent.deleted = true; await storedParent.saveTx(); await api.scanNow();
      await assert('stored delete cycle ' + cycle + ' preserves internal source', !await IOUtils.exists(mirror) && await IOUtils.exists(internalPath));
      storedParent.deleted = false; await storedParent.saveTx(); storedAtt.deleted = false; await storedAtt.saveTx(); await api.scanNow();
      const after = (await track(idA)).files.find(r => r.zoteroAttachmentKey === storedAtt.key);
      await assert('stored restore cycle ' + cycle + ' retains full mapping', !!after && !!after.canonicalCollectionKey && after.lastSyncedSize > 0
        && await IOUtils.exists(PathUtils.join(a, ...after.localPath.split('/'))) && await storedAtt.getFilePathAsync() === internalPath, JSON.stringify(after));
    }
    storedParent.setField('date', '2018'); storedParent.setCreators([{ firstName: 'R', lastName: 'Cantoro', creatorType: 'author' }]); await storedParent.saveTx();
    await api.setOptions(idA, { autoRename: true, renamePattern: '{title} - {year} - {firstCreator}' }); await api.scanNow();
    const named = (await track(idA)).files.find(r => r.zoteroAttachmentKey === storedAtt.key);
    await assert('already restored mirror adopts current naming template', named?.localPath === 'Stored attachment repeated recovery - 2018 - Cantoro.pdf'
      && await storedAtt.getFilePathAsync() === internalPath && await IOUtils.exists(PathUtils.join(a, ...named.localPath.split('/'))), JSON.stringify(named));
    storedParent.deleted = true; await storedParent.saveTx(); await api.scanNow();
    storedParent.deleted = false; await storedParent.saveTx(); storedAtt.deleted = false; await storedAtt.saveTx(); await api.scanNow();
    const namedAgain = (await track(idA)).files.find(r => r.zoteroAttachmentKey === storedAtt.key);
    await assert('repeated restore keeps current template and original identity', namedAgain?.localPath === named.localPath && await IOUtils.exists(PathUtils.join(a, ...namedAgain.localPath.split('/'))));
    const topB = Zotero.Collections.getByLibraryAndKey(rootB.libraryID, rootB.collectionKey); topB.name = 'B-renamed'; await topB.saveTx(); await api.scanNow();
    const renamedB = PathUtils.join(run, 'papers', 'B-renamed');
    await assert('root rename updates disk and config', await IOUtils.exists(renamedB) && norm(api.listRoots().find(r => r.id === idB).path) === norm(renamedB));
    const crossDrive = PathUtils.join('D:\\Temp\\zotero-watch-folder-multiroot-test', 'run-' + Date.now());
    await IOUtils.makeDirectory(crossDrive, { createAncestors: true });
    const idC = await api.addDirectory(crossDrive);
    await api.setOptions(idC, { autoRetrieveMetadata: false, pollInterval: 3600 });
    const rootC = api.listRoots().find(r => r.id === idC), liveParent = att.parentItem;
    liveParent.setCollections([Zotero.Collections.getByLibraryAndKey(rootC.libraryID, rootC.collectionKey).id]); await liveParent.saveTx(); await api.scanNow();
    const movedAcrossDrive = await att.getFilePathAsync();
    await assert('real F to D transfer retains attachment and annotation', norm(movedAcrossDrive).startsWith(norm(crossDrive) + '/')
      && await IOUtils.exists(movedAcrossDrive) && Zotero.Items.get(annotation.id).parentID === att.id, JSON.stringify({ path: movedAcrossDrive, roots: api.listRoots() }));
    await api.detach(idC); await assert('cross-drive detach preserves file', await IOUtils.exists(movedAcrossDrive));
    await api.detach(idA); await assert('detach preserves directory', await IOUtils.exists(a) && api.listRoots().length === 1);
    await IOUtils.writeJSON(resultPath, { results: liveResults, error: null, completed: true }, { tmpPath: resultPath + '.tmp' });
  } catch (e) {
    await IOUtils.writeJSON(resultPath, { results: liveResults, error: String(e.stack || e), completed: true }, { tmpPath: resultPath + '.tmp' });
  }
}
