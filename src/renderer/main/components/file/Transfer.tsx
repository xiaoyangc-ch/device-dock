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
    return <div className={Style.transferEmpty}>{t('transferEmpty')}</div>
  }

  return (
    <div className={Style.transferList}>
      {transfers.some((item) => item.done) ? (
        <div className={Style.transferToolbar}>
          <button
            className={Style.transferClear}
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
          <div key={item.id} className={Style.transferCard}>
            <div className={Style.transferCardHead}>
              <span className={Style.transferName} title={item.src}>
                {item.name}
              </span>
              <span
                className={
                  Style.transferBadge + ' ' + (isDown ? Style.transferBadgeDown : Style.transferBadgeUp)
                }
              >
                {isDown ? t('download') : t('upload')}
              </span>
              <span className={Style.transferMeta}>
                {fileSize(item.transferred)}/{fileSize(item.size)} · {percent}%
                {!item.done && item.speed > 0
                  ? ` · ${fileSize(item.speed)}/s`
                  : ''}
              </span>
            </div>
            <div className={Style.transferBarTrack}>
              <div
                className={
                  Style.transferBar +
                  (item.done
                    ? item.ok
                      ? ' ' + Style.transferBarDone
                      : ' ' + Style.transferBarFail
                    : '')
                }
                style={{ width: percent + '%' }}
              />
            </div>
            <div className={Style.transferFoot}>
              <span className={Style.transferDest} title={item.dest}>
                {item.dest}
              </span>
              <span className={item.done && !item.ok ? Style.transferError : ''}>
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
