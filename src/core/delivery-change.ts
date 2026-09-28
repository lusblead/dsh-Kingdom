/**
 * Owner 交付改动证据 —— 有界本地前后快照与内容寻址差异。
 *
 * ## 这份证据是什么，不是什么
 *
 * - 在执行**实际副作用前**冻结一份有界、脱敏的工作区基线（PRE），在同一
 *   Task/attempt 的 terminal / WorkerResult 落账**前**再冻结一份 POST；两者相减
 *   得到每文件差异，写入专用本机持久证据目录，并只把 manifest/hash 与有界元数据
 *   记入既有事件账本。
 * - 它证明的是「某 Task/attempt 窗口内观察到这些仓库相对路径发生了变化」。它
 *   **不证明 Git 作者身份**，也不证明是哪个 Worker 或进程写的，更不能替代主管
 *   审查或 Owner 验收。面板必须把它标注为「主管确认的改动证据」而不是作者证据。
 * - 未跟踪文件、任务前已脏文件、并行变化、超限/二进制/符号链接都按各自真实标签
 *   呈现；超限或无法判定时 `coverage.complete = false`，绝不静默说成完整覆盖。
 * - 候选路径**只**由 Git 自己枚举（`ls-files --cached --others --exclude-standard`
 *   加 `diff --name-only HEAD`），因此 `.gitignore` 排除的路径根本不会成为候选，
 *   正文也不会被打开或持久复制；不新增任何通用目录扫描器或秘密检测框架。
 *   VCS 忽略内容、证据目录自身、以及任何无法枚举的情形都如实记为部分覆盖。
 *
 * ## 边界
 *
 * - 不引入任何 schema 变更：新事实写进既有 events 账本，正文写文件系统。
 * - 不读任意请求路径：读回只接受内容寻址的 manifest id / entry id，并重验 hash。
 * - 采集失败不阻断执行：返回 `ok:false`，调用方据此不产生任何改动链接。
 * - 两侧正文都按同一个有界预算保留（每个快照各自计算），因此增删片段可见；
 *   预算耗尽时只保留摘要并如实标为部分覆盖。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { EventRow, KingdomStore } from './db.js'
import {
  CHANGE_EVIDENCE_LABEL, CHANGE_EVIDENCE_NOTE, redactDeliveryText, validateRepoRelativePath,
} from './delivery-ack.js'
import { kingdomRoot } from '../paths.js'
export { CHANGE_EVIDENCE_LABEL, CHANGE_EVIDENCE_NOTE }

export const DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE = 'DELIVERY_CHANGE_SNAPSHOT'
export const DELIVERY_CHANGE_MANIFEST_VERSION = 'KingdomDeliveryChangeManifest/v1'
export const DELIVERY_CHANGE_SNAPSHOT_VERSION = 'KingdomDeliveryWorkspaceSnapshot/v1'
export const CHANGE_EVIDENCE_DRIFT = '证据正文缺失或哈希漂移，不能作为可信改动定位。'

/** 采集与分析的有界上限；任何一项被触发都会如实反映为部分覆盖。 */
export interface DeliveryChangeBounds {
  maxFiles: number
  maxFileBytes: number
  /**
   * 单个文件的**完整内容 hash**上限；超过即无法完整比较，只能如实记 `UNKNOWN`，
   * 不得用「真实大小 + 有界首段」的前缀摘要冒充完整内容 hash。
   */
  maxHashBytes: number
  /** 单次采集允许读取的总字节数；超出后不再读取，未比较的文件必须如实计入部分覆盖。 */
  maxReadBytes: number
  maxStoredBytes: number
  maxDiffLines: number
  maxEntries: number
  /** Git 候选枚举的字节上限；超出即视为无法安全枚举，如实报失败而不是截断成「无改动」。 */
  maxCandidateBytes: number
  /** VCS 忽略样本的字节上限；只用于报告有多少内容被 ignore 规则排除，不读取其正文。 */
  maxIgnoredBytes: number
}
export const DEFAULT_DELIVERY_CHANGE_BOUNDS: DeliveryChangeBounds = Object.freeze({
  maxFiles: 2000, maxFileBytes: 262_144, maxHashBytes: 33_554_432, maxReadBytes: 33_554_432, maxStoredBytes: 4_194_304,
  maxDiffLines: 160, maxEntries: 200,
  maxCandidateBytes: 4_194_304, maxIgnoredBytes: 262_144,
})

/** VCS 忽略样本要保留多少条路径名（只保留路径名，绝不保留正文）。 */
const IGNORED_SAMPLE_LIMIT = 32

const HASH = /^[0-9a-f]{64}$/u
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

export type DeliveryChangePhase = 'PRE' | 'POST'
/**
 * `UNKNOWN` 只用于「无法证明是否变化」的候选：内容过长/不可读/是符号链接导致
 * 比较不可靠。它**不是**可由主管确认的改动条目，选择它会被拒绝。
 */
export type DeliveryChangeStatus = 'ADDED' | 'MODIFIED' | 'DELETED' | 'UNKNOWN'
export type DeliveryChangeEvidenceKind = 'SUPERVISOR_CONFIRMED_BOUNDED_WINDOW'

export interface DeliverySnapshotCoverage {
  complete: boolean
  observedFiles: number
  retainedFiles: number
  /** 因上限被跳过的条目数下界；达到文件或读取预算上限后不再继续读取。 */
  omittedByLimit: number
  /** 采集时无法读取、因此无法证明是否变化的候选数。 */
  omittedUnreadable: number
  skippedSymlinks: number
  skippedOversize: number
  binaryFiles: number
  /** 检测到 PEM 私钥/证书标记、因而**不保留正文**的候选数（只保留摘要）。 */
  sensitiveBodiesSkipped: number
  /**
   * 被 VCS ignore 规则排除、因而从未成为候选的路径数（只计数与保留路径名样本）。
   *
   * 这是**有意**的范围限定：候选集合本身完整、只是不含被忽略内容，所以它只让
   * `complete=false`，**不**使未忽略路径的「不在快照里 = 当时不存在」失效。
   */
  ignoredPaths: number
  /** 证据目录位于工作区内时被有意排除的路径数（避免把自身快照算成改动），同理不推断枚举被截断。 */
  evidenceRootExcluded: number
  reasons: string[]
  /** 被 VCS ignore 规则排除的路径名样本；只保留路径，不含正文。 */
  ignoredSamples: string[]
}

export type DeliveryFileReadability = 'READABLE' | 'ABSENT' | 'UNREADABLE' | 'SYMLINK'

export interface DeliveryWorkspaceFileObservation {
  /** 工作区内采集用的规范化相对路径；仅用于本地读取与条目身份，不直接作为公开展示路径。 */
  path: string
  /** 仓库相对路径；Owner 展示、主管候选与「查看改动」一律使用这一路径。 */
  repoPath: string | null
  size: number
  binary: boolean
  symlink: boolean
  oversize: boolean
  /**
   * 是否命中 PEM 私钥/证书标记、因而**不保留正文**。两侧任一为 `true` 时差异条目
   * 都不展示正文片段：否则未命中一侧的历史正文会把另一侧的主体带进公开视图。
   */
  sensitive: boolean
  /** 是否把脱敏后的正文写入了内容寻址 blob（两侧都保留，便于展示增删片段）。 */
  retained: boolean
  /** 完整内容摘要；无法完整读取（超限/部分读取）时为 null，绝不退化成前缀摘要。 */
  rawHash: string | null
  storedHash: string | null
  /** 采集时刻该路径的 `git status --porcelain` 代码；无 VCS 时为 null。 */
  vcs: string | null
  /** 本次采集对该路径的实际可读性判定；决定差异能否被证明。 */
  readability: DeliveryFileReadability
}

export interface DeliveryRepoIdentity {
  vcs: 'GIT' | 'UNAVAILABLE'
  /** 仓库身份的不可逆摘要，避免证据里出现本机绝对路径。 */
  identity: string | null
  head: string | null
  scope: 'REPO_ROOT' | 'WORKSPACE_SUBDIR' | 'OUTSIDE_REPO' | 'UNKNOWN'
  reason: string | null
}

export interface DeliveryWorkspaceSnapshot {
  version: typeof DELIVERY_CHANGE_SNAPSHOT_VERSION
  snapshotId: string
  phase: DeliveryChangePhase
  taskId: string
  attemptNo: number
  territoryId: string
  workspaceKey: string
  executionId: string | null
  leaseId: string | null
  dispatchId: string | null
  repo: DeliveryRepoIdentity
  capturedAt: string
  files: DeliveryWorkspaceFileObservation[]
  coverage: DeliverySnapshotCoverage
  /** 候选枚举本身的有界元数据（不含正文）：便于区分「无改动」与「没能枚举完整」。 */
  candidateScope: {
    kind: 'VCS_CANDIDATES'
    candidateCount: number
    pathspec: string
    evidencePrefix: string | null
    evidenceRootExcluded: number
  }
  /**
   * 该时刻的候选集合是否**完整可信**：本快照里「没有该路径」是否可以当成「它当时不存在」。
   *
   * 只有下列条件同时成立才为 `true`：候选枚举未被文件/读取预算截断，也没有读不出来的候选。
   *
   * `.gitignore` 排除的内容与证据目录自身是**有意**待在候选集合之外的范围限定：候选
   * 枚举本身是完整的，因此它们只如实记为部分覆盖（`coverage.reasons`），**不**推断
   * 「未忽略路径的存在性不可证明」。把有意排除当成枚举截断会让真实新增无法确认。
   */
  enumerationComplete: boolean
  /**
   * 被 ignore 规则排除的路径身份（工作区相对）；只含路径名，不含任何正文。
   *
   * 增删判定不只看「该路径在不在快照里」，还要看它是否出现在**另一时点**的这份身份
   * 集合中：只改忽略规则时，内容未变的旧文件会离开或进入候选集合，那个缺项其实是被
   * ignore，既不是窗口内新增也不是窗口内删除。
   */
  ignoredPathIdentities: string[]
  /**
   * 上述身份集合是否完整可信（枚举未被字节上限截断）。
   *
   * `false` 时不得把「路径不在集合里」当成「它当时未被忽略」：增删判定必须 fail-closed，
   * 否则无法排除「另一个时点其实被 ignore」这一可能。
   */
  ignoredPathsComplete: boolean
}

export interface DeliveryChangeHunk {
  kind: 'ADDED' | 'REMOVED'
  beforeLine: number | null
  afterLine: number | null
  text: string
}

export interface DeliveryChangeEntry {
  entryId: string
  /** 工作区相对路径；本地读取与身份用，不作为公开展示路径。 */
  path: string
  /** 仓库相对路径（Owner 详情、主管候选与工作台固定展示这一条）。 */
  repoPath: string
  status: DeliveryChangeStatus
  reasonCode: string
  labels: string[]
  note: string
  binary: boolean
  bodyRetained: boolean
  beforeHash: string | null
  afterHash: string | null
  /** 基线正文未保留（预算/二进制/超限）时无法展示删除片段。 */
  baselineBodyUnavailable: boolean
  hunks: DeliveryChangeHunk[]
}

export interface DeliveryChangeManifest {
  version: typeof DELIVERY_CHANGE_MANIFEST_VERSION
  evidenceId: string
  taskId: string
  attemptNo: number
  territoryId: string
  workspaceKey: string
  repo: DeliveryRepoIdentity
  executionId: string | null
  leaseId: string | null
  dispatchId: string | null
  pre: { snapshotId: string; capturedAt: string; coverage: DeliverySnapshotCoverage }
  post: { snapshotId: string; capturedAt: string; coverage: DeliverySnapshotCoverage }
  entries: DeliveryChangeEntry[]
  coverage: { complete: boolean; reasons: string[]; entryCount: number; omitted: number }
  note: string
  createdAt: string
}

/** 主管 ACCEPT 时显式选中的改动引用（写入 TASK_ACCEPTED payload）。 */
export interface DeliveryChangeEvidenceRef {
  kind: DeliveryChangeEvidenceKind
  evidenceId: string
  attemptNo: number
  entryIds: string[]
  selectionDigest: string
  entryCount: number
  selectedCount: number
  coverageComplete: boolean
  coverageReasons: string[]
  repoHead: string | null
  note: string
}

// ── 目录与原子落盘 ───────────────────────────────────────────────────

export interface DeliveryEvidencePaths {
  root: string
  snapshots: string
  blobs: string
  manifests: string
}

/**
 * 交付改动证据的专用本机持久目录：<dshHome>/kingdom/delivery-evidence。
 *
 * 只保存有界、脱敏、内容寻址的快照与差异；不接触 kingdom.db 本身。
 * `DSH_KINGDOM_EVIDENCE_ROOT` 只用于把测试指向一次性临时目录。
 */
export function deliveryEvidenceRoot(): string {
  const env = process.env.DSH_KINGDOM_EVIDENCE_ROOT
  if (env && env.trim().length > 0) return env.trim()
  return join(kingdomRoot(), 'delivery-evidence')
}

export function deliveryEvidencePaths(evidenceRoot?: string): DeliveryEvidencePaths {
  const root = evidenceRoot && evidenceRoot.trim() ? evidenceRoot.trim() : deliveryEvidenceRoot()
  return { root, snapshots: join(root, 'snapshots'), blobs: join(root, 'blobs'), manifests: join(root, 'manifests') }
}

let atomicCounter = 0

function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.tmp-${process.pid}-${atomicCounter++}`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, file)
}

function writeContentAddressed(directory: string, body: string): string {
  const digest = sha256(body)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, digest)
  if (!existsSync(file)) writeAtomic(file, body)
  return digest
}

/**
 * 只在目录内按内容摘要读取。任何路径拼接或非摘要输入都直接拒绝，
 * 保证读取端不能借证据 id 读取任意本机文件。
 */
function readContentAddressed(directory: string, digest: string): string | null {
  if (!HASH.test(digest)) return null
  const file = join(directory, digest)
  try {
    const body = readFileSync(file, 'utf8')
    return sha256(body) === digest ? body : null
  } catch { return null }
}

/**
 * 按「规范化正文摘要」命名的文件读取。
 *
 * manifest 与 snapshot 的文件名是**规范化正文**（去掉自身 id 字段）的摘要，
 * 因此不能用完整文件内容的摘要去比对文件名；调用方必须用自己的规范化函数
 * 重新计算摘要并核对，才是真正的 hash 重验。
 */
function readNamedRecord(directory: string, digest: string): string | null {
  if (!HASH.test(digest)) return null
  try { return readFileSync(join(directory, `${digest}.json`), 'utf8') } catch { return null }
}

export function readChangeBlob(evidenceRoot: string | undefined, storedHash: string): string | null {
  return readContentAddressed(deliveryEvidencePaths(evidenceRoot).blobs, storedHash)
}

// ── VCS 观测与候选枚举（Git 自己枚举，不写通用扫描器）────────────────

interface VcsObservation {
  repo: DeliveryRepoIdentity
  /** 规范化后的仓库根目录；用于把候选路径翻译成工作区相对路径。 */
  repoRoot: string | null
  /** 工作区相对仓库根的路径前缀（`''` 表示工作区就是仓库根）。 */
  workspacePrefix: string
}

/** 一次有界 git 探测的结果；`truncated` 表示输出超过我们愿意读取的上限。 */
interface GitProbe {
  ok: boolean
  stdout: string
  truncated: boolean
}

const GIT_PROBE_CEILING = 33_554_432

/**
 * 运行一次有界的 git 探测。
 *
 * 本机沙箱会拒绝父/子进程之间的匿名管道，因此 stdout 重定向到真实文件再读回
 * （而不是 `encoding: 'utf8'` 的管道）。stderr **必须与 stdout 分开**：Git 会把
 * `LF will be replaced by CRLF` 之类的 warning 写到 stderr，两者混在同一文件里
 * 会污染路径清单，让真实改动被判成「无差异」。超时或非零退出都只表示
 * `UNAVAILABLE`，不会伪造 VCS 事实。输出超过上限时**带 `truncated` 返回**，
 * 调用方必须据此报失败或部分覆盖，不能把截断当成「没有改动」。
 */
function runGit(cwd: string, args: string[], options: { timeoutMs?: number; maxBytes: number }): GitProbe {
  let directory: string | null = null
  let outFd: number | null = null
  let errFd: number | null = null
  try {
    directory = mkdtempSync(join(tmpdir(), 'kingdom-git-'))
    const out = join(directory, 'out.txt')
    const err = join(directory, 'err.txt')
    outFd = openSync(out, 'w')
    errFd = openSync(err, 'w')
    const result = spawnSync('git', ['-C', cwd, ...args], { stdio: ['ignore', outFd, errFd], timeout: options.timeoutMs ?? 5000, windowsHide: true })
    closeSync(outFd); outFd = null
    closeSync(errFd); errFd = null
    if (result.error || result.status !== 0) return { ok: false, stdout: '', truncated: false }
    const size = statSync(out).size
    if (size > options.maxBytes) return { ok: true, stdout: '', truncated: true }
    return { ok: true, stdout: readFileSync(out, 'utf8'), truncated: false }
  } catch {
    return { ok: false, stdout: '', truncated: false }
  } finally {
    if (outFd !== null) { try { closeSync(outFd) } catch { /* already closed */ } }
    if (errFd !== null) { try { closeSync(errFd) } catch { /* already closed */ } }
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
}

/** 把 Git 输出的仓库相对路径拆成规范化的非空路径列表（忽略空项与非法路径）。 */
function parsePathList(value: string): string[] {
  const paths: string[] = []
  for (const raw of value.split('\u0000')) {
    const safe = validateRepoRelativePath(raw)
    if (safe) paths.push(safe)
  }
  return paths
}

function observeVcs(workspacePath: string): VcsObservation {
  const unavailable = (reason: string, scope: DeliveryRepoIdentity['scope'] = 'UNKNOWN'): VcsObservation => ({
    repo: { vcs: 'UNAVAILABLE', identity: null, head: null, scope, reason },
    repoRoot: null, workspacePrefix: '',
  })
  const top = runGit(workspacePath, ['rev-parse', '--show-toplevel'], { maxBytes: 65_536 })
  if (!top.ok) return unavailable('工作区不是可读的 Git 仓库或 git 不可用。')
  const repoRoot = (() => {
    try { return realpathSync.native(top.stdout.trim()) } catch { return null }
  })()
  if (!repoRoot) return unavailable('Git 仓库根目录无法解析。')
  const workspace = (() => {
    try { return realpathSync.native(workspacePath) } catch { return null }
  })()
  const scope: DeliveryRepoIdentity['scope'] = workspace === repoRoot
    ? 'REPO_ROOT'
    : workspace && within(repoRoot, workspace) ? 'WORKSPACE_SUBDIR' : 'OUTSIDE_REPO'
  if (scope === 'OUTSIDE_REPO') return unavailable('领地工作区不在该 Git 仓库内，VCS 基准不可用。', scope)
  const workspacePrefix = scope === 'WORKSPACE_SUBDIR' && workspace
    ? relative(repoRoot, workspace).split(sep).join('/')
    : ''
  const head = runGit(workspacePath, ['rev-parse', 'HEAD'], { maxBytes: 65_536 })
  // 脏/未跟踪分类由候选枚举的同一批 `ls-files` 输出给出，此处不再单独跑 `git status`。
  return {
    repo: { vcs: 'GIT', identity: sha256(repoRoot).slice(0, 32), head: head.ok ? head.stdout.trim() || null : null, scope, reason: null },
    repoRoot, workspacePrefix,
  }
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

interface CandidateEnumeration {
  /** 工作区相对路径，已排序去重、且已排除证据目录自身。 */
  paths: string[]
  /** 工作区相对路径前缀；空串表示工作区即仓库根。 */
  evidencePrefix: string | null
  ignoredPaths: number
  ignoredSamples: string[]
  /**
   * 被 ignore 规则排除的路径身份（工作区相对），只含路径名、不含任何正文。
   *
   * 用于判断某时点的缺项到底是「当时被 ignore」还是「当时确实不存在」：只改忽略规则
   * 会让内容未变的旧文件离开或进入候选集合，缺项身份是唯一能区分两者的有界依据。
   */
  ignoredIdentities: string[]
  /** 该身份集合是否完整可信；`false` 时不得把「不在集合里」当成「当时未被忽略」。 */
  ignoredComplete: boolean
  evidenceRootExcluded: number
  /** 该时刻相对 VCS 基准已脏的路径 → 分类码；未跟踪文件记为 `'??'`。 */
  dirty: Map<string, string>
}

type CandidateResult = { ok: true; value: CandidateEnumeration } | { ok: false; code: string; reason: string }

/**
 * 由 Git 自己枚举候选路径：已跟踪文件 ∪ 未跟踪但**未被 ignore** 的文件。
 *
 * `--exclude-standard` 让 Git 自己结算**全部** ignore 规则（工作区**内部**任意深度的
 * `.gitignore`、工作区到仓库根之间每一层 `.gitignore`、`.git/info/exclude` 与
 * `core.excludesFile`）并直接决定候选集合：被忽略的私有文件既不会出现在这里，也不会
 * 在后续被打开正文或持久复制。被排除路径身份的枚举同样由 Git 自己给出并有字节上限，
 * 不靠「看起来有没有规则」的预判。整个候选集合的读取量受 `maxReadBytes` 限制，超出即
 * 如实记为部分覆盖，因此不会把整仓正文读进内存或写进证据目录。任一命令失败或输出超限
 * 都返回失败——宁可没有改动证据，也不截断成「没有改动」；有意排除（证据目录自身）单独
 * 计数并保持部分覆盖。
 */
function enumerateCandidates(workspacePath: string, vcs: VcsObservation, bounds: DeliveryChangeBounds, evidenceRoot: string): CandidateResult {
  if (vcs.repo.vcs !== 'GIT' || !vcs.repoRoot) {
    return { ok: false, code: 'VCS_ENUMERATION_UNAVAILABLE',
      reason: '没有可用的 Git 基准，无法界定本次窗口的候选路径；不采集工作区正文。' }
  }
  // 所有 Git 调用都从**仓库根**执行，pathspec 与输出因此都是**根相对**的：
  // 子目录 Territory（workspace 是仓库子目录）下若从 workspacePath 执行，Git 会把
  // 根相对 pathspec 当成工作区相对路径，即使真实改动存在也会枚举为空。
  const gitCwd = vcs.repoRoot
  const pathspec = vcs.workspacePrefix ? [vcs.workspacePrefix] : ['.']
  const tracked = runGit(gitCwd, ['ls-files', '-z', '--cached', '--', ...pathspec], { maxBytes: bounds.maxCandidateBytes })
  if (!tracked.ok || tracked.truncated) {
    return { ok: false, code: 'VCS_ENUMERATION_FAILED',
      reason: 'Git 已跟踪清单不可读或输出超限；不为该 attempt 生成任何改动链接。' }
  }
  const others = runGit(gitCwd, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...pathspec], { maxBytes: bounds.maxCandidateBytes })
  if (!others.ok || others.truncated) {
    return { ok: false, code: 'VCS_ENUMERATION_FAILED',
      reason: 'Git 未跟踪候选枚举失败或输出超限；不为该 attempt 生成任何改动链接。' }
  }
  const diff = runGit(gitCwd, ['diff', '--name-only', '-z', 'HEAD', '--', ...pathspec], { maxBytes: bounds.maxCandidateBytes })
  if (!diff.ok || diff.truncated) {
    return { ok: false, code: 'VCS_ENUMERATION_FAILED',
      reason: 'Git 与 HEAD 的差异清单不可读或超限；不为该 attempt 生成任何改动链接。' }
  }
  // 被 ignore 排除的路径身份**一律**交给 Git 自己枚举（`--exclude-standard`），不做
  // 「本仓库/本工作区看起来有没有规则」的预判：规则可能来自工作区**内部**任意深度的
  // `.gitignore`，也可能来自 linked worktree 的 `.git/worktrees/<id>/info/exclude`；
  // 任何一层漏检都会让 `ignoredComplete` 假报为 true，从而把只改忽略规则、内容一字未改
  // 的旧文件写成可确认的假新增/假删除。枚举本身有字节上限：一旦失败或超限，
  // `ignoredComplete` 即为 false——不得默认「未忽略」。
  const ignored = runGit(gitCwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...pathspec], { maxBytes: bounds.maxIgnoredBytes })
  const ignoredComplete = ignored.ok && !ignored.truncated

  const evidencePrefix = evidencePrefixFor(vcs.repoRoot, workspacePath, evidenceRoot)
  const trackedPaths = new Set(tracked.stdout.split('\u0000'))
  const untrackedPaths = new Set(others.stdout.split('\u0000'))
  const changedPaths = new Set(diff.stdout.split('\u0000'))
  const paths = new Set<string>()
  const dirty = new Map<string, string>()
  let evidenceRootExcluded = 0
  for (const entry of [...new Set([...trackedPaths, ...untrackedPaths, ...changedPaths])]) {
    const mapped = mapRepoRelativeToWorkspace(entry, vcs.workspacePrefix)
    if (mapped === null) continue
    if (evidencePrefix !== null && (mapped === evidencePrefix || mapped.startsWith(`${evidencePrefix}/`))) {
      evidenceRootExcluded += 1
      continue
    }
    paths.add(mapped)
    if (dirty.has(mapped)) continue
    // 未跟踪（且未被 ignore）优先于「相对 HEAD 有差异」：它的基线本来就不在版本库内。
    if (untrackedPaths.has(entry) && !trackedPaths.has(entry)) dirty.set(mapped, '??')
    else if (changedPaths.has(entry)) dirty.set(mapped, ' M')
  }
  const ignoredPaths = parsePathList(ignored.stdout)
  const ignoredIdentities = new Set<string>()
  for (const entry of ignoredPaths) {
    const mapped = mapRepoRelativeToWorkspace(entry, vcs.workspacePrefix)
    if (mapped !== null) ignoredIdentities.add(mapped)
  }
  return {
    ok: true,
    value: {
      paths: [...paths].sort((a, b) => a.localeCompare(b)),
      evidencePrefix,
      ignoredPaths: ignoredPaths.length,
      ignoredSamples: ignoredPaths.slice(0, IGNORED_SAMPLE_LIMIT),
      ignoredIdentities: [...ignoredIdentities].sort((a, b) => a.localeCompare(b)),
      ignoredComplete,
      evidenceRootExcluded,
      dirty,
    },
  }
}

/** 证据目录相对工作区的路径前缀；不在工作区内（或就是工作区本身）时为 null。 */
function evidencePrefixFor(repoRoot: string, workspacePath: string, evidenceRoot: string): string | null {  let resolvedRoot: string
  let resolvedEvidence: string
  try {
    resolvedRoot = realpathSync.native(repoRoot)
    resolvedEvidence = realpathSync.native(evidenceRoot)
  } catch { return null }
  if (!within(resolvedRoot, resolvedEvidence)) return null
  const relativeToWorkspace = relative(workspacePath, resolvedEvidence).split(sep).join('/')
  if (!relativeToWorkspace || relativeToWorkspace === '.') return null
  if (relativeToWorkspace.startsWith('..') || isAbsolute(relativeToWorkspace)) return null
  return relativeToWorkspace
}

/** 把仓库相对路径映射成工作区相对路径；不在工作区内或非法时返回 null。 */
function mapRepoRelativeToWorkspace(path: string, workspacePrefix: string): string | null {
  if (!workspacePrefix) return validateRepoRelativePath(path)
  if (path === workspacePrefix) return null
  if (!path.startsWith(`${workspacePrefix}/`)) return null
  return validateRepoRelativePath(path.slice(workspacePrefix.length + 1))
}

/**
 * 把工作区相对路径还原成**仓库相对路径**（合同要求公开展示路径）。
 *
 * 工作区就是仓库根（`workspacePrefix` 为空）时两者相同；工作区是仓库子目录时
 * 补回该前缀，例如子目录领地里的 `app.ts` → `src/app.ts`。函数只做前缀拼接并
 * 复用既有仓库相对路径校验，不引入本机绝对路径，也不新增路径解析层。
 */
function repoRelativePath(path: string, workspacePrefix: string): string {
  return validateRepoRelativePath(workspacePrefix ? `${workspacePrefix}/${path}` : path)
    ?? validateRepoRelativePath(path)
    ?? path
}

// ── 有界工作区采集 ───────────────────────────────────────────────────

export type CaptureSnapshotResult =
  | { ok: true; snapshot: DeliveryWorkspaceSnapshot; snapshotFile: string }
  | { ok: false; code: string; reason: string }

export interface CaptureSnapshotInput {
  workspacePath: string
  taskId: string
  attemptNo: number
  territoryId: string
  phase: DeliveryChangePhase
  executionId?: string | null
  leaseId?: string | null
  dispatchId?: string | null
  evidenceRoot?: string
  bounds?: Partial<DeliveryChangeBounds>
  now?: string
}

function isBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192)
  for (let index = 0; index < limit; index += 1) if (buffer[index] === 0) return true
  return false
}

/** PEM 私钥/证书正文标记：命中即不保留正文（现有交付文本脱敏遮不住 base64 主体）。 */
const PEM_MARKER = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|PUBLIC KEY)[A-Z0-9 ]*-----/u

/**
 * 冻结一份有界工作区快照。**永不抛出**：采集失败只返回 `ok:false`，
 * 调用方据此不产生任何改动链接，而不是把失败伪装成空差异。
 *
 * 候选路径全部来自 Git（见 {@link enumerateCandidates}）：没有可用的 Git 基准、
 * 枚举失败或输出超限时直接返回失败，绝不退化成「扫描任意工作区正文」。
 */
export function captureWorkspaceSnapshot(input: CaptureSnapshotInput): CaptureSnapshotResult {
  try {
    const bounds = { ...DEFAULT_DELIVERY_CHANGE_BOUNDS, ...(input.bounds ?? {}) }
    const paths = deliveryEvidencePaths(input.evidenceRoot)
    let workspace: string
    try { workspace = realpathSync.native(input.workspacePath) } catch {
      return { ok: false, code: 'WORKSPACE_UNREADABLE', reason: '领地工作区不存在或不可解析，未采集快照。' }
    }
    let stat
    try { stat = statSync(workspace) } catch {
      return { ok: false, code: 'WORKSPACE_UNREADABLE', reason: '领地工作区不可读取，未采集快照。' }
    }
    if (!stat.isDirectory()) return { ok: false, code: 'WORKSPACE_NOT_DIRECTORY', reason: '领地工作区不是目录，未采集快照。' }

    const vcs = observeVcs(workspace)
    const candidates = enumerateCandidates(workspace, vcs, bounds, paths.root)
    if (!candidates.ok) return { ok: false, code: candidates.code, reason: candidates.reason }
    const scope = candidates.value

    const coverage: DeliverySnapshotCoverage = { complete: true, observedFiles: 0, retainedFiles: 0, omittedByLimit: 0,
      omittedUnreadable: 0, skippedSymlinks: 0, skippedOversize: 0, binaryFiles: 0, sensitiveBodiesSkipped: 0,
      ignoredPaths: scope.ignoredPaths, evidenceRootExcluded: scope.evidenceRootExcluded, reasons: [], ignoredSamples: scope.ignoredSamples }
    if (scope.ignoredPaths > 0) {
      // 被 ignore 规则排除的私有内容从未成为候选、正文也从未被打开：这是有意的
      // 范围限定，但必须如实报成部分覆盖，不能悄悄说成「已完整检查」。
      coverage.complete = false
      coverage.reasons.push('IGNORED_CONTENT_EXCLUDED')
    }
    if (!scope.ignoredComplete) {
      // 被 ignore 排除的路径身份没能完整确认：不得默认「未忽略」，否则增删判定会把
      // 一个其实只是被 ignore 的旧文件写成窗口内新增/删除。如实记部分覆盖。
      coverage.complete = false
      coverage.reasons.push('IGNORED_SCOPE_UNCONFIRMED')
    }
    if (scope.evidenceRootExcluded > 0) {
      coverage.complete = false
      coverage.reasons.push('EVIDENCE_ROOT_EXCLUDED')
    }

    const files: DeliveryWorkspaceFileObservation[] = []
    let storedBytes = 0
    let readBytes = 0
    /**
     * 预算或读取上限耗尽时只能记「本快照没有读取/枚举到该候选」，**不能**记成
     * `ABSENT`：文件未进入快照不等于它当时不存在。因此这里给出的是
     * `readability='UNREADABLE'` 的有界占位观察，差异端据此只能得到 `UNKNOWN`。
     */
    const omittedObservation = (relativePath: string): DeliveryWorkspaceFileObservation => ({
      path: relativePath, repoPath: repoRelativePath(relativePath, vcs.workspacePrefix),
      size: 0, binary: false, symlink: false, oversize: false, sensitive: false,
      retained: false, rawHash: null, storedHash: null, vcs: scope.dirty.get(relativePath) ?? null,
      readability: 'UNREADABLE',
    })
    for (const relativePath of scope.paths) {
      if (files.length >= bounds.maxFiles) {
        coverage.complete = false
        coverage.omittedByLimit += 1
        if (!coverage.reasons.includes('FILE_LIMIT_REACHED')) coverage.reasons.push('FILE_LIMIT_REACHED')
        files.push(omittedObservation(relativePath))
        continue
      }
      if (readBytes >= bounds.maxReadBytes) {
        coverage.complete = false
        coverage.omittedByLimit += 1
        if (!coverage.reasons.includes('READ_BUDGET_REACHED')) coverage.reasons.push('READ_BUDGET_REACHED')
        files.push(omittedObservation(relativePath))
        continue
      }
      const observation = observeFile(join(workspace, relativePath), relativePath, vcs.workspacePrefix, paths.blobs,
        bounds, coverage, () => storedBytes, (bytes) => { storedBytes += bytes }, (bytes) => { readBytes += bytes },
        scope.dirty.get(relativePath) ?? null)
      files.push(observation)
    }

    const snapshot: DeliveryWorkspaceSnapshot = {
      version: DELIVERY_CHANGE_SNAPSHOT_VERSION,
      snapshotId: '',
      phase: input.phase,
      taskId: input.taskId,
      attemptNo: input.attemptNo,
      territoryId: input.territoryId,
      workspaceKey: sha256(workspace),
      executionId: input.executionId ?? null,
      leaseId: input.leaseId ?? null,
      dispatchId: input.dispatchId ?? null,
      repo: vcs.repo,
      capturedAt: input.now ?? new Date().toISOString(),
      files,
      coverage,
      candidateScope: {
        kind: 'VCS_CANDIDATES',
        candidateCount: scope.paths.length,
        pathspec: vcs.workspacePrefix || '.',
        evidencePrefix: scope.evidencePrefix,
        evidenceRootExcluded: scope.evidenceRootExcluded,
      },
      // 「本快照没有该路径」只有在候选集合完整可信时才能当成「它当时不存在」。
      // 读不出来的候选仍然出现在快照里（`UNREADABLE` + 有界摘要），属于「有观察、
      // 无结论」，由差异端单独转 `UNKNOWN`，因此不计入这里的枚举完整性。
      //
      // `.gitignore` 排除内容与证据目录自身**不**在此列：它们是候选集合的**有意**范围
      // 限定，候选枚举本身没有被截断。把有意排除当截断会让未忽略路径的真实新增/删除
      // 全部降级为 `UNKNOWN`，与「候选集合已被完整枚举」的事实矛盾。
      enumerationComplete: coverage.omittedByLimit === 0,
      // 被 ignore 排除的路径身份（只含路径名）与其完整性：增删判定据此区分「当时被
      // ignore」与「当时确实不存在」。这份集合无法完整确认时，`ignoredPathsComplete`
      // 为 false，差异端必须 fail-closed，不得默认「未忽略」。
      ignoredPathIdentities: scope.ignoredIdentities,
      ignoredPathsComplete: scope.ignoredComplete,
    }
    const body = JSON.stringify({ ...snapshot, snapshotId: '' })
    snapshot.snapshotId = sha256(body)
    const snapshotFile = join(paths.snapshots, `${snapshot.snapshotId}.json`)
    mkdirSync(paths.snapshots, { recursive: true })
    if (!existsSync(snapshotFile)) writeAtomic(snapshotFile, JSON.stringify(snapshot))
    return { ok: true, snapshot, snapshotFile }
  } catch (error: unknown) {
    return { ok: false, code: 'SNAPSHOT_CAPTURE_FAILED',
      reason: `快照采集失败，未产生改动证据：${error instanceof Error ? error.message.slice(0, 200) : '未知错误'}` }
  }
}

/** 有界读取一个文件；调用方已按 `maxHashBytes` 限定大小。 */
function readBounded(absolute: string, limit: number): Buffer {
  const fd = openSync(absolute, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const bytes = readSync(fd, buffer, 0, limit, 0)
    return buffer.subarray(0, bytes)
  } finally { closeSync(fd) }
}

function observeFile(
  absolute: string,
  relativePath: string,
  workspacePrefix: string,
  blobDirectory: string | null,
  bounds: DeliveryChangeBounds,
  coverage: DeliverySnapshotCoverage,
  storedBytes: () => number,
  addStoredBytes: (bytes: number) => void,
  addReadBytes: (bytes: number) => void,
  vcsCode: string | null,
): DeliveryWorkspaceFileObservation {
  const base: DeliveryWorkspaceFileObservation = { path: relativePath, repoPath: repoRelativePath(relativePath, workspacePrefix),
    size: 0, binary: false, symlink: false, oversize: false,
    sensitive: false, retained: false, rawHash: null, storedHash: null, vcs: vcsCode, readability: 'UNREADABLE' }
  let stat
  try {
    stat = lstatSync(absolute)
  } catch {
    // 采集瞬间文件已不在：这只表示「该时刻不存在」，不是读取失败。
    return { ...base, readability: 'ABSENT' }
  }
  if (stat.isSymbolicLink()) {
    coverage.skippedSymlinks += 1
    coverage.reasons.push('SYMLINK_SKIPPED')
    return { ...base, symlink: true, readability: 'SYMLINK' }
  }
  if (!stat.isFile()) return { ...base, readability: 'ABSENT' }
  coverage.observedFiles += 1
  const size = stat.size
  const oversize = size > bounds.maxFileBytes
  if (oversize) { coverage.skippedOversize += 1; coverage.reasons.push('FILE_SIZE_LIMIT_REACHED') }
  // 完整内容摘要必须覆盖整个文件：带大小前缀的「首段摘要」会把只在尾部变化的
  // 超限文件错判成「未变化」。超过可完整比较上限时不再猜测，直接 `UNREADABLE`。
  if (size > bounds.maxHashBytes) {
    coverage.omittedUnreadable += 1
    coverage.complete = false
    if (!coverage.reasons.includes('CONTENT_HASH_LIMIT_REACHED')) coverage.reasons.push('CONTENT_HASH_LIMIT_REACHED')
    return { ...base, size, oversize, readability: 'UNREADABLE' }
  }
  let buffer: Buffer
  try {
    buffer = readBounded(absolute, size)
  } catch {
    coverage.omittedUnreadable += 1
    coverage.complete = false
    coverage.reasons.push('FILE_UNREADABLE')
    return { ...base, size, oversize, readability: 'UNREADABLE' }
  }
  addReadBytes(buffer.length)
  // 读回字节数不足（采集瞬间被截断/并发改写）时完整摘要不可得：同样不猜。
  const rawHash = buffer.length === size ? sha256(buffer) : null
  const binary = isBinary(buffer)
  if (binary) coverage.binaryFiles += 1
  if (rawHash === null) {
    coverage.omittedUnreadable += 1
    coverage.complete = false
    if (!coverage.reasons.includes('CONTENT_HASH_INCOMPLETE')) coverage.reasons.push('CONTENT_HASH_INCOMPLETE')
    return { ...base, size, oversize, binary, readability: 'UNREADABLE' }
  }
  const observation: DeliveryWorkspaceFileObservation = { ...base, size, binary, oversize, rawHash, readability: 'READABLE' }
  if (binary || blobDirectory === null) return observation
  // PEM 主体无法被文本脱敏遮住：必须在**原始缓冲**上、写 blob 之前判定。
  // 若先脱敏再测标记，`-----BEGIN PRIVATE KEY-----` 已被替换，主体会被持久写入。
  if (PEM_MARKER.test(buffer.toString('utf8'))) {
    coverage.sensitiveBodiesSkipped += 1
    coverage.complete = false
    coverage.reasons.push('SENSITIVE_BODY_NOT_RETAINED')
    return { ...observation, sensitive: true }
  }
  if (oversize) return observation
  const text = redactDeliveryText(buffer.toString('utf8'))
  if (storedBytes() + buffer.length > bounds.maxStoredBytes) {
    coverage.reasons.push('STORED_BODY_BUDGET_REACHED')
    coverage.complete = false
    return observation
  }
  const storedHash = writeContentAddressed(blobDirectory, text)
  addStoredBytes(Buffer.byteLength(text))
  coverage.retainedFiles += 1
  return { ...observation, retained: true, storedHash }
}

// ── 差异 manifest ────────────────────────────────────────────────────

export function readWorkspaceSnapshot(evidenceRoot: string | undefined, snapshotId: string): DeliveryWorkspaceSnapshot | null {
  const body = readNamedRecord(deliveryEvidencePaths(evidenceRoot).snapshots, snapshotId)
  if (body === null) return null
  try {
    const parsed = JSON.parse(body) as DeliveryWorkspaceSnapshot
    if (parsed.version !== DELIVERY_CHANGE_SNAPSHOT_VERSION || parsed.snapshotId !== snapshotId) return null
    if (!Array.isArray(parsed.files)) return null
    // 重新计算规范化正文摘要，文件被替换或字段被篡改时不再可信。
    if (sha256(JSON.stringify({ ...parsed, snapshotId: '' })) !== snapshotId) return null
    // 该快照形状尚未发布：每个观察必须自带经过校验的 canonical `repoPath`，且 ignore
    // 路径身份必须完整声明（含「无法完整确认」这一事实）。缺少任一字段都按不可用处理，
    // 绝不按工作区相对 `path` 回填——那会把未发布的开发期形状固化成 alias/回退合同。
    for (const file of parsed.files) {
      if (typeof file.repoPath !== 'string' || validateRepoRelativePath(file.repoPath) === null) return null
    }
    if (typeof parsed.ignoredPathsComplete !== 'boolean' || !Array.isArray(parsed.ignoredPathIdentities)) return null
    return parsed
  } catch { return null }
}

/**
 * manifest 的规范化正文：`evidenceId` 本身不参与摘要，其余字段顺序固定。
 * 采集、落盘与读回重验必须使用同一个函数，否则「hash 重验」没有意义。
 */
function manifestBody(manifest: DeliveryChangeManifest): Record<string, unknown> {
  return {
    version: manifest.version, taskId: manifest.taskId, attemptNo: manifest.attemptNo, territoryId: manifest.territoryId,
    workspaceKey: manifest.workspaceKey, repo: manifest.repo, executionId: manifest.executionId, leaseId: manifest.leaseId,
    dispatchId: manifest.dispatchId, pre: manifest.pre, post: manifest.post, entries: manifest.entries,
    coverage: manifest.coverage, note: manifest.note, createdAt: manifest.createdAt,
  }
}

export function deliveryChangeEvidenceId(manifest: DeliveryChangeManifest): string {
  return sha256(JSON.stringify(manifestBody(manifest)))
}

export type BuildChangeManifestResult =
  | { ok: true; manifest: DeliveryChangeManifest; file: string }
  | { ok: false; code: string; reason: string }

/** 采集执行前的有界基线；失败返回 null（调用方不得伪造空差异）。 */
export function capturePreChangeSnapshot(input: Omit<CaptureSnapshotInput, 'phase'>): DeliveryWorkspaceSnapshot | null {
  const captured = captureWorkspaceSnapshot({ ...input, phase: 'PRE' })
  return captured.ok ? captured.snapshot : null
}

export interface CompleteChangeManifestInput {
  workspacePath: string
  pre: DeliveryWorkspaceSnapshot
  taskId: string
  attemptNo: number
  territoryId: string
  executionId?: string | null
  leaseId?: string | null
  dispatchId?: string | null
  evidenceRoot?: string
  bounds?: Partial<DeliveryChangeBounds>
}

/**
 * terminal / WorkerResult 之前采集 POST 并生成差异 manifest。
 *
 * 采集或写入任一步失败都返回 null：宁可没有改动定位，也不产生不可信的链接。
 */
export function capturePostAndBuildChangeManifest(input: CompleteChangeManifestInput): DeliveryChangeManifest | null {
  const captured = captureWorkspaceSnapshot({
    workspacePath: input.workspacePath,
    taskId: input.taskId,
    attemptNo: input.attemptNo,
    territoryId: input.territoryId,
    phase: 'POST',
    executionId: input.executionId ?? null,
    leaseId: input.leaseId ?? null,
    dispatchId: input.dispatchId ?? null,
    evidenceRoot: input.evidenceRoot,
    bounds: input.bounds,
  })
  if (!captured.ok) return null
  if (input.pre.taskId !== input.taskId || input.pre.attemptNo !== input.attemptNo) return null
  const built = buildDeliveryChangeManifest({
    evidenceRoot: input.evidenceRoot,
    pre: input.pre,
    post: captured.snapshot,
    bounds: input.bounds,
  })
  return built.ok ? built.manifest : null
}

export interface BuildChangeManifestInput {
  evidenceRoot?: string
  pre: DeliveryWorkspaceSnapshot
  post: DeliveryWorkspaceSnapshot
  bounds?: Partial<DeliveryChangeBounds>
  resultRef?: string | null
  now?: string
}

/** 由 PRE/POST 两份快照生成有界、脱敏的差异 manifest，并原子写入内容寻址文件。 */
export function buildDeliveryChangeManifest(input: BuildChangeManifestInput): BuildChangeManifestResult {
  try {
    const bounds = { ...DEFAULT_DELIVERY_CHANGE_BOUNDS, ...(input.bounds ?? {}) }
    const paths = deliveryEvidencePaths(input.evidenceRoot)
    const pre = input.pre
    const post = input.post
    const before = new Map(pre.files.map(file => [file.path, file]))
    const after = new Map(post.files.map(file => [file.path, file]))
    const allPaths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b))
    const entries: DeliveryChangeEntry[] = []
    let omitted = 0
    const bothEnumComplete = pre.enumerationComplete && post.enumerationComplete
    // 增删判定还要看「另一时点缺少该路径」是否可能只是被 ignore：只有两时点都被
    // ignore 排除的路径身份完整可信，才能把缺项读成「当时确实不存在」。任一时刻的
    // ignore 身份无法完整确认时，整条增删判定必须 fail-closed。
    const ignoreKnowledgeComplete = pre.ignoredPathsComplete === true && post.ignoredPathsComplete === true
    const preIgnored = new Set(pre.ignoredPathIdentities)
    const postIgnored = new Set(post.ignoredPathIdentities)
    // 工作区相对仓库根的前缀只解析一次；循环内每次都扫快照既慢又无意义。
    const workspacePrefix = workspacePrefixOf(pre) || workspacePrefixOf(post)
    for (const path of allPaths) {
      if (entries.length >= bounds.maxEntries) { omitted += 1; continue }
      const entry = buildEntry(path, before.get(path) ?? null, after.get(path) ?? null,
        bothEnumComplete, ignoreKnowledgeComplete, preIgnored.has(path), postIgnored.has(path),
        paths.root, bounds, workspacePrefix)
      if (entry) entries.push(entry)
    }
    const reasons = [...new Set([...pre.coverage.reasons, ...post.coverage.reasons])]
    if (omitted > 0 && !reasons.includes('ENTRY_LIMIT_REACHED')) reasons.push('ENTRY_LIMIT_REACHED')
    // 任一侧枚举不完整时，「某路径不在该侧快照里」不能读成「它当时不存在」：
    // 增删判定整体降级为不可确认，并如实记入顶层原因。
    if (!pre.enumerationComplete || !post.enumerationComplete) {
      if (!reasons.includes('ENUMERATION_INCOMPLETE')) reasons.push('ENUMERATION_INCOMPLETE')
    }
    if (!ignoreKnowledgeComplete && !reasons.includes('IGNORED_SCOPE_UNCONFIRMED')) {
      reasons.push('IGNORED_SCOPE_UNCONFIRMED')
    }
    // 二进制、超限、符号链接或基线正文未保留时，条目只能给状态与摘要，
    // 行级覆盖并不完整：必须如实标成部分覆盖，不能静默说成完整。
    let entriesComplete = true
    const markIncomplete = (reason: string): void => {
      entriesComplete = false
      if (!reasons.includes(reason)) reasons.push(reason)
    }
    for (const entry of entries) {
      if (entry.binary) markIncomplete('BINARY_BODY_NOT_COMPARED_BY_LINES')
      if (entry.baselineBodyUnavailable) markIncomplete('BASELINE_BODY_NOT_RETAINED')
      if (entry.labels.includes('SYMLINK_NOT_FOLLOWED')) markIncomplete('SYMLINK_NOT_FOLLOWED')
      if (entry.reasonCode === 'SYMLINK_CHANGE_UNPROVEN') markIncomplete('SYMLINK_CHANGE_UNPROVEN')
      if (entry.labels.includes('CHANGE_NOT_PROVEN')) markIncomplete('CHANGE_NOT_PROVEN')
      if (entry.reasonCode === 'FILE_OVER_SIZE_LIMIT') markIncomplete('FILE_OVER_SIZE_LIMIT')
      // 另一时点没有观察结果、或命中 PEM 标记而未保留正文：都不是完整比较。
      if (entry.reasonCode === 'EXISTENCE_NOT_OBSERVED') markIncomplete('EXISTENCE_NOT_OBSERVED')
      if (entry.reasonCode === 'IGNORED_TRANSITION_UNPROVEN') markIncomplete('IGNORED_TRANSITION_UNPROVEN')
      if (entry.labels.includes('SENSITIVE_BODY_NOT_RETAINED')) markIncomplete('SENSITIVE_BODY_NOT_RETAINED')
    }
    // 没有 VCS 基准时无法区分「任务前已脏」与「本次窗口内的改动」，
    // 因此不能声称完整覆盖，也不能把窗口观测说成任务改动。
    const manifestRepo = pre.repo.vcs === 'GIT' ? pre.repo : post.repo
    if (manifestRepo.vcs !== 'GIT') markIncomplete('NO_VCS_BASELINE')
    const coverage = {
      complete: pre.coverage.complete && post.coverage.complete && omitted === 0 && entriesComplete,
      reasons,
      entryCount: entries.length,
      omitted,
    }
    const manifest: DeliveryChangeManifest = {
      version: DELIVERY_CHANGE_MANIFEST_VERSION,
      evidenceId: '',
      taskId: pre.taskId,
      attemptNo: pre.attemptNo,
      territoryId: pre.territoryId,
      workspaceKey: pre.workspaceKey,
      repo: pre.repo.vcs === 'GIT' ? pre.repo : post.repo,
      executionId: post.executionId ?? pre.executionId ?? null,
      leaseId: post.leaseId ?? pre.leaseId ?? null,
      dispatchId: post.dispatchId ?? pre.dispatchId ?? null,
      pre: { snapshotId: pre.snapshotId, capturedAt: pre.capturedAt, coverage: pre.coverage },
      post: { snapshotId: post.snapshotId, capturedAt: post.capturedAt, coverage: post.coverage },
      entries,
      coverage,
      note: CHANGE_EVIDENCE_NOTE,
      createdAt: input.now ?? new Date().toISOString(),
    }
    manifest.evidenceId = deliveryChangeEvidenceId(manifest)
    mkdirSync(paths.manifests, { recursive: true })
    const file = join(paths.manifests, `${manifest.evidenceId}.json`)
    if (!existsSync(file)) writeAtomic(file, JSON.stringify(manifest))
    return { ok: true, manifest, file }
  } catch (error: unknown) {
    return { ok: false, code: 'MANIFEST_BUILD_FAILED',
      reason: `差异 manifest 写入失败：${error instanceof Error ? error.message.slice(0, 200) : '未知错误'}` }
  }
}

/** 该时刻是否**真正读到过**这个路径的内容：只有读到过才能证明它当时存在。 */
function existedAt(file: DeliveryWorkspaceFileObservation | null | undefined): boolean {
  return Boolean(file && file.readability === 'READABLE' && file.rawHash !== null)
}
/**
 * 该时刻是否**亲眼确认**这个路径不存在（与「本快照没有读取到」严格区分）。
 *
 * 符号链接在这里算「不存在」只用于删除判定，且 `buildEntry` 先处理符号链接
 * （一律 `UNKNOWN`），因此这个分支不会被用来把未变化的链接报成删除。
 */
function absentAt(file: DeliveryWorkspaceFileObservation | null | undefined): boolean {
  return Boolean(file && (file.readability === 'ABSENT' || file.symlink === true))
}

/** 删除侧判定：另一时点要么根本没有该路径，要么亲眼确认它不存在。 */
function missingAt(file: DeliveryWorkspaceFileObservation | null | undefined): boolean {
  return file === null || file === undefined || absentAt(file)
}

/**
 * 从一份快照里还原工作区相对仓库根的路径前缀。
 *
 * 前缀不是新字段：每个文件观察同时带有工作区相对 `path` 与仓库相对 `repoPath`，
 * 两者相减即得；工作区就是仓库根（或快照里没有任何文件）时为空串。这样
 * `buildDeliveryChangeManifest` 不需要额外的隐藏参数，也不会引入第二套路径状态。
 */
function workspacePrefixOf(snapshot: DeliveryWorkspaceSnapshot): string {
  const sample = snapshot.files.find(file => typeof file.repoPath === 'string' && file.repoPath.endsWith(`/${file.path}`))
  if (!sample || typeof sample.repoPath !== 'string') return ''
  const prefix = sample.repoPath.slice(0, sample.repoPath.length - sample.path.length - 1)
  return validateRepoRelativePath(prefix) ?? ''
}

function buildEntry(
  path: string,
  beforeFile: DeliveryWorkspaceFileObservation | null,
  afterFile: DeliveryWorkspaceFileObservation | null,
  /** 两侧候选枚举是否都完整可信；为 false 时「不在快照里」不能当成「不存在」。 */
  enumerationComplete: boolean,
  /** 两侧被 ignore 排除的路径身份是否都完整可信；为 false 时缺项不能当成「当时未被忽略」。 */
  ignoreKnowledgeComplete: boolean,
  /** 该路径是否出现在基线时点的 ignore 排除身份集合里。 */
  beforeIgnored: boolean,
  /** 该路径是否出现在结果时点的 ignore 排除身份集合里。 */
  afterIgnored: boolean,
  evidenceRoot: string,
  bounds: DeliveryChangeBounds,
  /** 工作区相对仓库根的路径前缀；用于把展示路径还原成仓库相对路径。 */
  workspacePrefix: string,
): DeliveryChangeEntry | null {
  const entryId = sha256(`delivery-change\u0000${path}`)
  const repoPath = repoRelativePath(path, workspacePrefix)
  const beforeHash = beforeFile?.rawHash ?? null
  const afterHash = afterFile?.rawHash ?? null
  const binary = Boolean(beforeFile?.binary || afterFile?.binary)
  const oversize = Boolean(beforeFile?.oversize || afterFile?.oversize)
  const symlink = Boolean(beforeFile?.symlink || afterFile?.symlink)
  /** 任一侧命中 PEM 标记：两侧正文都不展示，避免把主体带进公开视图。 */
  const sensitive = Boolean(beforeFile?.sensitive || afterFile?.sensitive)
  // 两侧都真实读到完整内容时，摘要相同**就是**「本窗口没有变化」的证明。
  // 无法完整比较（超限/预算省略/读取失败）的路径摘要为 null，绝不当作「未变化」。
  const bothReadable = existedAt(beforeFile) && existedAt(afterFile)
  if (bothReadable && !symlink && beforeHash !== null && afterHash !== null && beforeHash === afterHash) return null
  const beforeObservable = beforeFile !== null
  const afterObservable = afterFile !== null
  // 增删只在「另一时点有确定的不存在结论」时成立。该结论要求：候选枚举未被文件/读取
  // 预算截断，且该时点被 ignore 排除的路径身份完整可信，并且这条路径确实不在其中——
  // 只改 `.gitignore`（清空规则→旧文件看似新增；新增规则→旧文件看似删除）时，缺项其实
  // 是「当时被 ignore」而内容一字未改，绝不能写成 ADDED/DELETED。
  // `UNREADABLE` 是「有观察、没结论」，同样绝不能当成不存在。
  const afterMissing = missingAt(afterFile)
  const missingProven = enumerationComplete && ignoreKnowledgeComplete
  const createdInWindow = missingProven && !beforeObservable && existedAt(afterFile) && !beforeIgnored
  const removedInWindow = missingProven && existedAt(beforeFile) && afterMissing && !afterIgnored
  // 读不出来就不能说它变了、也不能说它没变。
  const readabilityUnproven = beforeFile?.readability === 'UNREADABLE' || afterFile?.readability === 'UNREADABLE'
  /**
   * 一侧在快照里有观察结果、另一侧**根本没有该路径**。
   *
   * 只有缺项被证明是「当时确实不存在」时增删才成立；预算截断，或另一时点可能被 ignore
   * 排除（含 ignore 身份无法完整确认），缺项都只能记不可确认，否则会把仍然存在的文件
   * 报成删除、把任务前就存在的文件报成新增。
   */
  const existenceUnproven = !createdInWindow && !removedInWindow && beforeObservable !== afterObservable
    && (!missingProven || beforeIgnored || afterIgnored)

  const labels: string[] = []
  let status: DeliveryChangeStatus
  let reasonCode: string
  if (symlink) {
    // 符号链接只观测不跟随，因此没有「链接自身」的可比较摘要：两个时点都观察到链接
    // 也不能证明它没变，观察到一次更不能说明它变了。无法证明就不给可确认状态。
    status = 'UNKNOWN'
    reasonCode = 'SYMLINK_CHANGE_UNPROVEN'
    labels.push('SYMLINK_NOT_FOLLOWED')
    labels.push('CHANGE_NOT_PROVEN')
  } else if (createdInWindow) {
    status = 'ADDED'
    reasonCode = 'FILE_APPEARED_IN_WINDOW'
    labels.push(afterFile?.vcs === '??' ? 'UNTRACKED_FILE_CREATED_IN_WINDOW' : 'FILE_CREATED_IN_WINDOW')
  } else if (removedInWindow) {
    status = 'DELETED'
    reasonCode = 'FILE_REMOVED_IN_WINDOW'
    labels.push('FILE_REMOVED_IN_WINDOW')
  } else if (existenceUnproven) {
    // 文件没进入快照不等于它当时不存在：预算/枚举缺口，或另一时点可能被 ignore 排除，
    // 都只能记不可确认，不可被确认为新增或删除。
    status = 'UNKNOWN'
    reasonCode = !ignoreKnowledgeComplete || beforeIgnored || afterIgnored
      ? 'IGNORED_TRANSITION_UNPROVEN'
      : 'EXISTENCE_NOT_OBSERVED'
    labels.push('CHANGE_NOT_PROVEN')
  } else if (readabilityUnproven) {
    status = 'UNKNOWN'
    reasonCode = 'FILE_CHANGE_UNPROVEN'
    labels.push('CHANGE_NOT_PROVEN')
  } else if (oversize) {
    status = 'MODIFIED'
    reasonCode = 'FILE_OVER_SIZE_LIMIT'
    labels.push('BODY_NOT_COMPARED_BY_LINES')
  } else if (binary) {
    status = 'MODIFIED'
    reasonCode = 'BINARY_CONTENT_CHANGED'
    labels.push('BINARY_CONTENT_CHANGED')
  } else if (beforeFile && beforeFile.vcs && beforeFile.vcs !== '??') {
    status = 'MODIFIED'
    reasonCode = 'PRE_EXISTING_DIRTY_FILE_CHANGED'
    labels.push('PRE_EXISTING_DIRTY_FILE')
  } else if (beforeFile?.vcs === '??') {
    status = 'MODIFIED'
    reasonCode = 'UNTRACKED_FILE_CHANGED'
    labels.push('FILE_WAS_UNTRACKED_BEFORE_WINDOW')
  } else {
    status = 'MODIFIED'
    reasonCode = 'CONTENT_CHANGED_IN_WINDOW'
    labels.push('CONTENT_CHANGED_IN_WINDOW')
  }
  labels.push('AUTHORSHIP_NOT_PROVEN')
  if (sensitive) labels.push('SENSITIVE_BODY_NOT_RETAINED')

  const changed = status !== 'UNKNOWN'
  const notes: string[] = [changed
    ? '该路径内容在本 Task/attempt 窗口内发生变化；不证明作者身份，也不证明是哪个执行者或进程写入。'
    : '该路径在本次窗口内无法比较（另一时点没有该路径的观察结果，或采集时无法读取完整内容）：既不声称变化，也不声称未变化；该条目不可被确认为改动。']
  if (beforeFile?.vcs && beforeFile.vcs !== '??') notes.push('基线时该文件已相对 VCS 基准处于改动状态，本次差异可能混入任务前改动。')
  if (beforeFile?.vcs === '??') notes.push('基线时该文件已是未跟踪文件。')
  if (binary) notes.push('二进制内容不展示正文。')
  if (oversize) notes.push('文件超过单文件大小上限，只比较**完整内容摘要**（流式读取整个文件），不展示行级差异。')
  if (symlink) notes.push('符号链接只观测不跟随，链接自身没有可比较摘要：本窗口内无法证明它是否变化，该条目不可被确认为改动。')
  if (sensitive) notes.push('该路径命中 PEM 私钥/证书标记，两侧正文都不保留、也不展示。')
  if (status === 'UNKNOWN' && reasonCode === 'FILE_CHANGE_UNPROVEN') notes.push('该路径在采集时不可读取或无法完整比较，未做任何内容比较。')
  if (status === 'UNKNOWN' && reasonCode === 'SYMLINK_CHANGE_UNPROVEN') notes.push('不跟随符号链接，也不读取其目标正文；因此既不能确认变化，也不能确认未变化。')
  if (status === 'UNKNOWN' && reasonCode === 'EXISTENCE_NOT_OBSERVED') notes.push('该路径只在其中一个时点有存在性结论（另一时点受文件/读取预算或枚举上限影响没有观察结果），无法证明新增或删除。')
  if (status === 'UNKNOWN' && reasonCode === 'IGNORED_TRANSITION_UNPROVEN') notes.push('该路径只在其中一个时点进入候选集合：另一时点它被 `.gitignore` 一类规则排除（或该时点被排除的路径身份无法完整确认），本窗口既不声明新增也不声明删除。')

  let hunks: DeliveryChangeHunk[] = []
  let baselineBodyUnavailable = false
  if (changed && !binary && !oversize && !symlink && !sensitive) {
    const beforeText = beforeFile?.retained && beforeFile.storedHash ? readChangeBlob(evidenceRoot, beforeFile.storedHash) : null
    const afterText = afterFile?.retained && afterFile.storedHash ? readChangeBlob(evidenceRoot, afterFile.storedHash) : null
    // 只有基线里确实存在该文件、却没有保留正文时才算「基线正文不可用」；
    // 新增文件本来就没有基线，不能因此把覆盖说成不完整。
    if (beforeFile !== null && beforeFile.readability === 'READABLE' && beforeText === null) baselineBodyUnavailable = true
    if (beforeText !== null && afterText !== null) {
      hunks = diffLines(beforeText, afterText, bounds.maxDiffLines)
    } else if (beforeText !== null || afterText !== null) {
      // 只保留一侧正文时无法给出「前后对照」的行级差异；仍按真实基线展示片段。
      hunks = diffLines(beforeText ?? '', afterText ?? '', bounds.maxDiffLines)
      if (baselineBodyUnavailable) notes.push('基线正文未保留（超出有界预算或未捕获），只展示结果侧片段。')
    } else {
      notes.push('两侧正文都未保留，只保留内容摘要与状态。')
    }
  }
  // 展示路径一律是仓库相对路径：工作区相对 `path` 只用于本地读取与条目身份。
  return { entryId, path, repoPath, status, reasonCode, labels, note: notes.join(' '), binary, bodyRetained: Boolean(afterFile?.retained || beforeFile?.retained),
    beforeHash, afterHash, baselineBodyUnavailable, hunks }
}

/** 有界行级差异：裁掉公共前后缀后，把中段如实标成 REMOVED/ADDED 片段。 */
export function diffLines(before: string, after: string, maxLines: number): DeliveryChangeHunk[] {
  const a = before.split(/\r?\n/u)
  const b = after.split(/\r?\n/u)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1 }
  if (start > endA && start > endB) return []
  // 窗口内没有可比较的变化（例如完全不同的内容却长度为零）时保持空片段。
  if (endA < start && endB < start) return []
  const hunks: DeliveryChangeHunk[] = []
  const removed = a.slice(start, endA + 1).slice(0, maxLines)
  const added = b.slice(start, endB + 1).slice(0, maxLines)
  for (let index = 0; index < removed.length; index += 1) {
    hunks.push({ kind: 'REMOVED', beforeLine: start + index + 1, afterLine: null, text: boundedLine(removed[index]!) })
  }
  for (let index = 0; index < added.length; index += 1) {
    hunks.push({ kind: 'ADDED', beforeLine: null, afterLine: start + index + 1, text: boundedLine(added[index]!) })
  }
  return hunks
}

function boundedLine(value: string): string {
  const text = redactDeliveryText(value).slice(0, 400)
  return text
}

// ── 读回校验 ─────────────────────────────────────────────────────────

export type VerifyChangeManifestResult = { ok: true; manifest: DeliveryChangeManifest } | { ok: false; code: string; reason: string }

/** 读回并按内容寻址重验 manifest 与保留正文的 hash；漂移即不可用。 */
export function verifyChangeManifest(evidenceRoot: string | undefined, evidenceId: string): VerifyChangeManifestResult {
  const body = readNamedRecord(deliveryEvidencePaths(evidenceRoot).manifests, evidenceId)
  if (body === null) return { ok: false, code: 'EVIDENCE_MISSING', reason: CHANGE_EVIDENCE_DRIFT }
  let manifest: DeliveryChangeManifest
  try { manifest = JSON.parse(body) as DeliveryChangeManifest } catch { return { ok: false, code: 'EVIDENCE_UNREADABLE', reason: CHANGE_EVIDENCE_DRIFT } }
  if (manifest.version !== DELIVERY_CHANGE_MANIFEST_VERSION || manifest.evidenceId !== evidenceId) {
    return { ok: false, code: 'EVIDENCE_DRIFT', reason: CHANGE_EVIDENCE_DRIFT }
  }
  if (deliveryChangeEvidenceId(manifest) !== evidenceId) return { ok: false, code: 'EVIDENCE_DRIFT', reason: CHANGE_EVIDENCE_DRIFT }
  const pre = readWorkspaceSnapshot(evidenceRoot, manifest.pre.snapshotId)
  const post = readWorkspaceSnapshot(evidenceRoot, manifest.post.snapshotId)
  if (!pre || !post) return { ok: false, code: 'EVIDENCE_SNAPSHOT_MISSING', reason: CHANGE_EVIDENCE_DRIFT }
  for (const file of [...pre.files, ...post.files]) {
    if (!file.retained || !file.storedHash) continue
    if (readChangeBlob(evidenceRoot, file.storedHash) === null) {
      return { ok: false, code: 'EVIDENCE_BLOB_DRIFT', reason: CHANGE_EVIDENCE_DRIFT }
    }
  }
  return { ok: true, manifest }
}

/** 读取由主管 ACCEPT 绑定在该 Task 上的改动证据引用。 */
export function readAcceptedChangeEvidence(review: EventRow | null): DeliveryChangeEvidenceRef | null {
  if (!review || review.event_type !== 'TASK_ACCEPTED') return null
  let payload: unknown
  try { payload = JSON.parse(review.payload_json) } catch { return null }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const raw = (payload as { delivery_change_evidence?: unknown }).delivery_change_evidence
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (value.kind !== 'SUPERVISOR_CONFIRMED_BOUNDED_WINDOW') return null
  if (typeof value.evidenceId !== 'string' || !HASH.test(value.evidenceId)) return null
  if (!Number.isSafeInteger(value.attemptNo) || (value.attemptNo as number) < 1) return null
  if (!Array.isArray(value.entryIds) || value.entryIds.length === 0 || value.entryIds.length > 200) return null
  const entryIds = value.entryIds.filter((id): id is string => typeof id === 'string' && HASH.test(id))
  if (entryIds.length !== value.entryIds.length) return null
  if (typeof value.selectionDigest !== 'string' || !HASH.test(value.selectionDigest)) return null
  if (selectionDigest(entryIds) !== value.selectionDigest) return null
  return {
    kind: 'SUPERVISOR_CONFIRMED_BOUNDED_WINDOW',
    evidenceId: value.evidenceId,
    attemptNo: value.attemptNo as number,
    entryIds: [...entryIds].sort(),
    selectionDigest: value.selectionDigest,
    entryCount: Number.isSafeInteger(value.entryCount) ? value.entryCount as number : entryIds.length,
    selectedCount: entryIds.length,
    coverageComplete: value.coverageComplete === true,
    coverageReasons: Array.isArray(value.coverageReasons)
      ? value.coverageReasons.filter((item): item is string => typeof item === 'string').slice(0, 16) : [],
    repoHead: typeof value.repoHead === 'string' && value.repoHead.length <= 64 ? value.repoHead : null,
    note: CHANGE_EVIDENCE_NOTE,
  }
}

export function selectionDigest(entryIds: readonly string[]): string {
  return sha256([...entryIds].sort().join('\u0000'))
}

/**
 * 校验主管显式选择：evidence 必须存在且 hash 一致，选中的 entry 必须真实存在。
 * 任一失败都返回错误，调用方必须拒绝并零写入。
 */
export function validateChangeSelection(
  evidenceRoot: string | undefined,
  manifest: DeliveryChangeManifest,
  entryIds: readonly string[],
  expected: { taskId: string; attemptNo: number },
): { ok: true; ref: DeliveryChangeEvidenceRef } | { ok: false; code: string; reason: string } {
  if (manifest.taskId !== expected.taskId || manifest.attemptNo !== expected.attemptNo) {
    return { ok: false, code: 'CHANGE_EVIDENCE_STALE', reason: '改动证据不属于本次 Task/attempt，拒绝确认。' }
  }
  const selected = [...new Set(entryIds)]
  if (!selected.length) return { ok: false, code: 'CHANGE_SELECTION_EMPTY', reason: '必须显式选择至少一条属于本次交付的改动引用。' }
  if (selected.length > 200) return { ok: false, code: 'CHANGE_SELECTION_TOO_LARGE', reason: '一次确认的改动引用过多。' }
  const known = new Map(manifest.entries.map(entry => [entry.entryId, entry]))
  for (const id of selected) {
    const entry = HASH.test(id) ? known.get(id) : undefined
    if (!entry) {
      return { ok: false, code: 'CHANGE_ENTRY_UNKNOWN', reason: '选中的改动引用不在该快照内，拒绝确认。' }
    }
    // 无法证明是否变化的条目（超限摘要相同、采集时不可读）不是改动，不能被确认。
    if (entry.status === 'UNKNOWN') {
      return { ok: false, code: 'CHANGE_ENTRY_UNPROVEN',
        reason: `改动条目 ${entry.repoPath} 无法证明在本窗口发生变化（${entry.reasonCode}），拒绝确认。` }
    }
  }
  const ref: DeliveryChangeEvidenceRef = {
    kind: 'SUPERVISOR_CONFIRMED_BOUNDED_WINDOW',
    evidenceId: manifest.evidenceId,
    attemptNo: manifest.attemptNo,
    entryIds: selected.sort(),
    selectionDigest: selectionDigest(selected),
    entryCount: manifest.entries.length,
    selectedCount: selected.length,
    coverageComplete: manifest.coverage.complete,
    coverageReasons: manifest.coverage.reasons.slice(0, 16),
    repoHead: manifest.repo.head,
    note: CHANGE_EVIDENCE_NOTE,
  }
  return { ok: true, ref }
}

/** 事件载荷：只含 task/attempt/result、manifest/hash 与有界元数据，不含仓库正文。 */
export function changeSnapshotEventPayload(manifest: DeliveryChangeManifest, resultRef: string | null): Record<string, unknown> {
  return {
    version: DELIVERY_CHANGE_MANIFEST_VERSION,
    taskId: manifest.taskId,
    attemptNo: manifest.attemptNo,
    resultId: resultRef,
    executionId: manifest.executionId,
    leaseId: manifest.leaseId,
    dispatchId: manifest.dispatchId,
    evidenceId: manifest.evidenceId,
    selectionDigest: null,
    entryCount: manifest.entries.length,
    coverageComplete: manifest.coverage.complete,
    coverageReasons: manifest.coverage.reasons.slice(0, 16),
    repoVcs: manifest.repo.vcs,
    repoHead: manifest.repo.head,
    preSnapshotId: manifest.pre.snapshotId,
    postSnapshotId: manifest.post.snapshotId,
    note: CHANGE_EVIDENCE_NOTE,
  }
}

export function changeSnapshotEventId(kingdomId: string, taskId: string, attemptNo: number, executionRef: string | null): string {
  return `delivery-change:${sha256(`${kingdomId}\u0000${taskId}\u0000${attemptNo}\u0000${executionRef ?? 'none'}`)}`
}

/** Territory canonical workspace 的不可逆摘要，用于把快照绑定到具体领地工作区。 */
export function workspaceKeyOf(workspacePath: string): string | null {
  if (!workspacePath || !workspacePath.trim()) return null
  try { return sha256(realpathSync.native(workspacePath)) } catch { return null }
}

export interface ChangeSnapshotEventRef {
  event: EventRow
  evidenceId: string
  attemptNo: number
  resultId: string | null
  executionId: string | null
  coverageComplete: boolean
  coverageReasons: string[]
}

/** 精确读取某 Task/attempt 的改动快照事件（不走有界 GUI 投影）。 */
export function readChangeSnapshotEvent(store: KingdomStore, kingdomId: string, taskId: string, attemptNo: number): ChangeSnapshotEventRef | null {
  const rows = store.db.prepare(
    "SELECT * FROM events WHERE kingdom_id = ? AND event_type = ? AND target_type = 'task' AND target_id = ? ORDER BY seq DESC LIMIT 50",
  ).all(kingdomId, DELIVERY_CHANGE_SNAPSHOT_EVENT_TYPE, taskId) as unknown as EventRow[]
  for (const event of rows) {
    let payload: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(event.payload_json)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      payload = parsed as Record<string, unknown>
    } catch { continue }
    if (payload.attemptNo !== attemptNo) continue
    if (typeof payload.evidenceId !== 'string' || !HASH.test(payload.evidenceId)) continue
    return {
      event,
      evidenceId: payload.evidenceId,
      attemptNo,
      resultId: typeof payload.resultId === 'string' ? payload.resultId : null,
      executionId: typeof payload.executionId === 'string' ? payload.executionId : null,
      coverageComplete: payload.coverageComplete === true,
      coverageReasons: Array.isArray(payload.coverageReasons)
        ? payload.coverageReasons.filter((item): item is string => typeof item === 'string').slice(0, 16) : [],
    }
  }
  return null
}

/** 主管候选清单用的有界条目视图（只读，不写任何事实）；展示路径是仓库相对路径。 */
export function listChangeEntries(manifest: DeliveryChangeManifest, limit = 200): { entryId: string; repoPath: string; status: string; note: string }[] {
  return manifest.entries.slice(0, limit).map(entry => ({ entryId: entry.entryId, repoPath: entry.repoPath, status: entry.status, note: entry.note }))
}

/** 读回一条已确认改动条目的有界视图：只按 entry id 取，不接受任意路径。 */
export function readChangeEntry(
  evidenceRoot: string | undefined,
  ref: DeliveryChangeEvidenceRef,
  entryId: string,
): { ok: true; entry: DeliveryChangeEntry; manifest: DeliveryChangeManifest } | { ok: false; code: string; reason: string } {
  if (!ref.entryIds.includes(entryId)) return { ok: false, code: 'CHANGE_ENTRY_UNKNOWN', reason: '该条目不在主管确认的改动引用内。' }
  const verified = verifyChangeManifest(evidenceRoot, ref.evidenceId)
  if (!verified.ok) return verified
  const entry = verified.manifest.entries.find(candidate => candidate.entryId === entryId)
  if (!entry) return { ok: false, code: 'CHANGE_ENTRY_UNKNOWN', reason: '该条目不在快照内。' }
  if (entry.status === 'UNKNOWN') {
    return { ok: false, code: 'CHANGE_ENTRY_UNPROVEN', reason: '该条目无法证明在本窗口发生变化，不能作为已确认改动读取。' }
  }
  return { ok: true, entry, manifest: verified.manifest }
}

/** 交付条目派生用的已解析证据形状（与 `delivery-ack.ts` 的结构一致）。 */
export interface ResolvedChangeEvidence {
  evidenceId: string
  attemptNo: number
  repoHead: string | null
  coverageComplete: boolean
  coverageReasons: string[]
  note: string
  /** 条目展示路径一律是仓库相对路径。 */
  entries: { entryId: string; repoPath: string; status: string; note: string }[]
}

/**
 * 把已确认的改动引用解析成可投影条目。任何 hash 漂移或正文缺失都返回 null，
 * 调用方据此显示「不可定位」，而不是继续用可能被替换的正文。
 */
export function resolveChangeEvidenceForDelivery(
  evidenceRoot: string | undefined,
  ref: DeliveryChangeEvidenceRef,
): ResolvedChangeEvidence | null {
  const verified = verifyChangeManifest(evidenceRoot, ref.evidenceId)
  if (!verified.ok || verified.manifest.attemptNo !== ref.attemptNo) return null
  const selected = new Set(ref.entryIds)
  const entries = verified.manifest.entries
    .filter(entry => selected.has(entry.entryId) && entry.status !== 'UNKNOWN')
    .map(entry => ({ entryId: entry.entryId, repoPath: entry.repoPath, status: entry.status, note: entry.note }))
  if (entries.length !== selected.size) return null
  return {
    evidenceId: ref.evidenceId,
    attemptNo: ref.attemptNo,
    repoHead: verified.manifest.repo.head,
    coverageComplete: verified.manifest.coverage.complete,
    coverageReasons: verified.manifest.coverage.reasons.slice(0, 16),
    note: CHANGE_EVIDENCE_NOTE,
    entries,
  }
}
