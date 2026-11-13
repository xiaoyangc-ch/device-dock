import Graph from './components/Graph'
import ProcessMananger from './components/ProcessMananger'
import Toolbar from './components/Toolbar'
import LunaSplitPane, { LunaSplitPaneItem } from 'luna-split-pane/react'
import Style from './App.module.scss'

/** 进程面板：上表格下图表，中间可拖。 */
export default function App() {
  return (
    <>
      <Toolbar />
      <div className={Style.processSplit}>
        <LunaSplitPane direction="vertical">
          <LunaSplitPaneItem minSize={100} weight={50}>
            <ProcessMananger />
          </LunaSplitPaneItem>
          <LunaSplitPaneItem minSize={100} weight={50}>
            <Graph />
          </LunaSplitPaneItem>
        </LunaSplitPane>
      </div>
    </>
  )
}
