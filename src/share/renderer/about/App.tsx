import Style from './App.module.scss'
import icon from '../../../renderer/assets/icon.png'

const CHANGES = [
  '4.0.0　更名「设备坞」：移除 APM 远程业务（账号登录、按 MAC 查设备、frpc 穿透），连接只保留 USB / 局域网',

  '3.0.8　应用页按需提取真实图标，缓存到本地，不再显示首字母占位',

  '3.0.7　侧栏预览改为 H264 实时流（30fps），全端口扫描提速约一倍',

  '3.0.6　3.0 自查修复：预览闪白、上传覆盖、扫描取消、日志布局',

  '3.0.2　侧栏可折叠、文件覆盖保护、应用页交互统一、英文覆盖补齐',

  '3.0.1　3.0 全量审查：丢数据 / 卡状态的边界问题与死代码清理',

  '3.0.0　3.0 UI 全量迁移：设备台壳层、原生标题栏、统一工具栏',
]

export default function App() {
  return (
    <div className={Style.container}>
      <img src={icon} />
      <div>
        {PRODUCT_NAME} {VERSION}
      </div>
      <div className={Style.changes}>
        <div className={Style.changesTitle}>更新内容</div>
        {CHANGES.map((c, i) => (
          <div key={i} className={Style.item}>
            {c}
          </div>
        ))}
      </div>
      <div className={Style.src}>
        设备坞 4.0 · AGPL-3.0 · 含 AYA (liriliri) 上游代码
      </div>
    </div>
  )
}
