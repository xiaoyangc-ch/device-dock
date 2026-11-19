import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDirSet,
  hitsToFiles,
  isExpectedFindError,
  searchIndex,
  slicePage,
} from './fileIndex'

test('文件索引：命中排序、目录识别和分页', async () => {
  const entries = [
    'f\t/storage/a/readme.txt',
    'f\t/storage/a/docs',
    'f\t/storage/a/docs/readme.md',
  ]
  const index = { entries, dirs: buildDirSet(entries), at: 1 }
  const hits = await searchIndex(index, 'read')

  assert.deepEqual(
    hits.map((hit) => hit.path),
    ['/storage/a/docs/readme.md', '/storage/a/readme.txt']
  )
  const files = hitsToFiles(hits)
  assert.equal(files[0].name, '/storage/a/docs/readme.md')
  assert.equal(files[0].mime, 'text/markdown')
  assert.deepEqual(slicePage(files, 1, 1).files[0].name, files[1].name)
})

test('文件索引：空目录仍通过父路径识别', async () => {
  const entries = ['f\t/storage/a/empty']
  const index = { entries, dirs: buildDirSet(['f\t/storage/a/empty/file']), at: 1 }
  const hits = await searchIndex(index, 'empty')
  assert.equal(hits[0].directory, true)
})

test('文件索引：受保护目录的 find 错误可视为可达文件完整', () => {
  assert.equal(
    isExpectedFindError(
      "find: ./Android/data/foo: Permission denied\nfind: ./Android/obb: Operation not permitted"
    ),
    true
  )
  assert.equal(isExpectedFindError('find: unrecognized option'), false)
  assert.equal(isExpectedFindError(''), false)
})
