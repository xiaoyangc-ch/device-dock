import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  conflictName,
  iconOf,
  isPreviewable,
  isValidFileName,
  modeOf,
  typeOf,
} from './fileUtil'

function f(partial: any) {
  return {
    name: 'a.txt',
    size: 0,
    directory: false,
    mtime: 0,
    mode: '-rw-r--r--',
    ...partial,
  } as any
}

test('typeOf：目录显示传入的目录名，文件取扩展名大写', () => {
  assert.equal(typeOf(f({ directory: true, name: 'a' })), '文件夹')
  assert.equal(typeOf(f({ directory: true, name: 'a' }), 'Folder'), 'Folder')
  assert.equal(typeOf(f({ name: 'readme.md' })), 'MD')
  // 无扩展名 / 点开头的隐藏文件不硬编一个假类型
  assert.equal(typeOf(f({ name: 'init' })), '')
  assert.equal(typeOf(f({ name: '.gitignore' })), '')
})

test('iconOf：按扩展名与 mime 选线性图标', () => {
  assert.equal(iconOf(f({ directory: true })), 'icon-folder')
  assert.equal(iconOf(f({ name: 'app.apk' })), 'icon-package')
  assert.equal(iconOf(f({ name: 'a.png' })), 'icon-image')
  assert.equal(iconOf(f({ name: 'a.bin', mime: 'image/png' })), 'icon-image')
  assert.equal(iconOf(f({ name: 'a.bin', mime: 'video/mp4' })), 'icon-video-recorder')
  assert.equal(iconOf(f({ name: 'a.log' })), 'icon-file-text')
  assert.equal(iconOf(f({ name: 'a.bin' })), 'icon-open-file')
})

test('isPreviewable：只认能内嵌展示的 mime', () => {
  assert.equal(isPreviewable(f({ mime: 'application/pdf' })), true)
  assert.equal(isPreviewable(f({ mime: 'image/jpeg' })), true)
  assert.equal(isPreviewable(f({ mime: 'audio/mpeg' })), true)
  assert.equal(isPreviewable(f({ mime: 'application/zip' })), false)
  assert.equal(isPreviewable(f({ mime: '' })), false)
})

test('modeOf：符号串原样返回，数字按八进制展开', () => {
  assert.equal(modeOf(f({ mode: '-rw-r--r--' })), '-rw-r--r--')
  assert.equal(modeOf(f({ mode: 'drwxr-xr-x' })), 'drwxr-xr-x')
  assert.equal(modeOf(f({ mode: 0o644 })), '-rw-r--r--')
  assert.equal(modeOf(f({ mode: '644' })), '-rw-r--r--')
  assert.equal(modeOf(f({ mode: 0o755, directory: true })), 'drwxr-xr-x')
  assert.equal(modeOf(f({ mode: '' })), '--')
  assert.equal(modeOf(f({ mode: 'oops' })), 'oops')
})

test('文件名：拒绝路径分隔符和点目录', () => {
  assert.equal(isValidFileName('正常 文件名.txt'), true)
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
    assert.equal(isValidFileName(name), false, `应拒绝 ${JSON.stringify(name)}`)
  }
})

test('文件名：本地冲突自动编号且保留扩展名', () => {
  assert.equal(conflictName('a.txt', 0), 'a.txt')
  assert.equal(conflictName('a.txt', 1), 'a (1).txt')
  assert.equal(conflictName('.hidden', 2), '.hidden (2)')
})
