/**
 * Chinese management pane for the multi-root adapter.
 * Upstream preferences and all core sync modules remain independent of this UI.
 * Each asynchronous operation captures its root ID before awaiting; changing
 * the selected card cannot redirect an in-flight write to another root.
 */
(function () {
    'use strict';

    const HTML_NS = 'http://www.w3.org/1999/xhtml';
    const PANEL_ID = 'watch-folder-multi-root-preferences';
    const FIELD_KEYS = [
        'mode', 'autoRetrieveMetadata', 'metadataFallback', 'autoRename',
        'renamePattern', 'maxFilenameLength', 'pollInterval',
        'maxConcurrentMetadata', 'adaptivePolling', 'fileTypes',
        'smartRulesEnabled', 'smartRules',
    ];
    const BOOLEAN_KEYS = new Set([
        'autoRetrieveMetadata', 'metadataFallback', 'autoRename',
        'adaptivePolling', 'smartRulesEnabled',
    ]);
    const NUMBER_LIMITS = {
        maxFilenameLength: [30, 240],
        pollInterval: [2, 3600],
        maxConcurrentMetadata: [1, 10],
    };
    const STATUS_LABELS = {
        watching: '监控中', running: '监控中', active: '监控中',
        syncing: '正在同步', scanning: '正在扫描', ready: '已就绪',
        idle: '等待下次扫描', paused: '已暂停', disabled: '已暂停',
        disconnected: '目录暂时不可访问', unavailable: '目录暂时不可访问',
        missing: '目录暂时不可访问', offline: '目录暂时不可访问',
        conflict: '存在待处理冲突', blocked: '需要处理',
        error: '同步遇到问题', starting: '正在启动',
    };
    let initialized = false;
    let disposed = false;
    let busy = false;
    let selectedID = null;
    let optionsDirty = false;
    let optionsEpoch = 0;
    let refreshEpoch = 0;
    let refreshTimer = null;
    let currentRoots = [];

    function $(id) { return document.getElementById(id); }
    function api() {
        const manager = Zotero.WatchFolderMultiRoot;
        if (!manager) throw new Error('多目录监控尚未启动，请重新打开设置，或重启 Zotero。');
        return manager;
    }
    function element(tag, text, className) {
        const node = document.createElementNS(HTML_NS, tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    }
    function message(text, isError = false) {
        if (disposed) return;
        const output = $('wfmr-message');
        if (!output) return;
        output.textContent = String(text || '');
        output.setAttribute('data-error', String(isError));
    }
    function reportError(error) {
        const text = error && error.message ? error.message : String(error);
        message(text, true);
        try { Zotero.logError(`[WatchFolderMultiRoot] preferences: ${text}`); } catch (_) {}
    }
    function confirm(text) {
        // Missing UI must not approve a destructive or discard action.
        if (!Services || !Services.prompt || typeof Services.prompt.confirm !== 'function') return false;
        return Services.prompt.confirm(window, '多目录监控', text);
    }
    function rootName(id) {
        const root = currentRoots.find(entry => entry.id === id);
        return root ? (root.name || root.path || root.id) : id;
    }
    function updateBusy() {
        const panel = $(PANEL_ID);
        if (!panel) return;
        for (const control of panel.querySelectorAll('button, input, select, textarea')) {
            control.disabled = busy;
        }
        const manager = Zotero.WatchFolderMultiRoot;
        for (const control of panel.querySelectorAll('[data-api-method]')) {
            const name = control.getAttribute('data-api-method');
            control.disabled = busy || !manager || typeof manager[name] !== 'function';
        }
    }
    function markDirty(value) {
        optionsDirty = value;
        const marker = $('wfmr-options-unsaved');
        if (marker) marker.hidden = !value;
    }
    function run(operation, successText) {
        if (busy || disposed) return Promise.resolve();
        busy = true;
        updateBusy();
        return Promise.resolve().then(operation).then(() => {
            if (successText) message(successText);
        }).catch(reportError).finally(async () => {
            busy = false;
            try { await refresh(); } catch (error) { reportError(error); }
            updateBusy();
        });
    }
    function button(label, handler, method) {
        const control = element('button', label);
        control.type = 'button';
        control.addEventListener('click', handler);
        if (method) control.setAttribute('data-api-method', method);
        return control;
    }
    function clear(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
    }
    function renderRoots(roots) {
        const list = $('wfmr-roots');
        if (!list) return;
        clear(list);
        const empty = $('wfmr-empty');
        if (empty) empty.hidden = roots.length !== 0;
        for (const root of roots) {
            const id = root.id;
            const card = element('section', undefined, 'wfmr-card');
            card.setAttribute('data-selected', String(id === selectedID));
            card.appendChild(element('div', root.name || root.path || id, 'wfmr-title'));
            card.appendChild(element('div', root.path || '尚未定位目录', 'wfmr-path'));
            const state = !root.enabled ? '已暂停' : (STATUS_LABELS[root.status] || String(root.status || '已启用'));
            card.appendChild(element('div', state, 'wfmr-status'));
            if (root.error) card.appendChild(element('div', String(root.error), 'wfmr-error'));
            const actions = element('div', undefined, 'wfmr-actions');
            actions.appendChild(button(id === selectedID ? '正在编辑设置' : '设置此目录', () => selectRoot(id)));
            actions.appendChild(button(root.enabled ? '暂停监控' : '恢复监控', () => setEnabled(id, !root.enabled), 'setEnabled'));
            actions.appendChild(button('重新定位…', () => reconnect(id), 'reconnect'));
            actions.appendChild(button('检查一致性', () => checkAndRepair(id), 'checkAndRepair'));
            actions.appendChild(button('重试元数据识别', () => retrieveMetadata(id), 'retrieveMetadata'));
            actions.appendChild(button('解除绑定…', () => detach(id), 'detach'));
            card.appendChild(actions);
            for (const conflict of root.conflicts || []) {
                const box = element('div', undefined, 'wfmr-conflict');
                box.appendChild(element('div', conflict.message || '两边出现不同修改，请选择保留哪一边。'));
                const choices = element('div', undefined, 'wfmr-actions');
                if (conflict.type === 'transfer') {
                    choices.appendChild(button('重试迁移', () => retryTransfer(id, conflict.id), 'resolveConflict'));
                } else if (conflict.type === 'ambiguousDirectoryMove') {
                    choices.appendChild(button('指定目录迁移目标（保留批注）', () => selectMoveTarget(id, conflict.id, true), 'resolveConflict'));
                } else if (conflict.type === 'ambiguousMove') {
                    choices.appendChild(button('指定迁移目标（保留批注）', () => selectMoveTarget(id, conflict.id), 'resolveConflict'));
                    choices.appendChild(button('按独立文件处理', () => separateFiles(id, conflict.id), 'resolveConflict'));
                } else {
                    choices.appendChild(button('保留本地的修改', () => resolveConflict(id, conflict.id, 'local'), 'resolveConflict'));
                    choices.appendChild(button('保留 Zotero 的修改', () => resolveConflict(id, conflict.id, 'zotero'), 'resolveConflict'));
                }
                box.appendChild(choices);
                card.appendChild(box);
            }
            list.appendChild(card);
        }
    }
    async function refresh() {
        if (disposed || !$(PANEL_ID)) return;
        const epoch = ++refreshEpoch;
        const roots = await api().listRoots();
        if (disposed || epoch !== refreshEpoch) return;
        if (!Array.isArray(roots)) throw new Error('监控目录列表读取失败。');
        currentRoots = roots;
        let changed = false;
        if (!roots.some(root => root.id === selectedID)) {
            selectedID = roots.length ? roots[0].id : null;
            markDirty(false);
            changed = true;
        }
        renderRoots(roots);
        const options = $('wfmr-options');
        if (options) options.hidden = !selectedID;
        if (selectedID) {
            const name = $('wfmr-options-name');
            if (name) name.textContent = rootName(selectedID);
            if (changed) await loadOptions(selectedID);
        }
        updateBusy();
    }
    async function loadOptions(id) {
        const epoch = ++optionsEpoch;
        const values = await api().getOptions(id);
        if (disposed || epoch !== optionsEpoch || id !== selectedID) return;
        for (const key of FIELD_KEYS) {
            const field = $(`wfmr-opt-${key}`);
            if (!field) continue;
            if (BOOLEAN_KEYS.has(key)) field.checked = values[key] === true;
            else field.value = values[key] === undefined || values[key] === null ? '' : String(values[key]);
        }
        markDirty(false);
    }
    function selectRoot(id) {
        if (busy || id === selectedID) return;
        if (optionsDirty && !confirm('当前目录的设置尚未保存。是否放弃这些修改，切换到另一个目录？')) return;
        selectedID = id;
        markDirty(false);
        return run(async () => {
            await loadOptions(id);
        });
    }
    async function pickDirectory(title, initialPath) {
        const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
        const picker = new FilePicker();
        picker.init(window, title, picker.modeGetFolder);
        if (initialPath) {
            try { picker.displayDirectory = initialPath; } catch (_) {}
        }
        const result = await picker.show();
        if (result !== picker.returnOK || !picker.file) return null;
        return typeof picker.file === 'object' && picker.file.path
            ? picker.file.path : String(picker.file);
    }
    function addDirectory() {
        return run(async () => {
            const path = await pickDirectory('选择要监控的本地目录');
            if (!path) return;
            await api().addDirectory(path);
            message('已添加监控目录。原有监控目录保持绑定。');
        });
    }
    function setEnabled(id, enabled) {
        return run(() => api().setEnabled(id, enabled), enabled ? '已恢复监控。' : '已暂停监控，绑定和文件均保留。');
    }
    function detach(id) {
        if (busy) return;
        if (!confirm(`解除“${rootName(id)}”的绑定？\n\n停止监控，并保留本地文件、Zotero 分类、论文条目和批注。之后两边可以独立管理。`)) return;
        return run(() => api().detach(id), '已解除绑定，两边内容均已保留。');
    }
    function reconnect(id) {
        return run(async () => {
            const root = currentRoots.find(entry => entry.id === id);
            const path = await pickDirectory('选择原监控目录现在的位置', root && root.path);
            if (!path) return;
            await api().reconnect(id, path);
            message('已更新该目录的位置，原绑定继续保留。');
        });
    }
    function scanNow() {
        return run(() => api().scanNow(), '本次同步检查已完成。暂停的目录不会自动恢复。');
    }
    function retrieveMetadata(id) {
        return run(async () => {
            const result = await api().retrieveMetadata(id);
            message(result && Number.isFinite(result.queued)
                ? `已将 ${result.queued} 个附件加入元数据识别队列。`
                : '已请求重新识别此目录的元数据。');
        });
    }
    function checkAndRepair(id) {
        return run(async () => {
            const result = await api().checkAndRepair(id);
            if (result && result.ok === false) {
                throw new Error(result.message || '未能完成一致性检查，请确认监控目录和对应分类可以访问。');
            }
            if (result && result.message) message(result.message);
            else if (result && Array.isArray(result.findings)) message(`一致性检查完成，发现 ${result.findings.length} 项需要处理的问题。本次检查没有修改文件或文库。`);
            else message('已完成此目录的一致性检查，本次检查没有修改文件或文库。');
        });
    }
    function resolveConflict(id, conflictID, side) {
        if (busy) return;
        const label = side === 'local' ? '本地' : 'Zotero';
        if (!confirm(`将以${label}的修改处理这个冲突，并更新另一边。是否继续？`)) return;
        return run(() => api().resolveConflict(id, conflictID, side), '已处理所选冲突。');
    }
    function retryTransfer(id, conflictID) {
        return run(() => api().resolveConflict(id, conflictID, 'zotero'), '已重试所选迁移。');
    }
    function selectMoveTarget(id, conflictID, directory = false) {
        return run(async () => {
            const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
            const picker = new FilePicker();
            picker.init(window, directory ? '选择原目录移动后的文件夹' : '选择原论文移动后的 PDF 文件', directory ? picker.modeGetFolder : picker.modeOpen);
            if (!directory) picker.appendFilter('PDF 文件', '*.pdf');
            const result = await picker.show();
            if (result !== picker.returnOK || !picker.file) return;
            const path = typeof picker.file === 'object' && picker.file.path
                ? picker.file.path : String(picker.file);
            await api().resolveConflict(id, conflictID, 'zotero', path);
            message('已按所选目标处理迁移，继续使用原论文条目和批注。');
        });
    }
    function separateFiles(id, conflictID) {
        if (busy) return;
        if (!confirm('按独立文件处理这个冲突？\n\n原位置记录移入 Zotero 回收站，新位置分别导入，不继承原批注。')) return;
        return run(() => api().resolveConflict(id, conflictID, 'local'), '已选择按独立文件处理。');
    }
    function readOptions() {
        const values = {};
        for (const key of FIELD_KEYS) {
            const field = $(`wfmr-opt-${key}`);
            if (!field) throw new Error('设置页面尚未完成加载。');
            if (BOOLEAN_KEYS.has(key)) values[key] = field.checked === true;
            else if (NUMBER_LIMITS[key]) {
                const value = Number(field.value);
                const [min, max] = NUMBER_LIMITS[key];
                if (!Number.isInteger(value) || value < min || value > max) {
                    field.focus();
                    throw new Error(`请为“${field.previousElementSibling ? field.previousElementSibling.textContent : key}”填写 ${min} 到 ${max} 之间的整数。`);
                }
                values[key] = value;
            } else values[key] = String(field.value || '').trim();
        }
        if (!['mode1', 'mode2', 'mode3'].includes(values.mode)) throw new Error('请选择有效的同步模式。');
        if (!values.renamePattern) throw new Error('文件命名格式不能为空。');
        values.fileTypes = 'pdf';
        let rules;
        try { rules = JSON.parse(values.smartRules || '[]'); }
        catch (_) { throw new Error('自动整理规则不是有效的 JSON。'); }
        if (!Array.isArray(rules)) throw new Error('自动整理规则必须是 JSON 数组。');
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)
                || !rule.id || !rule.name || !Array.isArray(rule.conditions)
                || !Array.isArray(rule.actions) || !rule.actions.length) {
                throw new Error(`第 ${i + 1} 条自动整理规则格式不完整：需要 id、name、conditions 数组和非空的 actions 数组。`);
            }
        }
        values.smartRules = JSON.stringify(rules);
        return values;
    }
    function saveOptions() {
        if (busy || !selectedID) return;
        const id = selectedID;
        let values;
        try { values = readOptions(); } catch (error) { reportError(error); return; }
        return run(async () => {
            const manager = api();
            if (typeof manager.setOptions === 'function') {
                await manager.setOptions(id, values);
            } else {
                // Older adapters write the mode last so transitions see the
                // other options. Current adapters commit the whole form once.
                for (const key of FIELD_KEYS.filter(key => key !== 'mode')) {
                    await manager.setOption(id, key, values[key]);
                }
                await manager.setOption(id, 'mode', values.mode);
            }
            if (selectedID === id) {
                markDirty(false);
                await loadOptions(id);
            }
            message(`“${rootName(id)}”的设置已保存。`);
        });
    }
    function reloadOptions() {
        if (busy || !selectedID) return;
        if (optionsDirty && !confirm('重新读取会放弃当前尚未保存的设置，是否继续？')) return;
        const id = selectedID;
        return run(() => loadOptions(id));
    }
    function dispose() {
        disposed = true;
        ++refreshEpoch;
        ++optionsEpoch;
        if (refreshTimer !== null) window.clearInterval(refreshTimer);
        refreshTimer = null;
    }
    function init() {
        if (initialized || disposed || !$(PANEL_ID)) return;
        initialized = true;
        const options = $('wfmr-options');
        if (options) {
            options.addEventListener('input', () => markDirty(true));
            options.addEventListener('change', () => markDirty(true));
        }
        window.addEventListener('unload', dispose, { once: true });
        refresh().catch(reportError);
        refreshTimer = window.setInterval(() => {
            if (!busy && !disposed) refresh().catch(reportError);
        }, 5000);
    }

    window.WatchFolderMultiRootPrefs = {
        onLoad: init,
        addDirectory,
        scanNow,
        refresh: () => refresh().catch(reportError),
        saveOptions,
        reloadOptions,
    };
    document.addEventListener('load', function onPaneLoad(event) {
        if (event.target && event.target.id === PANEL_ID) {
            document.removeEventListener('load', onPaneLoad, true);
            init();
        }
    }, true);
})();
