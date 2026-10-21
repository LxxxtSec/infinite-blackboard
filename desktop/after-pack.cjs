'use strict';

// electron-builder leaves the Electron helper executables with an invalid
// linker signature after resources are added. Ad-hoc sign the finished bundle so
// local launch and right-click Open work; real distribution still needs a
// Developer ID certificate + notarization.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const product = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${product}.app`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`[desktop] ad-hoc signed ${appPath}`);
};
