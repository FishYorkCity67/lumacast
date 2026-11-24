'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Finds ffmpeg.exe: explicit setting, bundled copy, PATH, then winget's install dir.
function findFfmpeg(preferred) {
  const candidates = [];
  if (preferred) candidates.push(preferred);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', 'ffmpeg.exe'));
  candidates.push(path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe'));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'ffmpeg.exe'));
  }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    candidates.push(path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
    const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const pkg of fs.readdirSync(pkgs)) {
        if (!/ffmpeg/i.test(pkg)) continue;
        for (const sub of fs.readdirSync(path.join(pkgs, pkg))) {
          candidates.push(path.join(pkgs, pkg, sub, 'bin', 'ffmpeg.exe'));
        }
      }
    } catch { /* winget not used */ }
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* keep looking */ }
  }
  return null;
}

function ffmpegVersion(bin) {
  try {
    const out = execFileSync(bin, ['-hide_banner', '-version'], { windowsHide: true, timeout: 8000 }).toString();
    return (out.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown';
  } catch {
    return null;
  }
}

module.exports = { findFfmpeg, ffmpegVersion };
