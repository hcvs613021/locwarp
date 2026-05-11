// electron-builder afterSign hook — runs after codesign succeeds and
// before .dmg packaging. Calls @electron/notarize directly with API key
// credentials (path-to-.p8 + key id + issuer id) so we can stay clear
// of electron-builder's own notarize wrapper, which currently mixes the
// env-based detection paths and bails with "Cannot use password
// credentials, API key credentials and keychain credentials at once".

const { notarize } = require('@electron/notarize')

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const apiKey = process.env.APPLE_API_KEY
  const apiKeyId = process.env.APPLE_API_KEY_ID
  const apiIssuer = process.env.APPLE_API_ISSUER

  if (!apiKey || !apiKeyId || !apiIssuer) {
    console.log('[afterSign] APPLE_API_* not set — skipping notarization (ad-hoc signed dmg)')
    return
  }

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  console.log(`[afterSign] notarizing ${appPath} via API key ${apiKeyId}`)
  console.log('[afterSign] this will take 1-5 minutes (talks to Apple notarytool service)…')

  // Note: do NOT pass `teamId` here. @electron/notarize's argument
  // classifier counts the presence of teamId as "password credentials",
  // so API key + teamId trips "Cannot use ... credentials at once".
  // The API key itself is already scoped to the team via its issuer.
  await notarize({
    appPath,
    appleApiKey: apiKey,
    appleApiKeyId: apiKeyId,
    appleApiIssuer: apiIssuer,
  })

  console.log('[afterSign] notarization complete; stapling ticket')
  // electron-builder will run `xcrun stapler staple` itself on the dmg
  // later; the .app is already stapled by notarize() when ticketed.
}
