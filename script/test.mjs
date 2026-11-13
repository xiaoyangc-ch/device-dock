// 无第三方测试框架：esbuild 编译 src 下的 *.test.ts，再交给 node --test
import { build } from 'esbuild'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(p, out)
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(p)
    }
  }
  return out
}

const files = await walk(path.join(root, 'src'))
if (!files.length) {
  // 静默通过最危险：目录改名/glob 失效时 npm test 依旧绿灯
  console.error('没有找到 *.test.ts：测试无法执行，按失败处理')
  process.exit(1)
}

const outdir = path.join(root, '.test-build')
await rm(outdir, { recursive: true, force: true })

await build({
  entryPoints: files,
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['node:*'],
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
  // share/common/util 用 import.meta.env.MODE 判断 dev，node 下没有这对象，按测试环境兜底
  define: {
    'import.meta.env.MODE': '"test"',
  },
})

console.log(`编译 ${files.length} 个测试文件 → .test-build`)
const child = spawn(process.execPath, ['--test', outdir], {
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 1))
