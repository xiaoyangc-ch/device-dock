import { observer } from 'mobx-react-lite'
import Style from './Transfer.module.scss'
import store from '../../store'
import { TransferType } from 'common/types'
import fileSize from 'licia/fileSize'
import { t } from 'common/util'

function fmtTime(sec: number) {
  sec = Math.max(0, Math.round(sec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export default observer(function Transfer() {
  const transfers = store.file.transfers
  if (!transfers.length) {
    return (
      <div className={Style.empty}>{t('transferEmpty')}</div>
    )
  }

  return (
    <div className={Style.container}>
      {transfers.some((item) => item.done) ? (
        <div className={Style.headBar}>
          <button className={Style.clearBtn} onClick={() => store.file.clearDone()}>
            {t('transferClearDone')}
          </button>
        </div>
      ) : null}
      {transfers.map((tr) => {
        const pct =
          tr.size > 0
            ? Math.min(100, Math.round((tr.transferred / tr.size) * 100))
            : tr.done
              ? 100
              : 0
        const isDown = tr.type === TransferType.Download
        return (
          <div key={tr.id} className={Style.row}>
            <div className={Style.head}>
              <span className={Style.name} title={tr.src}>
                {tr.name}
              </span>
              <span
                className={Style.tag + ' ' + (isDown ? Style.down : Style.up)}
              >
                {isDown ? t('download') : t('upload')}
              </span>
              <span className={Style.meta}>
                {fileSize(tr.transferred)}/{fileSize(tr.size)} · {pct}%
                {!tr.done && tr.speed > 0 ? ` · ${fileSize(tr.speed)}/s` : ''}
              </span>
            </div>
            <div className={Style.barWrap}>
              <div
                className={
                  Style.bar +
                  (tr.done
                    ? tr.ok
                      ? ' ' + Style.barOk
                      : ' ' + Style.barErr
                    : '')
                }
                style={{ width: pct + '%' }}
              />
            </div>
            <div className={Style.foot}>
              <span className={Style.path} title={tr.dest}>
                {tr.dest}
              </span>
              <span className={tr.done && !tr.ok ? Style.errText : ''}>
                {tr.done
                  ? tr.ok
                    ? t('transferDone')
                    : t('transferFailed')
                  : tr.speed > 0
                    ? t('transferRemaining', {
                        time: fmtTime((tr.size - tr.transferred) / tr.speed),
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
