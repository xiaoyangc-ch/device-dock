import LunaModal from 'luna-modal/react'
import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { t } from 'common/util'
import Style from './PackageInfoModal.module.scss'
import defaultIcon from '../../../assets/default-icon.png'
import fileSize from 'licia/fileSize'
import dateFormat from 'licia/dateFormat'
import { IModalProps } from 'share/common/types'
import { Copyable } from '../common/Copyable'
import { IPackageInfo } from 'common/types'

interface IProps extends IModalProps {
  packageInfo: IPackageInfo
}

const DATE_FORMAT = 'yyyy-mm-dd HH:MM:ss'

function formatTimestamp(timestamp: number) {
  return timestamp > 0 ? dateFormat(new Date(timestamp), DATE_FORMAT) : '--'
}

function formatSize(size: number) {
  return size > 0 ? fileSize(size) : '--'
}

async function sha256Base64(value: string) {
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function item(title: string, value: string | number) {
  return (
    <div className={Style.pkgRow}>
      <span>{title}</span>
      <Copyable className={Style.pkgValue}>{value}</Copyable>
    </div>
  )
}

export default function PackageInfoModal(props: IProps) {
  const { packageInfo } = props
  const signature = packageInfo.signatures[0]
  const [fingerprint, setFingerprint] = useState('')

  useEffect(() => {
    let alive = true
    setFingerprint('')
    if (!signature) return
    sha256Base64(signature)
      .then((value) => {
        if (alive) setFingerprint(value)
      })
      .catch(() => {
        if (alive) setFingerprint('')
      })
    return () => {
      alive = false
    }
  }, [signature])

  return createPortal(
    <LunaModal
      title={t('packageInfo')}
      visible={props.visible}
      width={400}
      onClose={props.onClose}
    >
      <div className={Style.pkgHeader}>
        <div className={Style.pkgIcon}>
          <img src={packageInfo.icon || defaultIcon} />
        </div>
        <div className={Style.pkgBasic}>
          <div className={Style.pkgTitle}>{packageInfo.label}</div>
          <Copyable className={Style.pkgName}>
            {packageInfo.packageName}
          </Copyable>
          <Copyable className={Style.pkgVersion}>
            {packageInfo.versionName || '--'}
          </Copyable>
        </div>
      </div>
      {item(t('sysPackage'), packageInfo.system ? t('yes') : t('no'))}
      {!!packageInfo.minSdkVersion &&
        item(t('minSdkVersion'), packageInfo.minSdkVersion)}
      {!!packageInfo.targetSdkVersion &&
        item(t('targetSdkVersion'), packageInfo.targetSdkVersion)}
      {item(
        t('firstInstallTime'),
        formatTimestamp(packageInfo.firstInstallTime),
      )}
      {item(t('lastUpdateTime'), formatTimestamp(packageInfo.lastUpdateTime))}
      {item(t('apkSize'), formatSize(packageInfo.apkSize))}
      {item(t('appSize'), formatSize(packageInfo.appSize))}
      {item(t('dataSize'), formatSize(packageInfo.dataSize))}
      {item(t('cacheSize'), formatSize(packageInfo.cacheSize))}
      {fingerprint && item(t('signature') + ' SHA-256', fingerprint)}
    </LunaModal>,
    document.body,
  )
}
