import { useEffect, useRef, useState } from 'react'
import chunk from 'licia/chunk'
import { IPackageInfo } from 'common/types'
import { notify } from 'share/renderer/lib/util'
import { t } from 'common/util'
import { retryOnce } from 'common/retry'
import store from '../../store'
import { placeholderInfo } from './applicationModel'

// 麒麟/远程链路单包反射较慢，50 个一批能在 30 秒服务端上限内更早拿到有效数据。
const CHUNK_SIZE = 50
const PAINT_INTERVAL = 250

export function useApplicationPackages(
  deviceId: string | undefined,
  deviceType: string | undefined,
) {
  const [isLoading, setIsLoading] = useState(false)
  const [packageInfos, setPackageInfos] = useState<IPackageInfo[]>([])
  const loadSeq = useRef(0)
  const pkgSeq = useRef(new Map<string, number>())

  useEffect(() => {
    void refresh()
  }, [deviceId, deviceType])

  async function refresh(packageName?: string) {
    if (!deviceId) return

    if (!packageName) {
      const seq = ++loadSeq.current
      setPackageInfos([])
      setIsLoading(true)

      try {
        const packages = await retryOnce(() =>
          main.getPackages(deviceId, store.application.sysPackage),
        )
        if (seq !== loadSeq.current) return

        // 先展示完整包名占位，再逐批补名称/版本，麒麟老固件也不会长时间空白。
        setPackageInfos(
          packages.map((name) =>
            placeholderInfo(name, store.application.sysPackage),
          ),
        )

        const chunks = chunk(packages, CHUNK_SIZE)
        const parts: IPackageInfo[][] = new Array(chunks.length)
        let next = 0
        let done = 0
        let lastPaint = 0

        const paint = (force: boolean) => {
          if (seq !== loadSeq.current) return
          const now = Date.now()
          if (force || now - lastPaint >= PAINT_INTERVAL) {
            lastPaint = now
            setPackageInfos(parts.filter(Boolean).flat())
          }
        }

        const worker = async () => {
          for (;;) {
            const index = next++
            if (index >= chunks.length) return

            const names = chunks[index]
            const infos = await main
              .getPackageInfos(deviceId, names)
              .catch(() => [])
            const byName = new Map(
              infos.map((info) => [info.packageName, info] as const),
            )
            parts[index] = names.map(
              (name) =>
                byName.get(name) ||
                placeholderInfo(name, store.application.sysPackage),
            )
            done++
            paint(done === chunks.length)
          }
        }

        // 单个设备 socket 在服务端顺序处理，串行批次比排队后集体超时更稳。
        await worker()
        if (seq !== loadSeq.current) return
        setPackageInfos(parts.filter(Boolean).flat())
      } catch (e: any) {
        notify(t('appListFailed') + (e?.message || e), { icon: 'error' })
      } finally {
        if (seq === loadSeq.current) setIsLoading(false)
      }
      return
    }

    const mySeq = (pkgSeq.current.get(packageName) ?? 0) + 1
    pkgSeq.current.set(packageName, mySeq)
    const seq = loadSeq.current
    try {
      const infos = await main.getPackageInfos(deviceId, [packageName])
      if (
        seq !== loadSeq.current ||
        pkgSeq.current.get(packageName) !== mySeq ||
        store.device?.id !== deviceId
      ) {
        return
      }

      const info = infos[0]
      if (!info) return
      setPackageInfos((prev) => {
        const index = prev.findIndex((item) => item.packageName === packageName)
        if (index === -1) return prev
        const next = prev.slice()
        next[index] = info
        return next
      })
    } catch {
      // 掉线时保留旧数据，下次刷新重试
    }
  }

  function updatePackageIcon(packageName: string, icon: string) {
    setPackageInfos((list) =>
      list.map((info) =>
        info.packageName === packageName ? { ...info, icon } : info,
      ),
    )
  }

  return { isLoading, packageInfos, refresh, updatePackageIcon }
}
