/**
 * 文件预览：按 mime 选择图片/视频/音频/文本/PDF 查看器。
 * 音频要多一个可视化条，所以和 LunaMusicPlayer 共享同一个 audio 实例。
 */
import { JSX, useEffect, useState } from 'react'
import Style from './FilePreview.module.scss'
import { IFile } from 'luna-file-list'
import { t } from '../../common/i18n'
import startWith from 'licia/startWith'
import LunaImageViewer from 'luna-image-viewer/react'
import LunaVideoPlayer from 'luna-video-player/react'
import LunaMusicPlayer from 'luna-music-player/react'
import LunaTextViewer from 'luna-text-viewer/react'
import LunaMusicVisualizer from 'luna-music-visualizer/react'
import axios from 'axios'
import isStr from 'licia/isStr'
import truncate from 'licia/truncate'

const MAX_TEXT = 100000
// UTF-8 最多 4 字节/字符，取 400 KB 足够生成 10 万字符，也不会把整个大日志读进内存。
const MAX_TEXT_BYTES = 400 * 1024

interface IProps {
  file?: IFile
  url?: string
}

export default function Preview(props: IProps) {
  const { file, url } = props
  const [audio, setAudio] = useState<HTMLAudioElement>(() => new Audio())

  let preview: JSX.Element = (
    <div className={Style.previewEmpty}>{t('noPreview')}</div>
  )

  if (!file) {
    preview = <div className={Style.previewEmpty}>{t('fileNotSelected')}</div>
  } else if (!file.directory && url && file.mime) {
    const mime = file.mime

    if (mime === 'application/pdf') {
      preview = <iframe className={Style.pdfFrame} src={url} />
    } else if (startWith(mime, 'image/')) {
      preview = <LunaImageViewer image={url} />
    } else if (startWith(mime, 'video/')) {
      preview = <LunaVideoPlayer className={Style.videoViewport} url={url} />
    } else if (startWith(mime, 'audio/')) {
      preview = (
        <div className={Style.audioStack}>
          <LunaMusicVisualizer
            className={Style.audioWave}
            audio={audio}
            fftSize={256}
          />
          <LunaMusicPlayer
            className={Style.audioBar}
            audio={{ title: file.name, url }}
            onCreate={(player) => setAudio(player.getAudio())}
          />
        </div>
      )
    } else if (startWith(mime, 'text/')) {
      preview = <TextViewer url={url} />
    }
  }

  return <div className={Style.previewArea}>{preview}</div>
}

function TextViewer(props: { url: string }) {
  const [text, setText] = useState('')

  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setText('')

    axios
      .get(props.url, {
        responseType: 'text',
        signal: controller.signal,
        timeout: 8000,
        maxContentLength: 512 * 1024,
        headers: {
          Range: `bytes=0-${MAX_TEXT_BYTES - 1}`,
        },
      })
      .then((response) => {
        if (!alive) return
        if (!isStr(response.data)) {
          setText(t('commonErr'))
          return
        }
        // 大日志直接塞进查看器会卡死渲染进程：截断到 10 万字符
        setText(
          response.data.length > MAX_TEXT
            ? truncate(response.data, MAX_TEXT)
            : response.data
        )
      })
      .catch(() => {
        // 文件被删/设备掉线：显示错误文案，不要变成未处理拒绝
        if (alive) setText(t('commonErr'))
      })

    return () => {
      alive = false
      controller.abort()
    }
  }, [props.url])

  return <LunaTextViewer text={text} className={Style.textFrame} />
}
