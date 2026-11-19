export const DEVICE_PROTOCOL_VERSION = 2

export interface IDeviceServerVersion {
  version?: unknown
  protocolVersion?: unknown
}

export function isDeviceServerCompatible(
  info: IDeviceServerVersion | null | undefined,
  appVersion: string,
) {
  return (
    String(info?.version || '') === appVersion &&
    Number(info?.protocolVersion) === DEVICE_PROTOCOL_VERSION
  )
}
