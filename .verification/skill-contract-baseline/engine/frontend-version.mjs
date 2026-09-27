// 前端更新检测使用的单调版本戳。
// 旧版前端只读取 `version` 并按数字比较；产品页和排障则需要可读的 semver。
export function versionStamp(version) {
  const m = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return 0
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3])
}

export function frontendVersionPayload({ appVersion = '', html = '' } = {}) {
  let assetStamp = 0
  for (const m of String(html || '').matchAll(/[?&]v=(\d+)/g)) {
    assetStamp = Math.max(assetStamp, Number(m[1]))
  }
  const normalized = String(appVersion || '')
  return {
    // 保留旧 vanilla 前端的数字比较契约；hash 产物没有 ?v= 时也不再退回 0。
    version: Math.max(assetStamp, versionStamp(normalized)),
    appVersion: normalized,
  }
}
