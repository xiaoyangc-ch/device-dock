import LunaModal from 'luna-modal/react'
import { createPortal } from 'react-dom'
import { t } from 'common/util'
import Style from './PackageInfoModal.module.scss'
import defaultIcon from '../../../assets/default-icon.png'
import fileSize from 'licia/fileSize'
import md5 from 'licia/md5'
import dateFormat from 'licia/dateFormat'
import { IModalProps } from 'share/common/types'
import { Copyable } from '../common/Copyable'
import { IPackageInfo } from 'common/types'

interface IProps extends IModalProps {
  packageInfo: IPackageInfo
}

const DATE_FORMAT = 'yyyy-mm-dd HH:MM:ss'

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
            {packageInfo.versionName}
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
        dateFormat(new Date(packageInfo.firstInstallTime), DATE_FORMAT)
      )}
      {item(
        t('lastUpdateTime'),
        dateFormat(new Date(packageInfo.lastUpdateTime), DATE_FORMAT)
      )}
      {item(t('apkSize'), fileSize(packageInfo.apkSize))}
      {item(t('appSize'), fileSize(packageInfo.appSize))}
      {item(t('dataSize'), fileSize(packageInfo.dataSize))}
      {item(t('cacheSize'), fileSize(packageInfo.cacheSize))}
      {signature &&
        item(
          t('signature') + ' MD5',
          md5(signature)
        )}
    </LunaModal>,
    document.body
  )
}
