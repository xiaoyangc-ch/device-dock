/**
 * 截屏页：抓一张 PNG，支持保存/复制/旋转/缩放。
 * 切设备时会自动重抓；离线设备清空旧图且不弹错误。
 */
import { observer } from 'mobx-react-lite'
import Style from './Screenshot.module.scss'
import dataUrl from 'licia/dataUrl'
import toBool from 'licia/toBool'
import fileSize from 'licia/fileSize'
import convertBin from 'licia/convertBin'
import download from 'licia/download'
import loadImg from 'licia/loadImg'
import LunaImageViewer from 'luna-image-viewer/react'
import ImageViewer from 'luna-image-viewer'
import { useEffect, useRef, useState } from 'react'
import store from '../../store'
import { t } from 'common/util'
import { copyData, notify } from 'share/renderer/lib/util'
import dateFormat from 'licia/dateFormat'
import PageToolbar, {
  Page,
  PageBody,
  ToolButton,
  ToolSeparator,
  ToolSpace,
  ToolText,
} from '../layout/PageToolbar'
import { isOnlineDevice } from '../../lib/util'

interface IShot {
  data: string
  url: string
  width: number
  height: number
  size: number
}

export default observer(function Screenshot() {
  const [image, setImage] = useState<IShot | null>(null)
  const imageViewerRef = useRef<ImageViewer>(null)
  const captureSeq = useRef(0)

  useEffect(() => {
    recapture()
  }, [store.device?.id, store.device?.type])

  function save() {
    const blob = convertBin(image!.data, 'Blob')
    download(blob, `screenshot-${dateFormat('yyyymmddHHMM')}.png`, 'image/png')
  }

  function copy() {
    copyData(image!.data, 'image/png')
  }

  async function recapture() {
    const seq = ++captureSeq.current
    setImage(null)
    if (!store.device) return

    // 离线设备抓图必然失败：清掉上一张旧图，不要弹错误
    if (!isOnlineDevice(store.device)) {
      return
    }

    const deviceId = store.device.id

    try {
      const data = await main.screencap(deviceId)
      if (seq !== captureSeq.current || store.device?.id !== deviceId) return

      const url = dataUrl.stringify(data, 'image/png')
      loadImg(url, (err, img) => {
        if (seq !== captureSeq.current || store.device?.id !== deviceId) return
        if (err) {
          setImage(null)
          return
        }

        setImage({
          data,
          url,
          width: img.width,
          height: img.height,
          // base64 是 4/3 膨胀：只为显示大小，没必要再解码整张图
          size: Math.floor((data.length * 3) / 4),
        })
      })
    } catch {
      // 设备掉线/超时：清旧图并提示，不能让 useEffect 里留未处理拒绝
      if (seq === captureSeq.current && store.device?.id === deviceId) {
        setImage(null)
        notify(t('commonErr'), { icon: 'error' })
      }
    }
  }

  const hasImage = toBool(image)

  return (
    <Page>
      <PageToolbar>
        <ToolButton
          icon="icon-refresh"
          title={t('recapture')}
          onClick={recapture}
          disabled={!store.device}
        />
        <ToolButton
          icon="icon-save"
          title={t('save')}
          onClick={save}
          disabled={!hasImage}
        />
        <ToolButton
          icon="icon-copy"
          title={t('copy')}
          onClick={copy}
          disabled={!hasImage}
        />
        <ToolSeparator />
        <ToolButton
          icon="icon-rotate-left"
          title={t('rotateLeft')}
          onClick={() => imageViewerRef.current?.rotate(-90)}
          disabled={!hasImage}
        />
        <ToolButton
          icon="icon-rotate-right"
          title={t('rotateRight')}
          onClick={() => imageViewerRef.current?.rotate(90)}
          disabled={!hasImage}
        />
        <ToolButton
          icon="icon-zoom-in"
          title={t('zoomIn')}
          onClick={() => imageViewerRef.current?.zoom(0.1)}
          disabled={!hasImage}
        />
        <ToolButton
          icon="icon-zoom-out"
          title={t('zoomOut')}
          onClick={() => imageViewerRef.current?.zoom(-0.1)}
          disabled={!hasImage}
        />
        <ToolButton
          icon="icon-original"
          title={t('actualSize')}
          onClick={() => imageViewerRef.current?.zoomTo(1)}
          disabled={!hasImage}
        />
        <ToolButton
          icon="icon-reset"
          title={t('reset')}
          onClick={() => imageViewerRef.current?.reset()}
          disabled={!hasImage}
        />
        <ToolSpace />
        <ToolText mono>
          {hasImage
            ? `${image!.width} × ${image!.height} · PNG · ${fileSize(
                image!.size,
              )}`
            : ''}
        </ToolText>
      </PageToolbar>
      <PageBody className={Style.viewer}>
        {image ? (
          <LunaImageViewer
            className={Style.imageViewer}
            image={image.url}
            onCreate={(viewer) => (imageViewerRef.current = viewer)}
          />
        ) : (
          <div className={Style.empty}>
            <span className="icon-camera" />
            <div className={Style.emptyTitle}>
              {store.device ? t('noScreenshot') : t('connectToScreenshot')}
            </div>
            <button
              className={Style.emptyBtn}
              onClick={recapture}
              disabled={!store.device}
            >
              {t('recapture')}
            </button>
          </div>
        )}
      </PageBody>
    </Page>
  )
})
