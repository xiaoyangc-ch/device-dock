const KNOWN_LABELS: Record<string, string> = {
  android: 'Android',
  'com.android.settings': 'Settings',
  'com.android.providers.media': 'Media',
  'com.android.defcontainer': 'Default Container',
  'com.android.providers.settings': 'Settings Storage',
  'com.android.packageinstaller': 'Package Installer',
}

/** 设备端拿不到资源名时，至少提供稳定、可读的包名摘要。 */
export function packageLabelFallback(packageName: string) {
  if (KNOWN_LABELS[packageName]) return KNOWN_LABELS[packageName]

  const segments = packageName.split('.').filter(Boolean)
  const raw = (segments[segments.length - 1] || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (!raw) return packageName
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}
