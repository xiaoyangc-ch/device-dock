import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLsLine } from './lsLine'

test('toybox ls 行（Android 7+，带链接计数与 size）', () => {
  const file = parseLsLine(
    '-rw-r--r-- 1 root root 123 2026-11-10 18:31 test.txt',
  )
  assert.equal(file?.name, 'test.txt')
  assert.equal(file?.directory, false)
  assert.equal(file?.size, 123)
  assert.equal(file?.mode, '-rw-r--r--')

  const dir = parseLsLine('drwxr-xr-x 2 root root 4096 2026-11-10 18:31 DCIM')
  assert.equal(dir?.name, 'DCIM')
  assert.equal(dir?.directory, true)
})

test('toolbox ls 行（Android 6，没有链接计数、目录没有 size 列）', () => {
  const dir = parseLsLine(
    'drwxr-xr-x root     root               2016-11-10 18:31 sdcard',
  )
  assert.equal(dir?.name, 'sdcard')
  assert.equal(dir?.directory, true)
  assert.equal(dir?.size, 0)

  const file = parseLsLine(
    '-rw-r--r-- root     root          123 2016-11-10 18:31 test.txt',
  )
  assert.equal(file?.name, 'test.txt')
  assert.equal(file?.directory, false)
  assert.equal(file?.size, 123)
  assert.equal(file?.mtime.getFullYear(), 2016)
})

test('busybox / 定制 ls 行（月名日期，Kylin 固件）', () => {
  const file = parseLsLine(
    '-rw-r--r--    1 root     root      289390592 Nov 11 16:30 60000120.ys',
  )
  assert.equal(file?.name, '60000120.ys')
  assert.equal(file?.size, 289390592)
  assert.equal(file?.mtime.getMonth(), 10)
  assert.equal(file?.mtime.getDate(), 11)

  const old = parseLsLine(
    '-rw-r--r--    1 root     root           1024 Nov 11  2025 old.log',
  )
  assert.equal(old?.name, 'old.log')
  assert.equal(old?.size, 1024)
  assert.equal(old?.mtime.getFullYear(), 2025)

  const dir = parseLsLine(
    'drwxr-xr-x    2 root     root           4096 Nov 11 16:30 DCIM',
  )
  assert.equal(dir?.directory, true)

  const space = parseLsLine(
    '-rw-r--r--    1 root     root             12 Nov 11 16:30 my file.txt',
  )
  assert.equal(space?.name, 'my file.txt')
})

test('软链接剥掉 -> 目标，仍按 l 标记', () => {
  const toybox = parseLsLine(
    'lrwxrwxrwx 1 root root 21 2026-11-10 18:31 sdcard -> /storage/emulated/0',
  )
  assert.equal(toybox?.name, 'sdcard')
  assert.equal(toybox?.mode[0], 'l')

  const toolbox = parseLsLine(
    'lrwxrwxrwx root     root               2016-11-10 18:31 sdcard -> /storage/emulated/0',
  )
  assert.equal(toolbox?.name, 'sdcard')
  assert.equal(toolbox?.directory, false)
})

test('total / . / .. 与非法行不返回条目', () => {
  assert.equal(parseLsLine('total 12'), null)
  assert.equal(parseLsLine('drwxr-xr-x root root 2016-11-10 18:31 .'), null)
  assert.equal(parseLsLine('drwxr-xr-x root root 2016-11-10 18:31 ..'), null)
  assert.equal(parseLsLine(''), null)
  assert.equal(parseLsLine('ls: Unknown option'), null)
})
