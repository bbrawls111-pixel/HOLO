// Рисует иконку приложения (512×512 PNG) из логотипа Holo: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#16122b"/><stop offset="1" stop-color="#07070c"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.45" r="0.55">
      <stop offset="0" stop-color="#7c5cff" stop-opacity="0.45"/><stop offset="1" stop-color="#7c5cff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="a" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#c2adff"/><stop offset="1" stop-color="#5a2de0"/>
    </linearGradient>
    <linearGradient id="b" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect width="512" height="512" rx="112" fill="url(#glow)"/>
  <g transform="translate(76 66) scale(9)">
    <path d="M20 2 35.6 11v18L20 38 4.4 29V11L20 2Z" fill="url(#a)"/>
    <path d="M20 2 35.6 11 20 20 4.4 11 20 2Z" fill="url(#b)" opacity=".45"/>
    <path d="M20 20v18" stroke="#fff" stroke-opacity=".35" stroke-width=".6"/>
    <path d="m13 15.5 7 4 7-4" stroke="#fff" stroke-opacity=".75" stroke-width="1.6" stroke-linecap="round" fill="none"/>
  </g>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, useContentSize: true });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`,
  ));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, 'icon.png');
  fs.writeFileSync(out, img.resize({ width: 512, height: 512 }).toPNG());
  console.log('icon:', out);
  app.exit(0);
});
