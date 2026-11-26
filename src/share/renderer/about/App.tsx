import { useState } from 'react'
import Style from './App.module.scss'
import icon from '../../../renderer/assets/icon.png'
import { t } from 'common/util'

const CHANGES = [
  '4.1.2　麒麟 Android 6：应用元数据、进程加载和首次读取重试优化',

  '4.1.1　关于页支持一键导出脱敏诊断信息与失败操作 ID',

  '4.1.0　设备服务自动升级、索引流式加载、应用缓存边界与 Electron/AGP 工具链升级',

  '4.0.2　修复麒麟/Huawei 应用列表缺项、应用详情读取失败与 APK 导出失败',

  '4.0.1　麒麟/Huawei Android 兼容、Android 11 文件分页修复、目录索引完整性优化',

  '4.0.0　更名「设备坞」：移除 APM 远程业务（账号登录、按 MAC 查设备、frpc 穿透），连接只保留 USB / 局域网',

  '3.0.8　应用页按需提取真实图标，缓存到本地，不再显示首字母占位',

  '3.0.7　侧栏预览改为 H264 实时流（30fps），全端口扫描提速约一倍',

  '3.0.6　3.0 自查修复：预览闪白、上传覆盖、扫描取消、日志布局',

  '3.0.2　侧栏可折叠、文件覆盖保护、应用页交互统一、英文覆盖补齐',

  '3.0.1　3.0 全量审查：丢数据 / 卡状态的边界问题与死代码清理',

  '3.0.0　3.0 UI 全量迁移：设备台壳层、原生标题栏、统一工具栏',
]

export default function App() {
  const [exporting, setExporting] = useState(false)
  const [diagnosticStatus, setDiagnosticStatus] = useState('')

  async function exportDiagnostics() {
    setExporting(true)
    setDiagnosticStatus(t('diagnosticsExporting'))
    try {
      const result = await main.exportDiagnostics()
      setDiagnosticStatus(
        result.canceled
          ? ''
          : t('diagnosticsExported', { path: result.path || '' }),
      )
    } catch (error: any) {
      setDiagnosticStatus(
        t('diagnosticsFailed', { error: error?.message || error }),
      )
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={Style.aboutShell}>
      <img src={icon} />
      <div>
        {PRODUCT_NAME} {VERSION}
      </div>
      <button
        className={Style.diagnosticsButton}
        disabled={exporting}
        onClick={exportDiagnostics}
      >
        {exporting ? t('diagnosticsExporting') : t('exportDiagnostics')}
      </button>
      <div className={Style.diagnosticsHint}>{t('diagnosticsHint')}</div>
      {diagnosticStatus && (
        <div className={Style.diagnosticsStatus}>{diagnosticStatus}</div>
      )}
      <div className={Style.releaseNotes}>
        <div className={Style.releaseNotesTitle}>更新内容</div>
        {CHANGES.map((item, index) => (
          <div key={index} className={Style.releaseNotesItem}>
            {item}
          </div>
        ))}
      </div>
      <div className={Style.licenseLine}>
        设备坞 4.0 · MIT · 第三方组件见 NOTICE
      </div>
    </div>
  )
}
