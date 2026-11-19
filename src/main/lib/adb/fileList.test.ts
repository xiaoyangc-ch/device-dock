import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dirCountCommand,
  dirPageCommand,
  dirsFirstCommand,
} from './fileList'

test('目录分页：显式过滤 . / ..，不再依赖固定行数', () => {
  const list = dirsFirstCommand("'/sdcard'")
  assert.match(list, /grep -v ' \/\\\.\$'/)
  assert.match(list, /grep -v ' \/\\\.\\\.\$'/)
  assert.doesNotMatch(dirPageCommand("'/sdcard'", 0, 10), /tail -n \+3/)
  assert.match(dirPageCommand("'/sdcard'", 20, 10), /tail -n \+21/)
})

test('目录计数：直接使用过滤后的行数', () => {
  assert.match(dirCountCommand("'/sdcard'"), /wc -l/)
})
