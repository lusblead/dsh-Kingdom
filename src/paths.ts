/**
 * dsh-kingdom — 路径解析。
 * kingdom.db 固定位于 DSH_HOME（或 ~/.dsh）下的 kingdom/ 子目录，
 * 自包含、位置固定、重启可恢复。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 解析 dsh 主目录：DSH_HOME 环境变量优先，否则 ~/.dsh。 */
export function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  if (env && env.trim().length > 0) return env.trim()
  return join(homedir(), '.dsh')
}

/** kingdom 数据根目录：<dshHome>/kingdom */
export function kingdomRoot(): string {
  return join(resolveDshHome(), 'kingdom')
}

/** kingdom 数据库文件：<dshHome>/kingdom/kingdom.db */
export function kingdomDbPath(): string {
  return join(kingdomRoot(), 'kingdom.db')
}
