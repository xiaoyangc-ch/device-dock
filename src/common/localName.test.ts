import assert from 'node:assert/strict'
import test from 'node:test'
import { localFileNameVariant, safeLocalFileName } from './localName'

test('本地文件名：反斜杠不能成为 Windows 路径分隔符', () => {
  assert.equal(
    safeLocalFileName('..\\..\\Startup\\evil.exe'),
    '.._.._Startup_evil.exe',
  )
  assert.equal(safeLocalFileName('a/b:c*d?.txt'), 'a_b_c_d_.txt')
})

test('本地文件名：处理 Windows 保留名和尾部点/空格', () => {
  assert.equal(safeLocalFileName('CON'), '_CON')
  assert.equal(safeLocalFileName('LPT1.txt'), '_LPT1.txt')
  assert.equal(safeLocalFileName('report. '), 'report__')
  assert.equal(safeLocalFileName('.'), 'file')
})

test('本地文件名：超长名称保留扩展名', () => {
  const name = safeLocalFileName(`${'a'.repeat(300)}.apk`)
  assert.equal(name.endsWith('.apk'), true)
  assert.equal(Array.from(name).length, 180)
})

test('本地文件名：按 Windows UTF-16 单元截断 emoji 名称', () => {
  const name = safeLocalFileName(`${'😀'.repeat(200)}.apk`)
  assert.equal(name.endsWith('.apk'), true)
  assert.ok(name.length <= 180)
  assert.equal(name.includes('\uFFFD'), false)
})

test('本地文件名：截断后仍不会留下 Windows 尾部点', () => {
  const name = safeLocalFileName(`${'a'.repeat(179)}.${'b'.repeat(30)}`)
  assert.equal(name.length, 180)
  assert.doesNotMatch(name, /[. ]$/)
})

test('本地文件名：重名序号追加后也不会超长', () => {
  const name = `${'😀'.repeat(100)}.apk`
  const variant = localFileNameVariant(name, 12)
  assert.equal(variant.endsWith(' (12).apk'), true)
  assert.ok(variant.length <= 180)

  const noExt = localFileNameVariant('a'.repeat(300), 7)
  assert.equal(noExt.endsWith(' (7)'), true)
  assert.ok(noExt.length <= 180)
})
