import { ILoadingProps, LoadingBar } from 'share/renderer/components/loading'

/** 页面级加载遮罩：面板第一次加载时盖住内容区。 */
export const PannelLoading = function (props: ILoadingProps) {
  return (
    <div className="panel-loading" onClick={props.onClick}>
      <LoadingBar />
    </div>
  )
}
