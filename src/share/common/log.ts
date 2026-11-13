/**
 * 统日志：licia Logger 的薄封装，输出格式 `HH:MM:ss.l I name: ...`。
 * dev 下 trace 全开，打包后只留 info 以上，避免刷屏拖慢常驻进程。
 */
import BaseLogger from 'licia/Logger'
import toArr from 'licia/toArr'
import clone from 'licia/clone'
import dateFormat from 'licia/dateFormat'
import { isDev } from './util'

const LEVEL_LETTERS: Record<string, string> = {
  info: 'I',
  warn: 'W',
  error: 'E',
  debug: 'D',
}

const consoleMethods: Record<string, (...args: any[]) => void> = {}
for (const name of ['trace', 'log', 'info', 'warn', 'error']) {
  consoleMethods[name] = console[name].bind(console) as (...args: any[]) => void
}

class Logger extends BaseLogger {
  _log(type: string, argList: any[]) {
    argList = toArr(argList)
    if (!argList.length) return this

    this.emit('all', type, clone(argList))

    if (BaseLogger.level[type.toUpperCase()] < (this as any)._level) return this
    this.emit(type, clone(argList))

    // debug 走 console.log：控制台里没有 console.debug 的过滤项，统一更好认
    const method = type === 'debug' ? consoleMethods.log : consoleMethods[type]
    method(...this.formatter(type, argList))
    return this
  }
}

const loggers: Logger[] = []
let level: number | string = 'trace'

type LogFn = {
  (name: string): Logger
  setLevel(level: number | string): void
}

const log = ((name: string) => {
  const logger = new Logger(name)
  logger.setLevel(level)
  logger.formatter = function (type, argList) {
    argList.unshift(
      dateFormat('HH:MM:ss.l'),
      LEVEL_LETTERS[type] || '?',
      this.name + ':'
    )
    return argList
  }

  loggers.push(logger)
  return logger
}) as LogFn

log.setLevel = function (value) {
  level = value
  for (const logger of loggers) logger.setLevel(level)
}

if (!isDev()) log.setLevel('info')

export default log
