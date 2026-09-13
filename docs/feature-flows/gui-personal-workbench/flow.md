---
feature_id: gui.personal-workbench
title: Personal workbench and task journey
status: implemented
---

# Personal workbench and task journey

The user opens a personal workbench, distinguishes actual Owner configuration decisions from internal Supervisor work, reads task evidence and scoped costs, and explicitly submits an editable task draft through the existing authorized Chancellor command. Read-only navigation and drafts have no model calls or governance side effects. Memory is out of scope. Budget management links to the independent gui.owner-control flow; opening that page grants no authority.

## Flow

```mermaid
flowchart TD
    E1(["E1 Open or refresh workbench"]) --> D4{"D4 Snapshot and current control state are readable"}
    D4 -->|No| X6(["X6 Preserve draft, disable writes and continue read-only polling"])
    D4 -->|Yes| A6["A6 Replace stale or changed control status even at the same revision"]
    A6 --> A1["A1 Read canonical tasks, organization, execution and usage observations"]
    A1 --> A7["A7 Read scoped costs, soft budget, bounded assembly bytes and actual runtime mode"]
    A7 --> A2["A2 Derive bounded Owner, internal, recovery and delivery queues"]
    A2 --> X1(["X1 Show current responsibility, evidence and coverage"])
    X1 --> E2(["E2 Open task or role"])
    E2 --> A3["A3 Read exact task detail and preserve selected view"]
    A3 --> X2(["X2 Read goal, criteria, claims, decisions, participants and history"])
    E3(["E3 Enter a goal"]) --> A4["A4 Edit local draft scope, criteria and territory"]
    A4 --> D1{"D1 User explicitly submits a valid draft with current role authorization"}
    D1 -->|No| X3(["X3 Keep draft and explain missing input or role"])
    D1 -->|Yes| A5["A5 Submit existing plan command"]
    A5 --> D2{"D2 Existing server role, input and territory checks pass"}
    D2 -->|No| X4(["X4 Keep draft and display actionable failure without automatic retry"])
    D2 -->|Yes| T1["T1 Persist CREATED task through planTask transaction"]
    T1 --> D3{"D3 Successful response includes the new Task ID"}
    D3 -->|Yes| X5(["X5 Open exactly the returned task without dispatch"])
    D3 -->|No| X4
    G1[["G1 REVIEW and runtime completion never imply Owner input or human acceptance"]] -.-> A2
    G2[["G2 Existing server principal, scope and command guards remain authoritative"]] -.-> D1
    G2 -.-> A5
    G3[["G3 Missing usage and truncated queues remain explicit"]] -.-> A2
    G3 -.-> A7
    G4[["G4 Read-only projection does not mutate canonical state"]] -.-> A1
```

## Sequence

```mermaid
sequenceDiagram
    actor User
    participant GUI
    participant Projection
    participant Store
    participant Control
    User->>GUI: Open workbench or task
    GUI->>Projection: Snapshot or exact task detail
    Projection->>Store: Read existing facts, scoped role costs, budget and assembly observations
    Store-->>Projection: Canonical rows and task-scoped events
    Note over Projection,GUI: Current runtime mode is injected separately; missing configuration stays explicitly unconfirmed
    Projection-->>GUI: Bounded queues and distinct evidence layers
    GUI-->>User: Current responsibility and partial usage coverage
    User->>GUI: Edit local draft and explicitly submit
    GUI->>Control: Existing plan command with supported parameters
    alt Authenticated authorized Chancellor and valid territory
        Control->>Store: Existing planTask transaction creates CREATED task
        Store-->>Control: Exact new Task ID
        Control-->>GUI: Successful command result
        GUI-->>User: Open returned task; no automatic assignment or dispatch
    else Missing role, invalid input or command failure
        Control-->>GUI: Stable failure code
        GUI-->>User: Preserve draft and show next step
    end
```

## State

```mermaid
stateDiagram-v2
    [*] --> CREATED: T1 explicit authorized plan submission / existing transaction
```

## Evidence and failure boundaries

- Owner queue contains current configuration decisions supported by canonical missing bindings or territory ownership; REVIEW and REWORK stay internal. Recovery responsibility follows the actual territory Supervisor, and absent evidence stays unconfirmed.
- A Worker Claim, runtime terminal evidence, Supervisor ACCEPT and human acceptance remain separate. No human acceptance ledger exists in this stage; it is always shown as not recorded.
- The original usage summary still covers Worker Dispatch records only. Separate panels show Chancellor/Supervisor observations and the kingdom soft budget. Exact task detail includes only TASK-attributed role usage; shared and unattributed observations are not allocated or counted twice. Missing coverage never becomes zero cost or a platform-wide total.
- Budget displays distinguish provider reports, reserved estimates, estimated exposure, remaining admission capacity, pending/unconfirmed/recovering units and attribution gaps. The browser renders Core budget states without deciding admission. Amount stays unconfirmed. The /owner management link requires a separately activated Owner window; tightening or disabling policy does not terminate in-flight work, release recovery occupancy or reset accounting.
- Current off/pilot and observer availability remain separate from historical assembly mode; absent injection stays explicitly unconfirmed with null availability. Cost projection bounds recent rows at 40 and each section/context list at 24 with truncation. Runtime/session/source-unit references and prompt text are omitted. Assembly bytes are not final-request Tokens or savings; historyBytes and tokenEstimate stay null.
- Browsing performs reads only. Draft fields stay in GUI memory and do not call a model. Existing plan transaction, authorization and rejection behavior are reused; no new authority, fact store, automatic retry or dispatch is introduced. Successful submission consumes only the submitted draft; edits made while the command is in flight remain intact. Rejection or a missing returned identity preserves the draft and never resubmits automatically.
- Task history is scoped to the exact task before applying its display bound, with explicit truncation. Supervisor decisions have their own task-scoped window and require a Supervisor actor; runtime failure and Owner topology events do not become Supervisor reviews. Refresh keeps navigation, draft, detail and keyboard state in the GUI.
- Root performs local HTTP validation of four themes, narrow screen, keyboard and reduced motion. Motion preserves existing larger character actions.
- Failed snapshot reads disable writes and preserve the draft. Reconnect at the same revision, control revocation and reactivation update the status message; read-only polling never retries a write.

## Validation

- 1.4 maps the four tests in tests/v14-cost-gui.test.ts for attribution, current versus historical mode, bounded byte projection, explicit estimates/unconfirmeds and typed Owner form payloads. Coordinating-task browser-cost-report.json records 16 theme/width scenarios, keyboard budget preparation/commit and actual GUI/Core budget-state changes with zero JavaScript errors; Owner identity and usage inputs are synthetic. This documentation-only pass does not rerun product tests or claim real Provider/human acceptance.
- Projection and affected runtime/stage regression: `node --test tests/gui-personal-workbench.test.ts tests/m3s2-v4-gui.test.ts tests/gui-stage-cardinality.test.ts` — 31/31 passed, including seven new workbench cases.
- Construction A reported 41/41 affected frontend tests passed, including eight new workbench interaction cases. Browser visual acceptance remains root evidence, independent of these source and behavior checks.
- Final failure-path regression: workbench 9/9; local HTTP browser confirms retained draft, disabled writes while unavailable/revoked, restored status and zero command/model requests.
