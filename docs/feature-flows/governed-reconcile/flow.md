---
feature_id: "governed-reconcile"
title: "Governed reconcile"
status: "implemented"
---

# Governed reconcile

An authenticated, currently scoped Supervisor explicitly reconciles an existing dispatch through the tool or local GUI. Reconciliation never dispatches another prompt. The original process may retain the exact RunnerContext, Runtime fence and one-shot cleanup callback after an observation timeout. Only that original context may consume late terminal evidence. Missing receipt, lost process context, unreadable events and foreign activity remain recovery-required. No restart cleanup is inferred from an empty disposer registry.

```mermaid
flowchart TD
  E1[Supervisor requests existing dispatch reconciliation] --> G1[Verify current session and task territory scope]
  G1 --> D1{Authorized?}
  D1 -->|no| X1[Reject without Runtime action]
  D1 -->|yes| D0{Terminal already recorded?}
  D0 -->|yes| A3
  D0 -->|no| D2{Original context and receipt retained?}
  D2 -->|no| X2[Recovery required; no resend or release]
  D2 -->|yes| A1[Observe original dispatch under its original fence]
  A1 --> D3{Trusted terminal?}
  D3 -->|running or indeterminate| X2
  D3 -->|foreign or broken continuity| X2
  D3 -->|yes| A2[Consume original cleanup once]
  A2 --> T1[Atomically record recovered terminal on exact original relation]
  T1 --> T2[Consume original fence settlement; release only with cleanup proof]
  T2 --> A3[Persist separate typed provider usage observation]
  A3 --> T3[Submit one Claim and transition task to REVIEW]
  T3 --> X3[Return Claim and released or recovery-required lease]
  G1 -.-> D1
  G1 -.-> A2
  G1 -.-> T1
  G2[Opaque original handle and exact relation prevent rebinding] -.-> T1
  G3[Claim is not task completion] -.-> T3
```

```mermaid
sequenceDiagram
  actor S as Supervisor
  participant P as Public tool or GUI
  participant R as Retained reconciliation context
  participant D as DSH Runtime
  participant C as Core ledger
  S->>P: Reconcile dispatch
  P->>C: Resolve current Supervisor and territory
  P->>R: Consume original process context
  R->>D: Read current events and original fence
  D-->>R: Terminal or indeterminate
  alt Trusted terminal and unchanged authority
    R->>D: Original one-shot cleanup
    R->>C: Recovery terminal transaction with original port
    R->>D: Original fence settlement and release
    R->>C: Lease release or recovery-required
    P->>C: Idempotent Claim and REVIEW transaction
  else Context missing, foreign activity or indeterminate
    R-->>P: Recovery required without resend
  end
  P-->>S: Current result and remaining limitation
```

```mermaid
stateDiagram-v2
  [*] --> Waiting
  Waiting --> Recovering: T0 observation timeout retains original context
  Recovering --> Recovering: T4 indeterminate or missing evidence
  Recovering --> TerminalRecorded: T1 trusted original terminal
  TerminalRecorded --> Released: T2 original cleanup and fence confirmed
  TerminalRecorded --> CleanupUnknown: T2 cleanup or settlement unconfirmed
  Released --> Review: T3 one Claim submitted
  CleanupUnknown --> Review: T3 trusted Claim retained
  Review --> Review: T5 duplicate reconcile reads original result
```

The recovery-specific methods do not enable normal RunnerContext recreation. They accept the same opaque handle/version held at timeout. Unrelated ledger revisions may advance while waiting; any change to the exact task, execution, lease or dispatch tuple invalidates recovery. The GUI cannot supply Runtime evidence, a Session, a role or a cleanup receipt.

Validation covers late-terminal completion, duplicate requests, authorization loss, cross-territory access, lost process context, foreign activity, unconfirmed cleanup, atomic rollback and failure after Runtime fence release. Public Tool and loopback HTTP tests exercise the registered routes; WAIT and missing dispatch return `ok=false / RECOVERY_REQUIRED` in the GUI. Provider/runtime usage is persisted separately as typed runtime-observation events and never used as terminal or cleanup proof. Usage observations also occur after unsuccessful starts and WAIT results when the same receipt is observable; missing usage is never interpreted as zero cost.
