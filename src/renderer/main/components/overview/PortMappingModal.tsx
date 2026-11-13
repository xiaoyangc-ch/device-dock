/**
 * 端口映射：forward（主机 → 设备）与 reverse（设备 → 主机）两种方向。
 */
import { t } from 'common/util'
import LunaModal from 'luna-modal/react'
import { observer } from 'mobx-react-lite'
import { createPortal } from 'react-dom'
import Style from './PortMappingModal.module.scss'
import LunaToolbar, {
  LunaToolbarButton,
  LunaToolbarInput,
  LunaToolbarSelect,
  LunaToolbarSpace,
} from 'luna-toolbar/react'
import LunaDataGrid from 'luna-data-grid/react'
import { useEffect, useRef, useState } from 'react'
import isStrBlank from 'licia/isStrBlank'
import store from '../../store'
import ToolbarIcon from 'share/renderer/components/ToolbarIcon'
import { IModalProps } from 'share/common/types'
import { notify } from 'share/renderer/lib/util'
import { normalizePort } from '../../lib/util'

const columns = [
  { id: 'local', title: t('local'), sortable: true },
  { id: 'remote', title: t('remote'), sortable: true },
]

export default observer(function PortMappingModal(props: IModalProps) {
  // 方向用 ref：改变它不能触发重渲染，列表由 refresh 自己更新
  const forwarding = useRef(true)
  const [local, setLocal] = useState('')
  const [remote, setRemote] = useState('')
  const [rows, setRows] = useState<{ local: string; remote: string }[]>([])

  // 弹窗常驻挂载（children 渲染进 portal）：只在挂载时拉一次会一直显示旧数据
  useEffect(() => {
    if (props.visible) refresh()
  }, [props.visible])

  async function refresh() {
    try {
      if (!store.device) {
        setRows([])
      } else if (forwarding.current) {
        setRows(await main.listForwards(store.device.id))
      } else {
        setRows(await main.listReverses(store.device.id))
      }
    } catch {
      // 设备离线：清空比留着上一次的端口列表更不容易误操作
      setRows([])
    }
  }

  return createPortal(
    <LunaModal
      title={t('portMapping')}
      visible={props.visible}
      onClose={props.onClose}
    >
      <div className={Style.portMapBody}>
        <LunaToolbar className={Style.portMapToolbar}>
          <LunaToolbarSelect
            keyName="portForwarding"
            onChange={(value) => {
              forwarding.current = value === 'forward'
              refresh()
            }}
            value={forwarding.current ? 'forward' : 'reverse'}
            options={{
              [t('portForwarding')]: 'forward',
              [t('portReversing')]: 'reverse',
            }}
          />
          <LunaToolbarInput
            keyName="local"
            className={Style.portLocal}
            value={local}
            placeholder={t('local')}
            onChange={setLocal}
          />
          <LunaToolbarInput
            keyName="remote"
            className={Style.portRemote}
            value={remote}
            placeholder={t('remote')}
            onChange={setRemote}
          />
          <LunaToolbarButton
            state="hover"
            disabled={isStrBlank(local) || isStrBlank(remote) || !store.device}
            onClick={async () => {
              if (!store.device) return

              const l = normalizePort(local)
              const r = normalizePort(remote)
              try {
                // forward：主机端口 → 设备端口；reverse 的参数顺序反过来
                if (forwarding.current) {
                  await main.forward(store.device.id, l, r)
                } else {
                  await main.reverse(store.device.id, r, l)
                }
              } catch {
                notify(t('commonErr'), { icon: 'error' })
                return
              }
              refresh()
            }}
          >
            {t('add')}
          </LunaToolbarButton>
          <LunaToolbarSpace />
          <ToolbarIcon
            icon="refresh"
            title={t('refresh')}
            onClick={refresh}
            disabled={!store.device}
          />
        </LunaToolbar>
        <LunaDataGrid
          className={Style.portMapGrid}
          data={rows}
          minHeight={250}
          maxHeight={250}
          selectable={true}
          columns={columns}
        />
      </div>
    </LunaModal>,
    document.body
  )
})
