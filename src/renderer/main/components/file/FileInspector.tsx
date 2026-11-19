/**
 * 右侧详情面板：单个文件/目录属性 + 预览，多选时显示汇总。
 */
import { observer } from 'mobx-react-lite'
import fileSize from 'licia/fileSize'
import dateFormat from 'licia/dateFormat'
import splitPath from 'licia/splitPath'
import isUndef from 'licia/isUndef'
import { IFile } from 'luna-file-list'
import { t } from 'common/util'
import FilePreview from 'share/renderer/components/FilePreview'
import Style from './FileInspector.module.scss'
import { iconOf, isPreviewable, modeOf, typeOf } from './fileUtil'

interface IProps {
  files: IFile[]
  file?: IFile
  url: string
  showPreview: boolean
  pathOf: (file: IFile) => string
  onOpen: (file: IFile) => void
  onDownload: (files: IFile[]) => void
  onInstall: (file: IFile) => void
  onRename: (file: IFile) => void
  onDelete: (files: IFile[]) => void
  onClose: () => void
}

export default observer(function FileInspector(props: IProps) {
  const { files, file, url, showPreview } = props
  const count = files.length

  if (!count) {
    return (
      <aside className={Style.inspector}>
        <div className={Style.head}>{t('fileDetails')}</div>
        <div className={Style.empty}>
          <span className="icon-open-file" />
          <div className={Style.emptyTitle}>{t('selectFileTip')}</div>
          <div className={Style.emptyHint}>{t('multiSelectTip')}</div>
        </div>
      </aside>
    )
  }

  // 多选汇总
  if (count > 1 || !file) {
    let totalSize = 0
    let dirCount = 0
    for (const item of files) {
      totalSize += item.size || 0
      if (item.directory) dirCount++
    }

    return (
      <aside className={Style.inspector}>
        <div className={Style.head}>
          {t('fileDetails')}
          <button
            className={Style.close}
            onClick={props.onClose}
            title={t('cancelSelection')}
          >
            <span className="icon-x" />
          </button>
        </div>
        <div className={Style.body}>
          <div className={Style.multi}>
            <span className="icon-open-file" />
            <div>
              <div className={Style.multiTitle}>
                {t('selectedItems', { count })}
              </div>
              <div className={Style.multiMeta}>{fileSize(totalSize)}</div>
            </div>
          </div>
          <div className={Style.props}>
            <div className={Style.prop}>
              <span className={Style.k}>{t('contains')}</span>
              <span className={Style.v}>
                {t('folderFileCount', {
                  dirs: dirCount,
                  files: count - dirCount,
                })}
              </span>
            </div>
          </div>
        </div>
        <div className={Style.actions}>
          <button
            className={Style.primary}
            onClick={() => props.onDownload(files)}
          >
            <span className="icon-download" />
            {t('downloadSelected')}
          </button>
          <button
            className={Style.dangerBtn}
            onClick={() => props.onDelete(files)}
          >
            <span className="icon-delete" />
            {t('deleteSelected')}
          </button>
        </div>
      </aside>
    )
  }

  const isDir = !!file.directory
  const isApk = splitPath(file.name).ext.toLowerCase() === '.apk'
  const previewable = !isDir && isPreviewable(file)
  const canPreview = previewable && showPreview && !!url

  return (
    <aside className={Style.inspector}>
      <div className={Style.head}>
        {t('fileDetails')}
        <button
          className={Style.close}
          onClick={props.onClose}
          title={t('cancelSelection')}
        >
          <span className="icon-x" />
        </button>
      </div>

      <div className={Style.body}>
        {canPreview ? (
          <div className={Style.preview}>
            <FilePreview file={file} url={url} />
          </div>
        ) : (
          <div className={Style.previewHead}>
            <div className={Style.tile}>
              <span className={iconOf(file)} />
            </div>
            <div className={Style.previewInfo}>
              <div className={Style.name}>{file.name}</div>
              <div className={Style.meta}>
                {isDir
                  ? typeOf(file, t('directory'))
                  : fileSize(file.size || 0)}
                {previewable && !showPreview ? ' · ' + t('previewOff') : ''}
              </div>
            </div>
          </div>
        )}

        <div className={Style.props}>
          <div className={Style.prop}>
            <span className={Style.k}>{t('pathLabel')}</span>
            <span className={Style.v}>{props.pathOf(file)}</span>
          </div>
          <div className={Style.prop}>
            <span className={Style.k}>{t('size')}</span>
            <span className={Style.v}>
              {isDir || isUndef(file.size) ? '—' : fileSize(file.size)}
            </span>
          </div>
          <div className={Style.prop}>
            <span className={Style.k}>{t('type')}</span>
            <span className={Style.v}>
              {typeOf(file, t('directory')) || t('file')}
            </span>
          </div>
          <div className={Style.prop}>
            <span className={Style.k}>{t('modifiedTime')}</span>
            <span className={Style.v}>
              {file.mtime
                ? dateFormat(file.mtime, 'yyyy-mm-dd HH:MM:ss')
                : '—'}
            </span>
          </div>
          <div className={Style.prop}>
            <span className={Style.k}>{t('permissions')}</span>
            <span className={Style.v}>{modeOf(file)}</span>
          </div>
        </div>
      </div>

      <div className={Style.actions}>
        {isDir ? (
          <>
            <button
              className={Style.primary}
              onClick={() => props.onOpen(file)}
            >
              <span className="icon-folder" />
              {t('openFolder')}
            </button>
            <button
              className={Style.btn}
              onClick={() => props.onDownload([file])}
            >
              <span className="icon-download" />
              {t('downloadToLocal')}
            </button>
          </>
        ) : (
          <>
            <button
              className={Style.primary}
              onClick={() => props.onDownload([file])}
            >
              <span className="icon-download" />
              {t('downloadToLocal')}
            </button>
            {isApk && (
              <button
                className={Style.btn}
                onClick={() => props.onInstall(file)}
              >
                <span className="icon-package" />
                {t('installToDevice')}
              </button>
            )}
          </>
        )}
        <div className={Style.links}>
          {!isDir && (
            <button onClick={() => props.onOpen(file)}>{t('open')}</button>
          )}
          <button onClick={() => props.onRename(file)}>{t('rename')}</button>
          <button
            className={Style.danger}
            onClick={() => props.onDelete([file])}
          >
            {t('delete')}
          </button>
        </div>
      </div>
    </aside>
  )
})
