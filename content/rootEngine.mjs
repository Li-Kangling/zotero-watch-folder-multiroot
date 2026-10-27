/**
 * One independently bundled upstream engine per configured watch root.
 * The outer manager owns timers and notifier routing; this entry deliberately
 * does not call index hooks or register a second preferences pane.
 */
import { getWatchFolderService, resetWatchFolderService } from './watchFolder.mjs';
import { getTrackingStore, resetTrackingStore } from './trackingStore.mjs';
import { initMetadataRetriever, shutdownMetadataRetriever } from './metadataRetriever.mjs';
import { shutdownDuplicateDetector } from './duplicateDetector.mjs';
import { getSyncCoordinator, resetSyncCoordinator } from './syncCoordinator.mjs';
import * as collectionWatcher from './collectionWatcher.mjs';
import * as canonicalPath from './canonicalPath.mjs';
import * as warningSink from './warningSink.mjs';
import * as suppressionResolver from './suppressionResolver.mjs';
import * as reconcile from './reconcile.mjs';
import * as storageStrategy from './storageStrategy.mjs';
import * as mirrorExecutor from './mirrorExecutor.mjs';
import { enumerateSyncRootAttachments } from './baseline.mjs';

export { canonicalPath, warningSink, suppressionResolver, reconcile, storageStrategy, mirrorExecutor };
export { scanFolderRecursive } from './fileScanner.mjs';
export { getFileHash } from './utils.mjs';
export { createFileRecord, createCollectionRecord, createTombstoneRecord, STATE } from './trackingStore.mjs';
export { relinkLinkedAttachment } from './mirrorExecutor.mjs';

let _service = null;
let _coordinator = null;
let _backfilled = false;

export function service() { return _service; }
export function store() { return _service?._trackingStore ?? null; }

/** Reconcile live stored PDFs restored before this version was installed. */
export async function recoverStoredRestores() {
  const syncRoot = await canonicalPath.resolveSyncRoot();
  const { attachments } = await enumerateSyncRootAttachments(syncRoot);
  for (const { attachment, item } of attachments) {
    if (!_service || item.deleted || attachment.deleted) continue;
    const record = store().getByAttachmentKey(attachment.key);
    if (record) { await _service._applyStoredMirrorName(attachment, record); continue; }
    if (store().findTombstoneByAttachmentKey(attachment.key)) continue;
    await _service._restoreUntrackedStoredAttachment(attachment);
  }
}

/** Initialize without running a baseline, scan, or polling timer. */
export async function initialize() {
  if (_service) return;
  getTrackingStore().maxFiles = Infinity; // Identity records are not an LRU cache.
  const retriever = await initMetadataRetriever();
  _service = getWatchFolderService();
  await _service.init();
  if (!_service._trackingStore?.dataFile) throw new Error('Root tracking store is unavailable');
  _service.setMetadataRetriever(retriever);
  _coordinator = getSyncCoordinator();
  await _coordinator.init(store());
  _service.setSyncCoordinator(_coordinator);
  // The manager serializes notifier deliveries; don't defer them outside its
  // queue, where another root could mutate identity before this one observes it.
  collectionWatcher.__test_setDebounceMs(0);
}

/** Activate the upstream coordinator; the manager starts its shared poll loop. */
export async function activate() {
  if (!_service) await initialize();
  await _coordinator.start();
  if (!_backfilled) {
    _backfilled = true;
    await _service.backfillStandaloneMetadata();
  }
}

/** Explicit scan, reusing all original per-file and per-scan guards. */
export async function scan() {
  if (_service) await _service.forceScan();
}

export async function shutdown() {
  if (_coordinator) await _coordinator.stop();
  resetSyncCoordinator();
  _coordinator = null;
  await resetWatchFolderService();
  _service = null;
  _backfilled = false;
  shutdownMetadataRetriever();
  shutdownDuplicateDetector();
  const tracking = getTrackingStore();
  await tracking.flush();
  tracking.destroy();
  resetTrackingStore();
}
