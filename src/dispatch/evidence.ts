/**
 * dsh-kingdom — v0.8 Dispatch Evidence 重建（M3-S5，§2）。
 *
 * 依 M3-S5 Thin Spec §2 + M3-S1 Stage 2（Receipt ≠ Terminal；whenIdle 仅同步辅助）：
 * - 持久证据 = session 事件链（user/message → turn/start → turn/end → assistant/message，C-006/C-010）；
 * - 以「我们的 dispatch ref（UserMessage.id）在事件流中出现」为起点分析；
 * - G12 Foreign/Unmanaged Dispatch 检测：active dispatch 期间出现**非本次 dispatch 的
 *   user 消息** → 标记 untrusted（禁止 settle/release 并声称可信）。
 */
/**
 * turn/end reason → 已知终态 outcome 映射（Owner FINAL REAL-DSH VALIDATION WINDOW · 不改 Schema）：
 *   completed(+assistant) → COMPLETED；aborted → ABORTED；blocked/error/max-tokens → FAILED；
 *   interrupted / 缺失 / 未知 → null（不可判定 → RECOVERING，fail-closed）。
 */
export function terminalOutcomeOf(reason: string | null): 'COMPLETED' | 'FAILED' | 'ABORTED' | null {
  switch (reason) {
    case 'completed': return 'COMPLETED'
    case 'aborted': return 'ABORTED'
    case 'blocked':
    case 'error':
    case 'max-tokens': return 'FAILED'
    default: return null
  }
}

export interface DispatchEvidence {
  /** 消息插入起点是否找到（找不到 → 无法归属 → UNKNOWN）。 */
  located: boolean
  /** 归属到本 dispatch 的 turn（turn/start 的 turn 号；多个取最近）。 */
  turnObserved: number | null
  turnEndObserved: boolean
  /** turn/end 的原始 reason.kind（completed/aborted/error/blocked/max-tokens/interrupted；缺失为 null）。 */
  turnEndReason: string | null
  /** 已知终态 outcome（completed+assistant→COMPLETED / aborted→ABORTED / blocked·error·max-tokens→FAILED；否则 null→RECOVERING）。 */
  terminalOutcome: 'COMPLETED' | 'FAILED' | 'ABORTED' | null
  assistantMessageObserved: boolean
  /** 外部/非本 dispatch 的 user 消息（G12 检测）。 */
  foreignUserMessages: string[]
  /** 重建判定：QUEUED / RUNNING / TERMINAL / UNKNOWN。 */
  state: 'QUEUED' | 'RUNNING' | 'TERMINAL' | 'UNKNOWN'
  /** 判定为 TERMINAL 的可信理由（turn completed + assistant 消息）。 */
  terminalReason: string | null
}

export interface SessionEventsLike {
  events: readonly { type: string; data?: Record<string, unknown> }[]
}

/** 在事件序列化负载中找 dispatch ref 首次出现的位置（容错 data 嵌套）。 */
function locateDispatchRef(events: readonly { type: string; data?: Record<string, unknown> }[], ref: string): number {
  return events.findIndex((event) => JSON.stringify(event).includes(ref))
}

function turnNumberOf(event: { data?: Record<string, unknown> }): number | null {
  const turn = event.data?.turn
  return typeof turn === 'number' ? turn : null
}

/**
 * turn/end 的结束原因（fail-closed 容错两种形态）：
 * - 持久 crash recovery 合成：`{turn, reason:{kind:'interrupted'}}`（repair.ts）；
 * - live cancel/dispose：`{kind:'aborted', reason}`（agent-loop agent.ts）。
 * 返回原始 reason.kind；缺失/未知 → null（调用方按非正常完成处理）。
 */
function turnEndReasonOf(event: { data?: Record<string, unknown> }): string | null {
  const data = event.data ?? {}
  const fromReason = data.reason !== null && typeof data.reason === 'object'
    ? (data.reason as { kind?: unknown }).kind
    : undefined
  const fromKind = data.kind
  const kind = typeof fromReason === 'string' ? fromReason : (typeof fromKind === 'string' ? fromKind : null)
  return kind
}

function messageIdOf(event: { data?: Record<string, unknown> }): string | null {
  const id = event.data?.id ?? (event.data?.message as { id?: string } | undefined)?.id
  return typeof id === 'string' ? id : null
}

/**
 * 重建一次 dispatch 的执行证据。
 * @param sinceDispatchRef runtime_dispatch_ref（UserMessage.id）。
 */
export function reconstructDispatchEvidence(session: SessionEventsLike, sinceDispatchRef: string): DispatchEvidence {
  try {
    const events = session.events
    const startIndex = locateDispatchRef(events, sinceDispatchRef)
    if (startIndex === -1) {
      return { located: false, turnObserved: null, turnEndObserved: false, turnEndReason: null, terminalOutcome: null, assistantMessageObserved: false, foreignUserMessages: [], state: 'UNKNOWN', terminalReason: null }
    }
    const tail = events.slice(startIndex + 1)

    // G12：外来 user 消息（id ≠ 本 dispatch ref）
    const foreignUserMessages = tail
      .filter(e => e.type === 'user/message')
      .map(messageIdOf)
      .filter((id): id is string => id !== null && id !== sinceDispatchRef)

    const turnStarts = tail.filter(e => e.type === 'turn/start')
    const turnEnds = tail.filter(e => e.type === 'turn/end')
    const assistantMessages = tail.filter(e => e.type === 'assistant/message')

    const lastStart = turnStarts[turnStarts.length - 1]
    const lastEnd = turnEnds[turnEnds.length - 1]
    const turnObserved = lastStart ? turnNumberOf(lastStart) : null
    const turnEndObserved = Boolean(lastEnd)
    const turnEndReason = lastEnd ? turnEndReasonOf(lastEnd) : null
    const assistantMessageObserved = assistantMessages.length > 0
    const endTurn = lastEnd ? turnNumberOf(lastEnd) : null
    const outcome = lastEnd && (endTurn === null || turnObserved === null || endTurn >= turnObserved) ? terminalOutcomeOf(turnEndReason) : null

    if (!lastStart) {
      return { located: true, turnObserved: null, turnEndObserved, turnEndReason, terminalOutcome: null, assistantMessageObserved, foreignUserMessages, state: 'QUEUED', terminalReason: null }
    }
    if (lastEnd && outcome === 'COMPLETED' && assistantMessageObserved) {
      return {
        located: true, turnObserved, turnEndObserved, turnEndReason, terminalOutcome: outcome, assistantMessageObserved, foreignUserMessages,
        state: 'TERMINAL',
        terminalReason: `turn=${turnObserved} completed + assistant/message 可核对`,
      }
    }
    if (lastEnd && (outcome === 'FAILED' || outcome === 'ABORTED')) {
      // 明确终止 reason（aborted/blocked/error/max-tokens）→ 终态（无需 assistant）
      return {
        located: true, turnObserved, turnEndObserved, turnEndReason, terminalOutcome: outcome, assistantMessageObserved, foreignUserMessages,
        state: 'TERMINAL',
        terminalReason: `turn=${turnObserved} ${turnEndReason} → ${outcome}`,
      }
    }
    if (lastEnd && turnEndReason === 'completed' && !assistantMessageObserved) {
      // completed 但无 assistant 消息 → 证据强度不足（fail-closed → RECOVERING）
      return {
        located: true, turnObserved, turnEndObserved, turnEndReason, terminalOutcome: null, assistantMessageObserved, foreignUserMessages,
        state: 'UNKNOWN',
        terminalReason: null,
      }
    }
    if (lastEnd && outcome === null) {
      // turn 已结束但不可判定（interrupted / reason 缺失 / 未知）→ 证据不足 → RECOVERING
      return {
        located: true, turnObserved, turnEndObserved, turnEndReason, terminalOutcome: null, assistantMessageObserved, foreignUserMessages,
        state: 'UNKNOWN',
        terminalReason: null,
      }
    }
    return { located: true, turnObserved, turnEndObserved, turnEndReason, terminalOutcome: null, assistantMessageObserved, foreignUserMessages, state: 'RUNNING', terminalReason: null }
  } catch {
    return { located: false, turnObserved: null, turnEndObserved: false, turnEndReason: null, terminalOutcome: null, assistantMessageObserved: false, foreignUserMessages: [], state: 'UNKNOWN', terminalReason: null }
  }
}

/**
 * G12 判定：active dispatch 期间是否存在非本 dispatch 的 user 输入。
 * 检测到即不可把污染执行当可信 governed execution（Prevent OR Detect+Fail-closed）。
 */
export function hasForeignDispatch(session: SessionEventsLike, sinceDispatchRef: string): boolean {
  const evidence = reconstructDispatchEvidence(session, sinceDispatchRef)
  return evidence.foreignUserMessages.length > 0
}
