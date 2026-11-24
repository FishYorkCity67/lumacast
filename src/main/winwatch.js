'use strict';
// Reports the focused window (process + title) so the renderer can run the
// Privacy Shield and auto-scene rules. Uses a tiny PowerShell helper, so no
// native modules are needed.
const { spawn } = require('child_process');
const EventEmitter = require('events');

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class LcFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@
$lastHandle = [IntPtr]::Zero; $lastLine = ''; $procName = ''
while ($true) {
  $h = [LcFg]::GetForegroundWindow()
  if ($h -ne $lastHandle) {
    $procId = 0; [void][LcFg]::GetWindowThreadProcessId($h, [ref]$procId)
    $procName = ''; try { $procName = (Get-Process -Id $procId).ProcessName } catch {}
    $lastHandle = $h
  }
  $sb = New-Object System.Text.StringBuilder 512
  [void][LcFg]::GetWindowText($h, $sb, 512)
  $line = $procName + [char]9 + $sb.ToString()
  if ($line -ne $lastLine) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $lastLine = $line }
  Start-Sleep -Milliseconds 350
}
`;

class WindowWatcher extends EventEmitter {
  constructor(ownProcessNames) {
    super();
    this.own = new Set(ownProcessNames.map((n) => n.toLowerCase()));
    this.child = null;
    this.current = { process: '', title: '' };
  }

  start() {
    if (this.child) return;
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const [proc, ...rest] = line.split('\t');
        const info = { process: proc || '', title: rest.join('\t') };
        info.own = this.own.has(info.process.toLowerCase());
        this.current = info;
        this.emit('focus', info);
      }
    });
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        if (this.wanted) this.restart = setTimeout(() => this.start(), 3000);
      }
    });
    this.wanted = true;
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restart);
    if (this.child) {
      const c = this.child;
      this.child = null;
      try { c.kill(); } catch { /* gone */ }
    }
  }
}

module.exports = { WindowWatcher };
