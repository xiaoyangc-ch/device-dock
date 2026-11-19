const WITHOUT_DOT_ENTRIES =
  "grep -v ' /\\.$' | grep -v ' /\\.\\.$'"

/**
 * 设备上不一定有 awk：用两次 ls + grep 拼出「目录在前、文件在后」。
 * Android 11/Huawei FUSE 的 ls 可能不输出 . 和 ..，所以按名称过滤，
 * 不能假设目录头固定有两行。
 */
export function dirsFirstCommand(quotedPath: string) {
  return (
    `{ ls -laL ${quotedPath} | grep '^d' | ${WITHOUT_DOT_ENTRIES}; ` +
    `ls -laL ${quotedPath} | grep -v '^d' | grep -v '^total ' | ${WITHOUT_DOT_ENTRIES}; }`
  )
}

export function dirPageCommand(
  quotedPath: string,
  offset: number,
  limit: number
) {
  return `${dirsFirstCommand(quotedPath)} | tail -n +${offset + 1} | head -n ${limit}`
}

export function dirCountCommand(quotedPath: string) {
  return `${dirsFirstCommand(quotedPath)} | wc -l`
}
