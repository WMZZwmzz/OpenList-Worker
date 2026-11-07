export const MoPanBaseURL = "https://mcloud.caiyun.feixin.10086.cn"
export const MoPanProxyFamily =
  "https://mcloud.caiyun.feixin.10086.cn/MoPanProxyFamily"

export const DefaultMpVersion = "1.1.202"
export const DefaultPlatform = "android"
export const DefaultOsVersion = "12"
export const DefaultModel = "M2102J2SC"
export const DefaultBrand = "Xiaomi"

export const TaskTypeCopy = 1
export const TaskTypeMove = 2
export const TaskTypeShareSave = 3
export const TaskTypeDelete = 4

export const TaskStatusPending = 1
export const TaskStatusConflict = 2
export const TaskStatusRunning = 3
export const TaskStatusCompleted = 4
export const TaskStatusFailed = 5

export const DefaultChunkSize = 10 * 1024 * 1024 // 10MB
export const DefaultUploadThreads = 3

import { randomHex } from "../rand"

export function createDefaultDeviceInfo(): string {
  // S-04 同类清单：设备指纹随机段改用 CSPRNG（原 Math.random）。
  const deviceInfo = {
    appVersion: "8.0.0",
    brand: DefaultBrand,
    deviceId: randomHex(16),
    deviceName: DefaultModel,
    imei: randomHex(16),
    imsi: randomHex(16),
    mac: randomHex(12).replace(/(..)/g, "$1:").replace(/:$/, ""),
    mno: "46000",
    model: DefaultModel,
    mpVersion: DefaultMpVersion,
    networkType: "wifi",
    osVersion: DefaultOsVersion,
    platform: DefaultPlatform,
  }

  return JSON.stringify(deviceInfo)
}
