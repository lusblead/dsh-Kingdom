---
feature_id: "owner-binding-natural-language"
title: "Natural-language Owner binding intent Draft"
status: "proposed"
---

自然语言与本 Draft module 只形成可回显的 zero-write Draft。该阶段不读取或
写入 KingdomStore，不写 event/binding/role/territory，不 mint capability，也
不把 Agent 或 target session ref 解释为 Owner authority。最终可执行输入仍必须
是用户直接确认的 canonical `/kingdom` Slash；只有该 direct Owner ingress 在
自己的 transaction boundary 中持久化 binding/session/Territory 与 event。

本 Flow 同时记录 Primary-owned integration：`src/index.ts` 的
`resolveTrustedToolSession` 只有在 current initiator、`agents.get` 与
`sessions.get` 返回 exact object identity、`agent.id === session.id`、Agent
处于 `running` 且 signal 未 aborted 时，才传入
`target_session_classification: ACTIVE`；否则保留显式失败分类，不能用非空
session id fallback。Draft Tool 传入该分类、`target_session_ref`、role
snapshots 和包含 `supervisor_binding_id` 的 Territory snapshots。
`ownerToolDenied`、`kingdom_bind_role`、`kingdom_bind_session` 的结构化拒绝
路径调用 `draftOwnerBindingIntentFromRejectedWrite`，只返回 zero-write Draft；
本产品 Tool 只转发 `role_type`、`binding_id`、`session_id`，不执行写入，也不把
Territory 解析器暴露为独立产品 Tool。`resolveTerritory`/
`resolveTerritoryById` 是 helper-only 的 bounded snapshot resolver，只为 Draft
提供 Territory 事实，不能代替 direct Owner ingress 或产生 `supervisor_binding_id`。
结构化入口统一按实际顺序处理：先做 Owner gate（generic 的显式 OWNER，或 exact
`binding_id` 探测到 OWNER）；非 Owner 结果随后都进入同一个
`resolveRequestedTargetSession` request/target identity proof（request foreign、
unresolved、expired 等）；只有 proof 成功后，才做 invalid role hint、binding
foreign/mismatch、Territory 等 remaining validation。exact binding 无解、多解、
foreign 或 unsafe 均保持 zero-write `AMBIGUOUS`，不产生 Slash；因此 exact/generic
不会因分支不同而改变拒绝优先级。
Direct `/kingdom role.session` 先解析 strict JSON object envelope，并在进入
binding/role 解析前拒绝重复字段、未允许字段和非法 JSON；只有合法 envelope
才进入 D16 的 explicit `role_type=OWNER` 或 exact `binding_id`→OWNER gate。
该 Owner gate 随后先于 `role_type`/`binding_id` 二选一、字段类型和 live-session
proof；因此 envelope grammar 与 Owner projection gate 是两个连续边界。
Owner 直接确认 canonical Slash 后，`validateDirectSessionPayload` 必须再次
通过 `validateLiveDirectSession` 验证非空 `session_id`；任何 agents/sessions
registry seam 缺失、对象不一致、foreign/multiple/过期或不可用状态均拒绝且不写入。
本 Flow 仍保持 `proposed`，因为当前 run 的 capability R3 独立复审尚未解除最终
Flow finalize 门禁。

## Runtime flow

```mermaid
flowchart TD
    E1(["E1 Agent or local caller supplies bounded natural language + context"]) --> D1{"D1 Recognized Chinese role intent"}
    E2(["E2 Primary Tool forwards structured OWNER_CONTROL_REQUIRED rejection + trusted context"]) --> D8{"D8 Structured request carries binding_id"}
    E3(["E3 Owner confirms canonical /kingdom Slash with optional session_id"]) -->|strict envelope accepted| D16{"D16 Valid envelope: role.session OWNER binding gate"}
    D16 -->|explicit role_type OWNER or binding_id resolves OWNER| X11(["X11 OWNER_CONTROL_REQUIRED; zero event and zero binding change"])
    D16 -->|non-Owner role.session or role.bind| D7{"D7 Direct session target is live and registry-proven"}
    D7 -->|no session_id/null or exact live proof| A5["A5 Execute the direct Owner write in its transaction boundary"]
    D7 -->|missing seam/foreign/multiple/expired/invalid| X6(["X6 INPUT_DENIED; zero write and explicit recovery"])
    A5 --> X7(["X7 Owner write result is returned for direct reconciliation"])
    D1 -->|no| X1(["X1 AMBIGUOUS clarification; zero write"])
    D1 -->|yes| D3{"D3 Natural-language OWNER gate before session proof"}
    D2 -->|no or absent/foreign/expired/aborted/unproven/multiple| X2(["X2 AMBIGUOUS session clarification; zero write"])
    D8 -->|yes; kingdom_bind_session/role.session + binding_id| D11{"D11 Exact OWNER gate: hint or binding probe"}
    D8 -->|no; no binding_id/generic role_type path| D13{"D13 Generic OWNER gate; defer other role validation"}
    D11 -->|explicit OWNER or exact binding resolves OWNER| X3(["X3 OWNER_ROLE_DIRECT_ONLY; no Owner binding Draft"])
    D11 -->|non-Owner or unresolved exact candidate| D9{"D9 Shared request/target session identity proof"}
    D9 -->|request/session foreign| X10(["X10 SESSION_FOREIGN; zero write and no Slash"])
    D9 -->|target absent/expired/aborted/unproven/multiple| X2
    D9 -->|yes; request and target proof succeed| D10{"D10 Remaining exact binding/hint validation"}
    D10 -->|yes; singleton/eligible exact binding| A4["A4 Build canonical role.session Draft from exact binding_id"]
    D10 -->|no; none/multiple/foreign/unsafe/mismatch binding| X8(["X8 AMBIGUOUS exact binding; zero write and no Slash"])
    D13 -->|explicit OWNER| X3
    D13 -->|non-Owner or invalid hint| D14{"D14 Shared request/target session identity proof"}
    D14 -->|request/session foreign| X10
    D14 -->|target absent/expired/aborted/unproven/multiple| X2
    D14 -->|request and target proof succeed| D15{"D15 Remaining generic role/Territory validation"}
    D15 -->|missing or invalid role_type| X9(["X9 REJECTION_UNSUPPORTED; no operation and no Slash"])
    D15 -->|valid non-Owner role_type| D4
    A4 --> X5
    D3 -->|OWNER_ROLE_DIRECT_ONLY| X3
    D3 -->|non-Owner role| D2{"D2 Generic/natural target session proof"}
    D2 -->|no or absent/foreign/expired/aborted/unproven/multiple| X2
    D2 -->|yes; target proven| D4{"D4 Generic Supervisor Territory is one active local match"}
    D4 -->|not applicable| D5{"D5 Reusable exact role binding exists"}
    D4 -->|missing/foreign/unavailable/multiple| X4(["X4 AMBIGUOUS Territory question; zero write"])
    D4 -->|yes; query resolves one active local Territory| D5
    D5 -->|yes; reusable exact binding| A1["A1 Build role.session Draft using existing binding_id"]
    D5 -->|no; generic role.bind-capable request| A2["A2 Build role.bind Draft with deterministic role alias and session ref"]
    D5 -->|no; forced role.session has no reusable binding| X8
    A2 --> D6{"D6 Supervisor requires Territory attachment step"}
    D6 -->|yes| A3["A3 Append territory.supervisor step using ROLE_BIND result ref"]
    D6 -->|no| X5(["X5 Canonical /kingdom Slash/steps + DIRECT_SLASH_CONFIRM_REQUIRED"])
    A1 --> X5
    A3 --> X5
    G1[["G1 Pure module has no Store/event/capability dependency"]] -.-> A1
    G1 -.-> A2
    G1 -.-> A3
    G1 -.-> A4
    G1 -.-> D10
    G2[["G2 Only trusted classification for the exact invocation target can supply the target"]] -.-> D2
    G2 -.-> D9
    G2 -.-> A1
    G2 -.-> A2
    G2 -.-> A3
    G2 -.-> A4
    G3[["G3 Canonical args come from allowlisted aliases and validated context, never raw command text"]] -.-> A1
    G3 -.-> D10
    G3 -.-> D11
    G3 -.-> D13
    G3 -.-> D14
    G3 -.-> A2
    G3 -.-> A3
    G3 -.-> A4
    G3 -.-> D1
    G4[["G4 Natural language and Agent transport never mint Owner authority"]] -.-> D3
    G4 -.-> A1
    G4 -.-> A2
    G4 -.-> A3
    G4 -.-> A4
    G4 -.-> X5
    G5[["G5 Each direct step declares STOP_NO_AGENT_RETRY_OR_COMPENSATION"]] -.-> A1
    G5 -.-> A2
    G5 -.-> A3
    G5 -.-> X5
    G6[["G6 Direct Slash live-session gate never guesses a runtime target"]] -.-> D7
    G6 -.-> A5
```

## Component sequence

```mermaid
sequenceDiagram
    actor User
    participant Caller as Agent or local caller
    participant Draft as owner-binding-intent.ts
    participant Context as invocation context
    participant Slash as direct /kingdom Owner ingress

    alt structured OWNER_CONTROL_REQUIRED rejection handoff
        Caller->>Draft: operation + request + trusted context
        alt binding_id is present for kingdom_bind_session or role.session
            Draft->>Draft: probe binding_id role and inspect optional role_type only for OWNER gate
            alt explicit OWNER hint or exact binding resolves OWNER
                Draft-->>Caller: OWNER_ROLE_DIRECT_ONLY; no operation, no Slash, and no write
            else non-Owner or unresolved exact candidate
                Draft->>Context: resolveRequestedTargetSession(request, target)
                alt request/target proof missing/foreign/expired/multiple/aborted/unproven
                    Context-->>Draft: AMBIGUOUS session classification
                    Draft-->>Caller: no operation, no Slash, and no write
                else request and target proof succeeds
                    Draft->>Draft: validate role hint, binding locality, and exact binding eligibility
                    alt one eligible exact binding
                        Draft-->>Caller: canonical role.session Draft + confirmation code
                    else invalid hint or none/multiple/foreign/unsafe/mismatched binding
                        Draft-->>Caller: AMBIGUOUS exact-binding question; no Slash/no write
                    end
                end
            end
        else no binding_id; generic role_type Tool path
            Draft->>Draft: detect explicit OWNER; defer other role validation
            alt explicit OWNER
                Draft-->>Caller: OWNER_ROLE_DIRECT_ONLY; no Owner binding Draft
            else non-Owner or invalid role hint
                Draft->>Context: resolveRequestedTargetSession(request, target)
                alt request/target proof missing/foreign/expired/multiple/aborted/unproven
                    Context-->>Draft: AMBIGUOUS session classification
                    Draft-->>Caller: no operation, no Slash, and no write
                else request and target proof succeeds
                    Draft->>Draft: validate role_type, then buildDraftFromParsed and generic D4/D5
                    alt role_type missing or invalid
                        Draft-->>Caller: REJECTION_UNSUPPORTED; no operation, no Slash, and no write
                    else valid non-Owner role
                        Draft-->>Caller: generic role.session/role.bind Draft or AMBIGUOUS result
                    end
                end
            end
        end
    else natural-language handoff
        Caller->>Draft: bounded text + exact target_session_ref + read-only snapshots
        Draft->>Draft: normalize aliases and reject extra/injection tokens
        Draft->>Draft: buildDraftFromParsed after natural-language parse
        alt parsed role is OWNER
            Draft-->>Caller: OWNER_ROLE_DIRECT_ONLY; no Owner binding Draft
        else parsed role is non-Owner
            Draft->>Context: resolveTargetSession inside buildDraftFromParsed
            alt target proof missing/foreign/expired/aborted/unproven/multiple
                Context-->>Draft: AMBIGUOUS session classification
                Draft-->>Caller: no operation, no Slash, and no write
            else target proof succeeds
                Draft->>Draft: generic D4/D5 resolution from invocation snapshots
                alt existing CHANCELLOR singleton
                    Draft-->>Caller: role.session Draft + canonical Slash + confirmation code
                else existing Territory Supervisor binding
                    Draft-->>Caller: exact role.session Draft + confirmation code
                else new role and resolved context
                    Draft-->>Caller: role.bind Draft + canonical Slash + confirmation code
                    Draft-->>Caller: Supervisor adds territory.supervisor dependent step
                end
            end
        end
    end
    Caller-->>User: safe Draft echo only
    User->>Slash: direct canonical /kingdom Slash confirmation
    Slash->>Slash: strict JSON object + duplicate/unrecognized-field grammar
    Slash->>Slash: valid envelope -> direct role.session OWNER gate: explicit role_type or current binding_id role
    alt Owner projection targeted by role.session
        Slash-->>User: OWNER_CONTROL_REQUIRED; zero event and zero binding change
    else non-Owner role/session operation
    alt session_id is absent/null
        Slash->>Slash: validateDirectSessionPayload permits an unbound role/session write
    else session_id is non-empty
        Slash->>Context: validateLiveDirectSession(session_id)
        alt registry proof succeeds
            Context-->>Slash: exact live Agent/Session and valid status
        else seam missing or target invalid
            Context-->>Slash: INPUT_DENIED; no Owner write
        end
    end
    Slash->>Slash: ownerWrite commits the confirmed direct step
    end
    Note over Slash: Owner ingress executes only after the live-target gate; the Draft module never calls it.
```

## State and side-effect boundary

Draft construction has no persisted state transition. `DRAFT_READY` and
`AMBIGUOUS` are in-memory result statuses only; neither is a Kingdom fact. After
the user confirms the canonical Slash, the separate direct Owner ingress persists
the resulting binding/session/Territory fact and audit event in one transaction.
Supervisor 的唯一 Territory 会保留为 Draft target。没有现有 Supervisor
binding 时，Draft 明确列出 `role.bind` 后接依赖其结果的
`territory.supervisor`；已有 Territory `supervisor_binding_id` 时只列出对
该 exact binding 的 `role.session`。本模块不生成 binding ID；两步中任一步
失败都停止交给 Owner 控制面处理，Agent 不自动重试或补偿。

## Persisted Owner write lifecycle

Draft 状态本身不进入下图；下图只描述 direct canonical Slash 通过 Owner
transaction boundary 后产生的持久化 RoleBinding/Territory 事实。两步 Supervisor
计划允许第一步提交后第二步尚未提交，不能由 Agent 自动回滚或补偿。
Product `kingdom_bind_role`/`kingdom_bind_session` Tools 在结构化
zero-write handoff 处停止；helper-only Territory resolver 只消费 bounded
snapshots，不能成为另一个 Product Tool 或写入路径。因此唯一写链保持为
`Draft -> direct /kingdom Slash -> ownerWrite -> persisted state + event`。

```mermaid
stateDiagram-v2
    state "RoleBinding projection" as RoleBinding {
        [*] --> ABSENT
        ABSENT --> ACTIVE: T1 role_bind_commit [direct Slash confirmed + transaction commits] / persist binding + event
        ACTIVE --> ACTIVE: T2 role_session_commit [direct Slash confirmed + transaction commits] / update session + event
        ACTIVE --> ROLE_RECOVERY_REQUIRED: T4 uncertain_owner_commit [readback uncertain] / reconcile manually
    }
    state "Territory projection" as Territory {
        [*] --> UNSUPERVISED
        UNSUPERVISED --> SUPERVISED: T3 territory_supervisor_commit [direct Slash confirmed + transaction commits] / persist supervisor ref + event
        SUPERVISED --> TERRITORY_RECOVERY_REQUIRED: T4 uncertain_owner_commit [readback uncertain] / reconcile manually
    }
```

## Safeguards and failure behavior

- `G1` pure zero-write boundary: module imports no store, database, event, runtime,
  filesystem, or capability surface. Any parse result has `write_effect=ZERO_WRITE`.
- `G2` exact target boundary: only an explicit `ACTIVE` classification backed by
  current initiator, `agents.get`/`sessions.get` object identity, matching IDs,
  `running`, and a non-aborted signal may become a session target. Missing,
  foreign, expired, aborted, unproven, unclassified, or multi-match context returns
  `AMBIGUOUS` and never falls back to a non-empty string.
- `G3` allowlisted canonicalization: role aliases, binding IDs, Territory IDs,
  and session refs are validated before constructing JSON; raw natural-language
  suffixes never enter the Slash.
- `G4` Owner separation: the result carries `authority_source=NONE` and
   `owner_authority=false`; only direct canonical `/kingdom` confirmation can be
   handed to the Owner Control Plane.
- Structured rejection priority is shared by generic and exact branches:
  `OWNER gate (including exact binding probe) -> request/target session identity
  proof -> remaining role/binding/Territory validation`. A rejected branch never
  emits a canonical Slash.
- `G5` step failure boundary: every canonical step carries
  `STOP_NO_AGENT_RETRY_OR_COMPENSATION`; the Draft helper never executes,
  retries, or compensates either direct Owner step.
- `G6` direct live-session gate: a non-empty direct Slash `session_id` must be
  resolved through `agents.get` and `sessions.get` with exact object identity,
  matching ids, and an idle/running live status; missing registry seams and
  invalid/ambiguous targets return `INPUT_DENIED` before `ownerWrite`.

## Primary integration and failure paths

- `resolveTrustedToolSession` 是 Tool invocation classification seam；它的
  未证明/`FOREIGN`/`EXPIRED`/`ABORTED`/`MULTIPLE`/`ABSENT` 结果不能被
  `target_session_ref` 覆盖。
- `kingdom_draft_owner_binding_intent` 通过 `ownerBindingIntentContext` 传入
  `target_session_ref`、`target_session_classification`、`role_bindings` 和含
  `supervisor_binding_id` 的 Territory snapshots。
- `ownerToolDenied` 将 `{ code, operation, request, context }` 交给纯 helper；
  `kingdom_bind_role` 与 `kingdom_bind_session` 走同一结构化 zero-write Draft
  路径，Agent Tool 不执行 Owner 写入。
- `resolveTerritory`/`resolveTerritoryById` 只属于 helper-only Territory
  snapshot resolution；Product Tool 不从它们取得写权限或绕过 direct Slash。
- Direct `/kingdom role.session` 先做 explicit `role_type=OWNER` 或 exact
  `binding_id`→OWNER gate，再调用 `validateDirectSessionPayload` →
  `validateLiveDirectSession`。没有完整 agents/sessions/get seam 时保持
  unresolved-session denial，不保留 test-only 或 host-shape bypass；具体 GUI
  fake-host fixture 的补齐由 GUI scope 负责。
