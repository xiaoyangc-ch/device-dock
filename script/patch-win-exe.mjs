// electron-builder afterPack 钩子（仅 Windows 生效）
//
// 正常流程里 electron-builder 用 rcedit.exe 改 exe 的图标和版本信息，rcedit 是 Windows 二进制，
// 在 macOS/Linux 上要靠 wine 跑。这台 arm64 Mac 没有 Rosetta、装不了 x86 wine，
// 所以打 x64 包时改用纯 JS 的 resedit 补这两样，效果与 rcedit 一致（图标 + 版本资源）。
import fs from 'node:fs'
import path from 'node:path'
import * as ResEdit from 'resedit'

const RT_GROUP_ICON = 14

export default async function patchWinExe(context) {
  if (context.electronPlatformName !== 'win32') return

  const { appOutDir, packager } = context
  const productName = packager.appInfo.productFilename || '设备坞'
  const exePath = path.join(appOutDir, `${productName}.exe`)
  if (!fs.existsSync(exePath)) {
    throw new Error(`patch-win-exe: 找不到 ${exePath}`)
  }

  const iconPath = path.resolve(import.meta.dirname, '../build/icon.ico')
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), {
    ignoreCert: true,
  })
  const res = ResEdit.NtExecutableResource.from(exe)

  // 1) 图标：替换 exe 里所有 RT_GROUP_ICON 组
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath))
  const groups = res.entries.filter((e) => e.type === RT_GROUP_ICON)
  for (const group of groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      group.id,
      group.lang || 1033,
      iconFile.icons.map((item) => item.data)
    )
  }

  // 2) 版本信息
  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
  if (viList.length) {
    const version = String(packager.appInfo.version || '0.0.0')
      .split('.')
      .map((n) => parseInt(n, 10) || 0)
    const [major, minor, patch] = version
    const vi = viList[0]
    vi.setFileVersion(major, minor, patch, 0, 1033)
    vi.setProductVersion(major, minor, patch, 0, 1033)
    vi.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        ProductName: packager.appInfo.productName || productName,
        FileDescription:
          packager.appInfo.description || '设备坞：安卓设备管理工具',
        CompanyName: packager.appInfo.companyName || '设备坞',
        LegalCopyright: packager.appInfo.copyright || '',
        InternalName: packager.appInfo.productName || productName,
        OriginalFilename: '',
      }
    )
    vi.outputToResourceEntries(res.entries)
  }

  res.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
  console.log(
    `[patch-win-exe] ${path.basename(exePath)} 已写入图标（${groups.length} 组）与版本 ${packager.appInfo.version}`
  )
}
