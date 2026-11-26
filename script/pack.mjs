import builder, { Arch, Platform } from 'electron-builder'
import isMac from 'licia/isMac.js'
import isWindows from 'licia/isWindows.js'
import { resolve } from 'node:path'

cd('dist')

const pkg = await fs.readJson('package.json')
const args = process.argv.slice(2)

const config = {
  appId: pkg.appId,
  electronVersion: pkg.electronVersion,
  npmRebuild: false,
  directories: {
    output: `../release/${pkg.version}`,
  },
  files: ['main', 'preload', 'renderer'],
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  extraResources: {
    from: 'resources',
    to: './',
    // 各平台只带自己的 adb：mac 包别塞 adb.exe（6.3M），win 包别带 darwin adb（18M）
    filter: isWindows
      ? ['**/*', '!adb/adb']
      : ['**/*', '!adb/adb.exe', '!adb/AdbWinApi.dll', '!adb/AdbWinUsbApi.dll'],
  },
  nsis: {
    allowToChangeInstallationDirectory: true,
    oneClick: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    installerSidebar: 'build/installerSidebar.bmp',
  },
  win: {
    target: [
      {
        // 显式 x64：不写的话 electron-builder 按本机架构出包，arm64 mac 上会误出 win-arm64
        target: 'nsis',
        arch: ['x64'],
      },
      {
        // 免安装 zip：mac 上打不了 NSIS（makensis 是 x86_64），
        // 靠这个产物给出可直接解压运行的分发包
        target: 'zip',
        arch: ['x64'],
      },
    ],
    icon: 'build/icon.ico',
  },
  mac: {
    electronLanguages: ['zh_CN', 'en'],
    target: [
      {
        target: 'dmg',
      },
    ],
    icon: 'build/icon.icns',
  },
}

const electronDist = resolve(__dirname, '../node_modules/electron/dist')
if (await fs.pathExists(electronDist)) {
  config.electronDist = electronDist
}

// 在 mac 上交叉打 Windows 包时：rcedit 要 wine、makensis 是 x86_64，
// 这里关掉 rcedit 并改用 resedit 补图标/版本（Windows runner 上仍走原生 rcedit）。
// 注意 pack.mjs 已经 cd 到 dist，afterPack 必须给绝对路径。
if (!isWindows) {
  config.win.signAndEditExecutable = false
  config.afterPack = resolve(__dirname, 'patch-win-exe.mjs')
}

if (isMac) {
  const entitlements = {
    entitlements: 'build/entitlements.mas.plist',
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
  }
  if (args.includes('--dir')) {
    config.mac.target = ['dir']
  } else if (args.includes('--mas-dev')) {
    config.mac.target = [
      {
        target: 'mas-dev',
      },
    ]
    config.masDev = {
      ...entitlements,
      provisioningProfile: 'build/mas-dev.provisionprofile',
    }
  } else if (args.includes('--mas')) {
    config.mac.target = [
      {
        target: 'mas',
      },
    ]
    config.mac.extendInfo = {
      LSMinimumSystemVersion: '12.0',
    }
    config.mas = {
      ...entitlements,
      provisioningProfile: 'build/mas.provisionprofile',
    }
  }
}

if (isWindows) {
  const args = process.argv.slice(2)
  if (args.includes('--appx')) {
    config.win.target = [
      {
        target: 'appx',
      },
    ]
    config.appx = {
      identityName: 'DeviceDock.App',
      publisher: 'CN=B8CA87F2-EAEA-4C05-B38C-AAA50D3CBA24',
      publisherDisplayName: '设备坞',
      displayName: '设备坞',
    }
  }
}

await builder.build({
  config,
  targets: args.includes('--win')
    ? Platform.WINDOWS.createTarget(['nsis'], Arch.x64)
    : args.includes('--mac-arm64')
      ? Platform.MAC.createTarget(['dmg'], Arch.arm64)
      : undefined,
})
