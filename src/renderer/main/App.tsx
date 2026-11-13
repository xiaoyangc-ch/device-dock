import Sidebar from './components/layout/Sidebar'
import PageHead from './components/layout/PageHead'
import Logcat from './components/logcat/Logcat'
import Shell from './components/shell/Shell'
import Overview from './components/overview/Overview'
import Screenshot from './components/screenshot/Screenshot'
import Process from './components/process/Process'
import Performance from './components/performance/Performance'
import Disk from './components/disk/Disk'
import Application from './components/application/Application'
import File from './components/file/File'
import ConnectPage from './components/connect/ConnectPage'
import Style from './App.module.scss'
import { observer } from 'mobx-react-lite'
import { useState, useEffect, PropsWithChildren, FC } from 'react'
import store from './store'
import ErrorBoundary from 'share/renderer/components/ErrorBoundary'
import { t } from 'common/util'

export default observer(function App() {
  useEffect(() => {
    const off = main.on('fullScreenChange', (fullScreen: boolean) => {
      document.body.classList.toggle(
        'native-titlebar-fullscreen',
        !!fullScreen
      )
    })
    return () => {
      off()
    }
  }, [])

  return (
    <div className={Style.shell}>
      <Sidebar />
      <div className={Style.main}>
        {store.ready ? (
          <>
            {store.panel !== 'file' && <PageHead />}
            {/* 切设备时整棵面板树重建：文件页回根目录、终端/日志重开会话，
                各页面不必各自处理「设备已换」；代价是切换时有一次重挂载 */}
            <div
              className={Style.panels}
              key={store.device ? store.device.id : ''}
            >
              <Panel panel="connect">
                <ErrorBoundary name="connect">
                  <ConnectPage />
                </ErrorBoundary>
              </Panel>
              <Panel panel="overview">
                <ErrorBoundary name="overview">
                  <Overview />
                </ErrorBoundary>
              </Panel>
              <Panel panel="application">
                <ErrorBoundary name="application">
                  <Application />
                </ErrorBoundary>
              </Panel>
              <Panel panel="screenshot">
                <ErrorBoundary name="screenshot">
                  <Screenshot />
                </ErrorBoundary>
              </Panel>
              <Panel panel="logcat">
                <ErrorBoundary name="logcat">
                  <Logcat />
                </ErrorBoundary>
              </Panel>
              <Panel panel="shell">
                <ErrorBoundary name="shell">
                  <Shell />
                </ErrorBoundary>
              </Panel>
              <Panel panel="process">
                <ErrorBoundary name="process">
                  <Process />
                </ErrorBoundary>
              </Panel>
              <Panel panel="performance">
                <ErrorBoundary name="performance">
                  <Performance />
                </ErrorBoundary>
              </Panel>
              <Panel panel="disk">
                <ErrorBoundary name="disk">
                  <Disk />
                </ErrorBoundary>
              </Panel>
              <Panel panel="file">
                <ErrorBoundary name="file">
                  <File />
                </ErrorBoundary>
              </Panel>
            </div>
          </>
        ) : (
          <div className={Style.ready}>{t('connectingDevice')}</div>
        )}
      </div>
    </div>
  )
})

interface IPanelProps {
  panel: string
}

const Panel: FC<PropsWithChildren<IPanelProps>> = observer(function Panel(
  props
) {
  const [used, setUsed] = useState(false)

  let visible = false

  if (store.panel === props.panel) {
    if (!used) {
      setUsed(true)
    }
    visible = true
  }

  const style: React.CSSProperties = {}
  if (!visible) {
    style.opacity = 0
    style.pointerEvents = 'none'
    // 只设 opacity 的话，隐藏面板里的按钮仍能被 Tab 键聚焦（焦点跑进看不见的界面）
    style.visibility = 'hidden'
  }

  return (
    <div className={Style.panel} style={style}>
      {used ? props.children : null}
    </div>
  )
})
