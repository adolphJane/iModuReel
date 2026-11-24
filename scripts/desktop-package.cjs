const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function installMacPackage(file, target) {
  const command = (name, args) => execFileSync(name, args, { timeout: 180000, stdio: 'pipe' });
  command('/usr/bin/hdiutil', ['verify', file]);
  const mount = fs.mkdtempSync(path.join(path.dirname(target), 'Mounted disk image '));
  let attached = false;
  try {
    command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, file]);
    attached = true;
    const installed = path.join(target, 'iModuReel.app');
    const source = path.join(mount, 'iModuReel.app');
    assert.ok(fs.statSync(source).isDirectory(), 'DMG 内找不到 iModuReel.app');
    fs.mkdirSync(target, { recursive: true });
    fs.rmSync(installed, { recursive: true, force: true });
    command('/usr/bin/ditto', [source, installed]);
    return path.join(installed, 'Contents', 'MacOS', 'iModuReel');
  } finally {
    if (attached) command('/usr/bin/hdiutil', ['detach', mount, '-quiet']);
    fs.rmdirSync(mount);
  }
}

function installWindowsPackage(file, target) {
  execFileSync(file, ['/S', '/D=' + target], {
    // NSIS reads the last /D argument verbatim, including spaces in the directory.
    argv0: `"${file}"`,
    windowsVerbatimArguments: true,
    timeout: 180000,
    stdio: 'inherit',
  });
  return path.join(target, 'iModuReel.exe');
}

function installDesktopPackage(file, target) {
  const extension = path.extname(file).toLowerCase();
  const expected = { '.dmg': 'darwin', '.exe': 'win32' }[extension];
  assert.ok(expected && process.platform === expected, '请在 macOS 验收 DMG，或在 Windows 验收 NSIS 安装包');
  assert.ok(fs.statSync(file).isFile(), '找不到待验收的安装包');
  const executable = extension === '.dmg' ? installMacPackage(file, target) : installWindowsPackage(file, target);
  assert.ok(fs.statSync(executable).isFile(), '安装后在指定目录找不到 iModuReel');
  return executable;
}

function installedArchive(executable) {
  return process.platform === 'darwin'
    ? path.join(path.dirname(executable), '..', 'Resources', 'app.asar')
    : path.join(path.dirname(executable), 'resources', 'app.asar');
}

module.exports = { installDesktopPackage, installedArchive };
