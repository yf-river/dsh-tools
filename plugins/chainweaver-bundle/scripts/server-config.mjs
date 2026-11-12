import { isIP } from 'node:net'
import { resolve } from 'node:path'

/** 将服务器配置转换成 DSH 已支持的启动参数。 */
export function serverArguments(config, root) {
  if (!isIP(config.host) || ['0.0.0.0', '::'].includes(config.host)) {
    throw new Error('host 必须是服务器上具体网卡的 IPv4 或 IPv6 地址')
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('port 必须是 1 到 65535 的整数')
  }
  const host = isIP(config.host) === 6 ? `[${config.host}]` : config.host
  const tls = config.tls
  if (tls && (!tls.certFile || !tls.keyFile)) throw new Error('tls 必须同时提供 certFile 和 keyFile')
  const origin = new URL(config.publicUrl ?? `${tls ? 'https' : 'http'}://${host}:${config.port}/`)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('publicUrl 必须是没有用户名、密码、query 或 fragment 的 HTTP(S) 地址')
  }
  const trustedHosts = config.trustedHosts ?? [origin.host]
  if (!Array.isArray(trustedHosts) || trustedHosts.some(host => typeof host !== 'string' || !host.trim())) {
    throw new Error('trustedHosts 必须是非空地址组成的数组')
  }
  return ['--profile', 'chainweaver', '--no-open', '--host', config.host, '--port', String(config.port),
    '--public-url', origin.href,
    ...trustedHosts.flatMap(host => ['--trusted-host', host]),
    ...(tls ? ['--tls-cert', resolve(root, tls.certFile), '--tls-key', resolve(root, tls.keyFile)] : [])]
}
