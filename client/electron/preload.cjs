const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Рендерер не видит токен и не ходит в сеть напрямую: все запросы к серверу
// выполняет главный процесс (без CORS-префлайтов → меньше операций на сервере).
contextBridge.exposeInMainWorld('holo', {
  getSession: () => ipcRenderer.invoke('holo:getSession'),
  login: (serverUrl, login, password) => ipcRenderer.invoke('holo:login', { serverUrl, login, password }),
  logout: () => ipcRenderer.invoke('holo:logout'),
  setupInfo: (serverUrl) => ipcRenderer.invoke('holo:setupInfo', { serverUrl }),
  register: (serverUrl, code, login, password) =>
    ipcRenderer.invoke('holo:register', { serverUrl, code, login, password }),
  request: (method, path, body) => ipcRenderer.invoke('holo:request', { method, path, body }),
  upload: (opts) => ipcRenderer.invoke('holo:upload', opts),
  uploadAvatar: (data, mime) => ipcRenderer.invoke('holo:uploadAvatar', { data, mime }),
  fetchBinary: (path) => ipcRenderer.invoke('holo:fetchBinary', { path }),
  download: (fileId, name, version) => ipcRenderer.invoke('holo:download', { fileId, name, version }),
  openExternal: (url) => ipcRenderer.invoke('holo:openExternal', { url }),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  on: (channel, handler) => {
    const allowed = ['holo:event', 'holo:connection', 'holo:resync', 'holo:loggedOut', 'holo:presence'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
