const { contextBridge, ipcRenderer } = require('electron');
const invoke = method => (...args) => {
  if (args.length) return Promise.reject(new TypeError('Companion methods accept no arguments'));
  return ipcRenderer.invoke('companion:v1:invoke', { method });
};
const invokeWindow = action => (...args) => {
  if (args.length) return Promise.reject(new TypeError('Companion window methods accept no arguments'));
  return ipcRenderer.invoke('companion:v1:window', { action });
};
const subscribe = channel => listener => {
  if (typeof listener !== 'function') throw new TypeError('Listener required');
  const wrapper = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapper);
  // A status/log read after listener registration closes the subscription-vs-current-state race.
  void ipcRenderer.invoke('companion:v1:invoke', { method: channel.endsWith('status') ? 'getStatus' : 'getLogs' })
    .then(value => { if (active) listener(value); }).catch(() => {});
  let active = true;
  return () => { active = false; ipcRenderer.removeListener(channel, wrapper); };
};
const subscribeWindow = listener => {
  if (typeof listener !== 'function') throw new TypeError('Listener required');
  const wrapper = (_event, value) => listener(value);
  ipcRenderer.on('companion:v1:window-state', wrapper);
  void ipcRenderer.invoke('companion:v1:window', { action: 'getState' })
    .then(value => { if (active) listener(value); }).catch(() => {});
  let active = true;
  return () => { active = false; ipcRenderer.removeListener('companion:v1:window-state', wrapper); };
};
const invokeProduct = method => (args) => {
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    return Promise.reject(new TypeError('Companion product args must be a plain object'));
  }
  return ipcRenderer.invoke('companion:v1:product', args === undefined ? { method } : { method, args });
};
const invokeModel = method => (...args) => {
  if (args.length) return Promise.reject(new TypeError('Companion model methods accept no arguments'));
  return ipcRenderer.invoke('companion:v1:model', { method });
};
const subscribeProductEvent = listener => {
  if (typeof listener !== 'function') throw new TypeError('Listener required');
  const wrapper = (_event, value) => listener(value);
  ipcRenderer.on('companion:v1:product-event', wrapper);
  return () => { ipcRenderer.removeListener('companion:v1:product-event', wrapper); };
};
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('companionBridge', Object.freeze({
    bridgeVersion: 1,
    getStatus: invoke('getStatus'), startAnalyzer: invoke('startAnalyzer'), stopAnalyzer: invoke('stopAnalyzer'),
    openAnalyzer: invoke('openAnalyzer'), getLogs: invoke('getLogs'),
    onStatus: subscribe('companion:v1:status'), onLogs: subscribe('companion:v1:logs'),
  }));
  contextBridge.exposeInMainWorld('companionWindow', Object.freeze({
    getState: invokeWindow('getState'),
    minimize: invokeWindow('minimize'),
    toggleMaximize: invokeWindow('toggleMaximize'),
    toggleFullscreen: invokeWindow('toggleFullscreen'),
    exitFullscreen: invokeWindow('exitFullscreen'),
    close: invokeWindow('close'),
    onState: subscribeWindow,
  }));
  contextBridge.exposeInMainWorld('companionProduct', Object.freeze({
    version: 1,
    getCompanionState: invokeProduct('getCompanionState'),
    savePreferences: invokeProduct('savePreferences'),
    runEnvCheck: invokeProduct('runEnvCheck'),
    validateInstallDir: invokeProduct('validateInstallDir'),
    pickInstallDir: invokeProduct('pickInstallDir'),
    reconnectExistingInstall: invokeProduct('reconnectExistingInstall'),
    verifyBangumiAccount: invokeProduct('verifyBangumiAccount'),
    testAiConnection: invokeProduct('testAiConnection'),
    installAndExtract: invokeProduct('installAndExtract'),
    configureAndStartAnalyzer: invokeProduct('configureAndStartAnalyzer'),
    startAnalyzerSync: invokeProduct('startAnalyzerSync'),
    getSyncStatus: invokeProduct('getSyncStatus'),
    cancelSync: invokeProduct('cancelSync'),
    finishFirstRun: invokeProduct('finishFirstRun'),
    getMaintenanceOverview: invokeProduct('getMaintenanceOverview'),
    listBackups: invokeProduct('listBackups'),
    createBackup: invokeProduct('createBackup'),
    restoreBackup: invokeProduct('restoreBackup'),
    runIntegrityCheck: invokeProduct('runIntegrityCheck'),
    pickUpdateZip: invokeProduct('pickUpdateZip'),
    checkUpdate: invokeProduct('checkUpdate'),
    applySafeUpdate: invokeProduct('applySafeUpdate'),
    exportDiagnostics: invokeProduct('exportDiagnostics'),
    uninstallCompanion: invokeProduct('uninstallCompanion'),
    onProductEvent: subscribeProductEvent,
  }));
  contextBridge.exposeInMainWorld('companionModel', Object.freeze({
    version: 1,
    getStatus: invokeModel('getStatus'),
    importCubismCore: invokeModel('importCubismCore'),
    loadPinkSakuraBundle: invokeModel('loadPinkSakuraBundle'),
  }));
}
