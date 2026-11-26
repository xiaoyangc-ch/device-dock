import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

if (process.platform !== 'darwin') {
  throw new Error('ad-hoc macOS signing must run on macOS')
}

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(
  await fs.readFile(path.join(root, 'package.json'), 'utf8'),
)
const productName = String(pkg.productName || pkg.name)
const appName = `${productName}.app`
const releaseDir = path.join(root, 'release', String(pkg.version))
let appPath = ''
for (const entry of await fs.readdir(releaseDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const candidate = path.join(releaseDir, entry.name, appName)
  try {
    await fs.access(candidate)
    appPath = candidate
    break
  } catch {
    // 继续查找 electron-builder 生成的应用目录
  }
}
if (!appPath) throw new Error(`未找到构建后的 ${appName}`)

const arch = execFileSync(
  'lipo',
  ['-archs', path.join(appPath, 'Contents', 'MacOS', productName)],
  { encoding: 'utf8' },
)
  .trim()
  .split(/\s+/)[0]
const out = path.join(
  releaseDir,
  `${productName}-${pkg.version}-mac-${arch}-adhoc.dmg`,
)

execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
  stdio: 'inherit',
})
execFileSync(
  'codesign',
  ['--verify', '--deep', '--strict', '--verbose=2', appPath],
  { stdio: 'inherit' },
)

const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'devicedock-adhoc-'))
try {
  execFileSync('ditto', [appPath, path.join(stage, appName)], {
    stdio: 'inherit',
  })
  await fs.symlink('/Applications', path.join(stage, 'Applications'))
  execFileSync(
    'hdiutil',
    [
      'create',
      '-quiet',
      '-volname',
      `${productName} ${pkg.version}`,
      '-srcfolder',
      stage,
      '-ov',
      '-format',
      'UDZO',
      out,
    ],
    { stdio: 'inherit' },
  )
  execFileSync('hdiutil', ['verify', out], { stdio: 'inherit' })
  console.log(`[adhoc] ${out}`)
} finally {
  await fs.rm(stage, { recursive: true, force: true })
}
