---
feature_id: runtime.cost-control
title: Runtime cost observation and soft budget admission
status: implemented
---

# Runtime cost observation and soft budget admission

Exact Owner budget.policy saves a prospective kingdom-wide policy with a fixed first accounting boundary. Default is off; editing, disabling or re-enabling never resets cost. Running work does not prevent reducing future admissions.

The first policy freezes exact carry-in admissions, unsettled Dispatches and incomplete non-Worker source references. Their exposure survives subsequent completion and policy edits. Previously complete role observations remain outside the new accounting period; public policy data does not reveal internal carry-in identifiers.

Governed start keeps existing Supervisor, model and active-Lease guards. Before ensureWorkerSession it atomically reserves an exact Task/attempt. Duplicate admission cannot authorize a second invocation. Existing TX-3 binds the reservation with Execution and Intent. Accepted preparation remains in flight after policy changes.

In 1.5 the same IMMEDIATE transaction checks an adopted plan's budget and dependencies,
reserves workspace access, and reserves kingdom budget. TX-3 binds both exact handles.
Read sharing requires the frozen Gate to prove read-only; unresolved ownership stays held.
The additional composition and its tests are in [bounded collaboration](../collaboration-bounded-plan/flow.md).

A reservation is an estimate, not authority, a monetary bill, execution termination or Lease release. Only proven failure before any Dispatch, with no active Lease or unsettled execution for that attempt, cancels it. unconfirmed/restart/RECOVERING retain risk. Runtime terminal and Lease cleanup remain owned by existing reconciliation.

Worker cost folds once per Dispatch using the latest complete provider report. readAdditionalBudgetUsage contributes verified non-Worker observations and explicit unconfirmed, pending and attribution gaps. Missing observations are not zero, and Worker-only data is never labelled full task cost.

Each pending non-Worker source receives an estimated reserve. A proven kingdom-owned shared or unattributed turn contributes to the kingdom total without allocation to individual tasks; its attribution gap warns but does not independently block admission. Missing usage follows the Owner BLOCK/WARN policy.

## Runtime flow

```mermaid
flowchart TD
    E1(["E1 Exact Owner budget.policy"]) --> D1{"D1 Active Owner action and kingdomWide scope"}
    D1 -->|Denied| X1(["X1 No policy write"])
    D1 -->|Allowed| T1["T1 Append policy and Owner receipt atomically"]
    T1 --> X2(["X2 Future admission policy saved"])
    E2(["E2 Authorized governed start"]) --> D2{"D2 Unique affordable admission with allowed coverage"}
    D2 -->|Allowed or off| T2["T2 Reserve before Runtime Session"]
    D2 -->|Duplicate or insufficient or unconfirmed| X3(["X3 Reject before Session and Lease"])
    T2 --> A1["A1 Existing Session and Capability preparation"]
    A1 --> D3{"D3 Preparation succeeded"}
    D3 -->|Yes| T3["T3 Bind exact admission in TX-3"]
    D3 -->|No| C1["C1 Verify no Dispatch and no active Lease"]
    C1 --> D4{"D4 Safe unused reservation proven"}
    D4 -->|Yes| T4["T4 Cancel accounting reservation only"]
    D4 -->|No or unconfirmed| X4(["X4 Preserve risk for reconciliation"])
    T4 --> X5(["X5 Safe rejection with unused estimate cancelled"])
    T3 --> A2["A2 Existing fenced Runtime dispatch and reconciliation"]
    A2 --> A3["A3 Fold observations and unresolved exposure"]
    A3 --> X6(["X6 Separate observed estimated pending unconfirmed"])
    G1[["G1 Exact Owner authority"]] -.-> T1
    G2[["G2 Atomic unique invocation"]] -.-> T2
    G2 -.-> T3
    G3[["G3 Budget never releases Lease or fabricates terminal"]] -.-> C1
    G3 -.-> A2
    G4[["G4 No duplicate measurement or missing as zero"]] -.-> A3
```

## Component sequence

```mermaid
sequenceDiagram
    actor Owner
    participant Window as Owner window
    participant Runner
    participant Budget
    participant DB as Existing SQLite
    participant Runtime
    Owner->>Window: Prepare and commit policy
    Window->>DB: Policy and receipt in one transaction
    Runner->>Budget: Reserve Task and attempt before Runtime
    Budget->>DB: IMMEDIATE policy and cost check with unique reservation
    alt denied
        Budget-->>Runner: Reason without Session or Lease
    else admitted
        Runner->>Runtime: Existing Session and Capability preparation
        alt proven safe preparation failure
            Runner->>Budget: Cancel accounting reservation
            Budget->>DB: Cancellation without runtime state update
        else prepared
            Runner->>DB: TX-3 reservation binding with Execution and Intent
            Runner->>Runtime: Fenced dispatch after commit
            Runtime-->>Runner: Terminal or unconfirmed evidence
            Runner->>DB: Existing reconciliation and usage observations
            Budget->>DB: Read latest observations and unresolved reservations
        end
    end
```

## Persisted lifecycle

```mermaid
stateDiagram-v2
    [*] --> POLICY: T1 exact Owner update
    [*] --> RESERVED: T2 unique affordable admission
    RESERVED --> BOUND: T3 exact invocation consumed in TX-3
    RESERVED --> CANCELLED: T4 proven pre-dispatch failure
```

BOUND exposure is derived from the current cost observations. Complete terminal observation replaces the estimate; incomplete or in-flight work retains estimated exposure and coverage warnings. Restart never restores a historical reservation as live invocation authority.

## Required verification

## Role and prompt observations

Only the exact live registry object and Core role binding identify a role. Worker
Dispatch usage stays separate. Actor events identify related tasks, never an
exclusive allocation of the entire turn. One source freezes when complete;
sampling again cannot move it across the accounting boundary. The first policy
freezes incomplete role and identity-gap sources for carry-in. Close/restart
changes observation continuity only, never Execution or Lease state.

```mermaid
flowchart TD
    E3(["E3 Runtime session event"]) --> D5{"D5 Exact registry and one non-Worker role"}
    D5 -->|Yes on turn start| T5["T5 Persist pending source and capture exact turn"]
    D5 -->|Ambiguous| A4["A4 Record one source coverage gap"]
    D5 -->|Absent or Worker| X7(["X7 No additional role double count"])
    T5 --> A5["A5 Read exact official turn usage including retries"]
    A5 --> D6{"D6 Complete request evidence"}
    D6 -->|Yes| T6["T6 Freeze complete provider observation"]
    D6 -->|No| D7{"D7 Turn still live"}
    D7 -->|Yes| X8(["X8 Pending estimate remains visible"])
    D7 -->|No| T7["T7 Preserve unavailable observation"]
    E4(["E4 Observer close or reinstall"]) --> T7
    E5(["E5 Prompt assembly"]) --> T8["T8 Append anonymous byte observation"]
    T6 --> X9(["X9 Real counts separate from estimates and missing coverage"])
    T7 --> X9
    T8 --> X9
    A4 --> X9
    G5[["G5 Exact source monotonicity and independent turn cleanup"]] -.-> T5
    G5 -.-> T6
    G5 -.-> T7
    G6[["G6 No prompt text or arbitrary plugin names persisted"]] -.-> T8
```

```mermaid
sequenceDiagram
    participant DSH
    participant Observer
    participant Meter as Official token meter
    participant Core
    participant GUI
    DSH->>Observer: Session event with exact registry object
    Observer->>Core: Pending source after binding check
    DSH->>Observer: Step retry assistant and end events
    Observer->>Meter: Exact complete turn event slice
    Meter-->>Observer: Complete counts or incomplete observation
    Observer->>Core: Monotonic same-source update
    Note over Observer: An old callback cannot delete a newer turn
    DSH->>Observer: Awaited assembly result
    Observer->>Core: Anonymous section and tool byte counts
    GUI->>Core: Read cost projection without model requests
    opt Observer close or reinstallation
        Observer->>Core: Mark lost continuity unavailable only
    end
```

```mermaid
stateDiagram-v2
    [*] --> IN_PROGRESS: T5 exact turn start
    IN_PROGRESS --> COMPLETE: T6 complete provider coverage
    UNAVAILABLE --> COMPLETE: T6 later exact complete evidence
    IN_PROGRESS --> UNAVAILABLE: T7 incomplete closed or restarted observer
    [*] --> RECORDED: T8 immutable anonymous byte observation
```

In-flight collections have their own cleanup set; removing a Session lookup
requires the same captured turn object. Installation marks only this runtime's
old pending observations unavailable, keeping source and accounting identity.
Completed reports and other runtime observations are untouched. There is no
claim that a disconnected observer stopped the Runtime.

The executable budget cases are in `tests/budget.test.ts`: exact Owner scope and receipt rollback; fixed accounting start and carry-in; last-slot competition; replay rejection; rejection before Session side effects; TX-3 identity checks and rollback; safe preparation cancellation and retry; unconfirmed and RECOVERING preservation; prospective policy reduction; deduplicated Worker observations and additional-role pending/shared/missing coverage. No paid-provider, formal migration or human acceptance evidence is claimed.
