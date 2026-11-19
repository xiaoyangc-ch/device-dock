import { execSync } from 'node:child_process'

const pkg = await fs.readJson('package.json')
const electron = pkg.devDependencies.electron
delete pkg.devDependencies
delete pkg.allowScripts
pkg.electronVersion = electron
delete pkg.scripts
pkg.scripts = {
  start: 'electron main/index.js',
}
pkg.main = 'main/index.js'

await execSync('npm run build:main', { stdio: 'inherit' })
await execSync('npm run build:preload', { stdio: 'inherit' })
await execSync('npm run build:renderer', { stdio: 'inherit' })

// 只清要复制的两个目录：dist 里还有 vite 刚产出的 main/preload/renderer，
// 对整个 dist 做 emptyDir 会把本轮构建结果一起删掉
await fs.emptyDir('dist/build')
await fs.emptyDir('dist/resources')
await fs.copy('build', 'dist/build')
await fs.copy('resources', 'dist/resources')
await fs.remove('dist/node_modules')
await fs.remove('dist/package-lock.json')
cd('dist')

await fs.writeJson('package.json', pkg, {
  spaces: 2,
})

// 这里原来还有一步 `npm i --omit=dev`：dist 里没有 lockfile，装出来的版本不可复现，
// 而 electron-builder 的 files 只打包 main/preload/renderer，node_modules 根本用不上。
