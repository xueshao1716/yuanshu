// The lab is a separate local service. Never offer a loopback URL to remote clients.
export function voiceLabUrl(origin) {
  return origin === 'http://127.0.0.1:8787' ? 'http://127.0.0.1:8788/' : null
}
