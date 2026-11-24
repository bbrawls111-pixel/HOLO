// Окно входа должно выглядеть как обычный Google Chrome: Google блокирует вход, если видит «голый»
// Chromium (Electron). Проверено на рандомном gmail: с этими доработками Google пускает к вводу пароля.
// Дополняем то, чего у Electron нет: бренд «Google Chrome» в navigator.userAgentData и объекты
// chrome.app / chrome.csi / chrome.loadTimes / chrome.runtime, которые есть в настоящем Chrome.
const { webFrame } = require('electron');

const FULL = process.versions.chrome;
const MAJOR = FULL.split('.')[0];

webFrame.executeJavaScript(`(() => {
  const MAJOR = ${JSON.stringify(MAJOR)}, FULL = ${JSON.stringify(FULL)};
  const brands = [{ brand: 'Google Chrome', version: MAJOR }, { brand: 'Chromium', version: MAJOR }, { brand: 'Not)A;Brand', version: '24' }];
  const fullList = [{ brand: 'Google Chrome', version: FULL }, { brand: 'Chromium', version: FULL }, { brand: 'Not)A;Brand', version: '24.0.0.0' }];
  const uad = navigator.userAgentData;
  if (uad) {
    const proto = Object.getPrototypeOf(uad);
    const high = proto.getHighEntropyValues;
    const json = proto.toJSON;
    try { Object.defineProperty(proto, 'brands', { get: () => brands, configurable: true }); } catch {}
    proto.getHighEntropyValues = function (hints) {
      return high.call(this, hints).then((v) => ({ ...v, brands, fullVersionList: fullList, uaFullVersion: FULL }));
    };
    proto.toJSON = function () { return { ...(json ? json.call(this) : {}), brands }; };
  }
  const c = window.chrome || {};
  if (!c.app) c.app = {
    isInstalled: false,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    getDetails() { return null; }, getIsInstalled() { return false; }, runningState() { return 'cannot_run'; },
  };
  const t0 = performance.timeOrigin / 1000;
  if (!c.csi) c.csi = () => ({ onloadT: Date.now(), startE: Math.floor(performance.timeOrigin), pageT: performance.now(), tran: 15 });
  if (!c.loadTimes) c.loadTimes = () => ({
    requestTime: t0, startLoadTime: t0, commitLoadTime: t0 + 0.05, finishDocumentLoadTime: t0 + 0.2, finishLoadTime: t0 + 0.3,
    firstPaintTime: t0 + 0.25, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true,
    wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2',
  });
  if (!c.runtime) c.runtime = { OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformOs: {}, RequestUpdateCheckStatus: {}, connect() {}, sendMessage() {} };
  try { Object.defineProperty(window, 'chrome', { value: c, configurable: true, writable: true }); } catch {}
})()`);
