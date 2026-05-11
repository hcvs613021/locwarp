// electron-builder afterPack hook.
//
// Strips macOS xattrs (FinderInfo, fileprovider, quarantine, etc.) from
// the freshly-built .app *before* electron-builder runs codesign. The
// Electron 30 zip extracted from ~/Library/Caches/electron carries a
// FinderInfo xattr on the bundle's root dir; codesign then bails with
// "resource fork, Finder information, or similar detritus not allowed"
// when --options runtime is enabled.
//
// `xattr -cr` is recursive. We also explicitly clear the bundle dir
// itself because -r only descends into children, not the start dir.

const { execSync } = require('child_process')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  try {
    execSync(`xattr -cr "${appPath}"`)
    execSync(`xattr -c "${appPath}"`)
    console.log(`[afterPack] stripped xattrs from ${appPath}`)
  } catch (e) {
    console.error(`[afterPack] xattr strip failed:`, e.message)
    throw e
  }
}
