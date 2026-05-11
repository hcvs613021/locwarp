// electron-builder afterAllArtifactBuild — runs once all artifacts
// (.dmg, .zip, etc.) are written. We re-submit the .dmg to Apple
// notarytool: the .app inside is already stapled, but the DMG itself
// has its own hash that Gatekeeper checks separately when the user
// double-clicks the .dmg. Without this, downloading the .dmg shows
// "macOS cannot verify the developer of this disk image" the first
// time, even though the .app inside is fine.

const { execFileSync } = require('child_process')

exports.default = async function afterAllArtifactBuild(buildResult) {
  if (process.platform !== 'darwin') return

  const apiKey = process.env.APPLE_API_KEY
  const apiKeyId = process.env.APPLE_API_KEY_ID
  const apiIssuer = process.env.APPLE_API_ISSUER
  if (!apiKey || !apiKeyId || !apiIssuer) {
    console.log('[afterAllArtifactBuild] APPLE_API_* not set, skipping dmg notarization')
    return []
  }

  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'))
  for (const dmg of dmgs) {
    console.log(`[afterAllArtifactBuild] notarizing dmg ${dmg}`)
    execFileSync('xcrun', [
      'notarytool', 'submit', dmg,
      '--key', apiKey,
      '--key-id', apiKeyId,
      '--issuer', apiIssuer,
      '--wait',
    ], { stdio: 'inherit' })
    console.log(`[afterAllArtifactBuild] stapling dmg`)
    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
  }
  return []
}
