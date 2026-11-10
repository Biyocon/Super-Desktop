const { build } = require('./package.json');

// Selected explicitly for Windows targets by build-desktop-release.mjs.
// appId determines NSIS upgrade/uninstall identity; never reuse PI-Desktop's id.
module.exports = {
  ...build,
  appId: 'io.github.biyocon.super-desktop',
  extraMetadata: { ...build.extraMetadata, name: 'super-desktop', superDesktopReleaseStage: 'internal' },
  win: { ...build.win, executableName: 'Super-Desktop', artifactName: 'Super-Desktop-${version}-${arch}.${ext}' },
  nsis: { ...build.nsis, shortcutName: 'Super-Desktop', uninstallDisplayName: 'Super-Desktop', deleteAppDataOnUninstall: false, artifactName: 'Super-Desktop-Setup-${version}-${arch}.${ext}' },
  portable: { ...build.portable, artifactName: 'Super-Desktop-Portable-${version}-${arch}.${ext}' },
};
