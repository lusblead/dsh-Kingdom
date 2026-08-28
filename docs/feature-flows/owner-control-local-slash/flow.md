---
feature_id: "owner-control.local-slash"
title: "Direct local Owner Control Plane"
status: "implemented"
---

# Direct local Owner Control Plane

Owner is the trusted-local human operator.  A direct `/kingdom` Slash is the
only v1 Owner ingress; an Agent, Tool, GUI/HTTP request, argument, or
`OWNER.session_id` never supplies Owner authority.

## Runtime flow

```mermaid
flowchart TD
    E1(["E1 User enters direct /kingdom Slash"]) --> D1{"D1 Exact command grammar and Owner-only operation"}
    D1 -->|invalid or unrecognized field| X1(["X1 INPUT_DENIED; zero write"])
    D1 -->|init| A1["A1 Atomic init: Kingdom + Owner principal + OWNER projection session_id=null"]
    D1 -->|configuration| A2["A2 Core Owner gate + one IMMEDIATE transaction"]
    A2 --> D2{"D2 Domain validation succeeds"}
    D2 -->|no| X2(["X2 Rejected; transaction has no governance effect"])
    D2 -->|yes| A3["A3 Persist fact and auditable Owner event"]
    A1 --> D3{"D3 Commit and readback are certain"}
    D3 -->|no| C1["C1 Return RECOVERY_REQUIRED; reconcile with status"]
    C1 --> X3(["X3 No guessed success or retry"])
    D3 -->|yes| X4(["X4 Owner result confirmed"])
    A3 --> X4
    G1[["G1 Only direct handler mints opaque Owner capability"]] -.-> D1
    G1 -.-> A2
    G2[["G2 BEGIN IMMEDIATE binds canonical facts and event atomically"]] -.-> A1
    G2 -.-> A2
    G3[["G3 Agent Tool and GUI/HTTP have no Owner capability"]] -.-> D1
    G3 -.-> A3
    G4[["G4 OWNER.session_id is ignored for Owner authority"]] -.-> A1
    G4 -.-> A2
    G4 -.-> A3
```

## Component sequence

```mermaid
sequenceDiagram
    actor User
    participant Slash as DSH /kingdom handler
    participant Gate as Core Owner gate
    participant Store as KingdomStore
    User->>Slash: exact direct command + one JSON envelope
    Slash->>Slash: reject extra tokens / unrecognized keys before write
    alt init
        Slash->>Store: BEGIN IMMEDIATE
        Store->>Store: insert Kingdom, OWNER projection(null), KINGDOM_CREATED
        Store-->>Slash: COMMIT + status readback
    else configuration
        Slash->>Gate: opaque OwnerControlCapability
        Gate->>Store: resolve Kingdom.owner_id (never OWNER.session_id)
        Gate-->>Slash: Owner principal
        Slash->>Store: domain write + event in one transaction
        Store-->>Slash: COMMIT
    else Tool or GUI/HTTP
        Slash-->>User: OWNER_CONTROL_REQUIRED (no Store write)
    end
```

## State lifecycle

```mermaid
stateDiagram-v2
    [*] --> EMPTY
    EMPTY --> INITIALIZED: T1 init_commit [no Kingdom] / create Owner projection
    INITIALIZED --> INITIALIZED: T2 repeat_init [canonical facts present] / attach only
    INITIALIZED --> CONFIGURED: T3 owner_write_commit [valid direct command] / persist fact + event
    CONFIGURED --> CONFIGURED: T4 repeat_owner_write [idempotent/domain rule] / update or no-op
    INITIALIZED --> RECOVERY_REQUIRED: T5 uncertain_commit [readback/rollback uncertain] / reconcile manually
    CONFIGURED --> RECOVERY_REQUIRED: T5 uncertain_commit [readback/rollback uncertain] / reconcile manually
```

## Failure and audit guarantees

- Invalid grammar is rejected before any domain write; unrecognized keys and extra
  tokens cannot be interpreted as authority.
- `OWNER.session_id` remains `null`; any legacy non-null value is not read by
  the Owner gate and is never silently cleared.
- Owner event payloads contain `operation`, bounded argument summaries and
  `source_channel=LOCAL_DIRECT_SLASH`; `actor_id` is `Kingdom.owner_id`.
- A transaction error returns `RECOVERY_REQUIRED` with an indeterminate outcome; the adapter does not
  guess that a write committed or retry a potentially committed operation.
- Agent Role Plane remains separate and continues to use real DSH caller
  sessions for Chancellor/Supervisor/Worker authorization.

Implementation and test mapping is maintained in `traceability.yaml`.
