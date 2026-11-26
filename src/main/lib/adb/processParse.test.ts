import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTop } from './processParse'

test('Android 6 toolbox top：按实际表头映射 CPU、内存、用户和进程名', () => {
  const rows = parseTop(
    `
  PID PR CPU% S  #THR     VSS     RSS PCY UID      Name
 5607  1   4% S    42 1044088K 177552K  fg system   com.ycserver.s3
 2575  3   0% S    11   12240K    724K  fg root     /sbin/adbd
`,
    [],
  )
  assert.deepEqual(rows, [
    {
      pid: '5607',
      pr: '1',
      '%cpu': '4%',
      s: 'S',
      '#thr': '42',
      vss: '1044088K',
      res: '177552K',
      pcy: 'fg',
      user: 'system',
      name: 'com.ycserver.s3',
    },
    {
      pid: '2575',
      pr: '3',
      '%cpu': '0%',
      s: 'S',
      '#thr': '11',
      vss: '12240K',
      res: '724K',
      pcy: 'fg',
      user: 'root',
      name: '/sbin/adbd',
    },
  ])
})
