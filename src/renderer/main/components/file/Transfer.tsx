import { observer } from 'mobx-react-lite'
import Style from './Transfer.module.scss'
import store from '../../store'
import { TransferType } from 'common/types'
import fileSize from 'licia/fileSize'
import { t } from 'common/util'

function fmtTime(seconds: number) {
  const sec = Math.max(0, Math.round(seconds))
  const hours = Math.floor(sec / 3600)
  const minutes = Math.floor((sec % 3600) / 60)
  const rest = sec % 60
  const pad = (n: number) => String(n).padStart(2, '0')

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${pad(minutes)}:${pad(rest)}`
}

/** 传输面板：每个任务一行，进度条 + 速度 + 剩余时间。 */
export default observer(function Transfer() {
  const transfers = store.file.transfers

  if (!transfers.length) {
    return <div className={Style.empty}>{t('transferEmpty')}</div>
  }

  return (
    <div className={Style.container}>
      {transfers.some((item) => item.done) ? (
        <div className={Style.headBar}>
          <button
            className={Style.clearBtn}
            onClick={() => store.file.clearDone()}
          >
            {t('transferClearDone')}
          </button>
        </div>
      ) : null}
      {transfers.map((item) => {
        const percent =
          item.size > 0
            ? Math.min(100, Math.round((item.transferred / item.size) * 100))
            : item.done
              ? 100
              : 0
        const isDown = item.type === TransferType.Download

        return (
          <div key={item.id} className={Style.row}>
            <div className={Style.head}>
              <span className={Style.name} title={item.src}>
                {item.name}
              </span>
              <span
                className={
                  Style.tag + ' ' + (isDown ? Style.down : Style.up)
                }
              >
                {isDown ? t('download') : t('upload')}
              </span>
              <span className={Style.meta}>
                {fileSize(item.transferred)}/{fileSize(item.size)} · {percent}%
                {!item.done && item.speed > 0
                  ? ` · ${fileSize(item.speed)}/s`
                  : ''}
              </span>
            </div>
            <div className={Style.barWrap}>
              <div
                className={
                  Style.bar +
                  (item.done
                    ? item.ok
                      ? ' ' + Style.barOk
                      : ' ' + Style.barErr
                    : '')
                }
                style={{ width: percent + '%' }}
              />
            </div>
            <div className={Style.foot}>
              <span className={Style.path} title={item.dest}>
                {item.dest}
              </span>
              <span className={item.done && !item.ok ? Style.errText : ''}>
                {item.done
                  ? item.ok
                    ? t('transferDone')
                    : t('transferFailed')
                  : item.speed > 0
                    ? t('transferRemaining', {
                        time: fmtTime(
                          (item.size - item.transferred) / item.speed
                        ),
                      })
                    : t('transferCalculating')}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
})
