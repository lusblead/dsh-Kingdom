---
feature_id: "governed-process-boundaries"
title: "Owned process crash and SQLite Lease contention verification"
status: "implemented"
---

# Owned process crash and SQLite Lease contention verification

Explicit tests or the local probe runner create a disposable SQLite database and
launch only their own Node child processes. The real Core `acquireExecutionLease`
and `prepareGovernedDispatch` write the fixture ledger. Capability enforcement and
external acceptance are explicitly fake prerequisites; this flow does not prove a
real DeepSeek Harness dispatch, Provider run, model, cleanup or production host
restart.

Three named crash barriers cover TX-3 before COMMIT, after COMMIT but before a
Runtime call, and fake external acceptance before Receipt persistence. The parent
receives the barrier via IPC, forcibly kills that exact child, and launches a new
process to reopen the same isolated DB. Before COMMIT, the complete uncommitted
TX-3 tuple rolls back: no Execution or Dispatch survives and Lease remains
DISPATCH_READY. After COMMIT, STARTING Execution, INTENDED Dispatch and EXECUTING
Lease survive together. Neither post-COMMIT scenario has a durable Receipt or
Runtime reference, even though one scenario has an independent fake acceptance
marker. This deliberately demonstrates that missing receipt/event evidence
cannot establish non-dispatch.

The new process calls the existing reconcile entry, then explicitly applies the
Core indeterminate-evidence recovery decision. Committed uncertain tuples become three RECOVERING
rows. It also attempts a new same-Session Lease and calls the real Worker runner:
the Lease constraint rejects the former and the active-Lease guard rejects the
latter before any Runtime action. Recovery does not complete the Task or release
its Lease. For the pre-COMMIT scenario there is no Dispatch to reconcile; the
retained DISPATCH_READY Lease continues to block blind retry.

For contention, two genuinely different processes open the same initialized
database with `openExistingOnly`. Both report READY, then receive GO. The first
BEGIN IMMEDIATE writer holds a test-only file barrier until the parent has
observed both acquire attempts. After a bounded artificial hold, the writer
commits and the other process either reaches the Session unique constraint or
reports SQLITE_BUSY. Exactly one Lease survives. This probe stops at acquisition;
neither participant invokes Runtime dispatch. Reported lock acquisition and total
elapsed times include the artificial barrier and cannot measure production
latency or establish multi-host behavior.

```mermaid
flowchart TD
  E1["E1 Explicit process-boundary tests or probe runner"] --> A1["A1 Create disposable DB and owned children"]
  A1 --> T1["T1 Seed real Core prerequisites with fake enforcement"]
  T1 --> D1{"D1 Crash or contention scenario?"}
  D1 -->|crash| A2["A2 Execute real TX-3 to named IPC barrier"]
  A2 --> D2{"D2 Before COMMIT?"}
  D2 -->|yes| C1["C1 Kill owned child; SQLite rolls TX-3 back"]
  D2 -->|no| T2["T2 Preserve committed STARTING / INTENDED / EXECUTING tuple"]
  T2 --> A3["A3 Optional fake acceptance marker before receipt"]
  A3 --> C1
  C1 --> A4["A4 New process reopens DB and reads durable rows"]
  A4 --> D4{"D4 Crash inspection needs recovery checks?"}
  D4 -->|yes| T3["T3 Existing indeterminate recovery preserves blocking Lease"]
  D4 -->|no| D3
  T3 --> A5["A5 Verify new Lease and Worker retry are rejected"]
  D1 -->|contention| A6["A6 Two READY processes receive GO for same Session"]
  A6 --> A7["A7 Hold first write lock until both attempts; bounded release"]
  A7 --> T4["T4 One ACQUIRED Lease; competing writer rejected"]
  T4 --> A4
  A5 --> D3{"D3 All boundary assertions hold?"}
  D3 -->|yes| X1["X1 Bounded local Node / SQLite report; real DSH NOT_RUN"]
  D3 -->|no| X2["X2 Fail test and clean owned resources"]
  G1["G1 Kill and cleanup only invocation-owned processes and scratch directory"] -.-> A1
  G1 -.-> C1
  G2["G2 Missing Receipt never permits blind resend or Lease release"] -.-> T3
  G2 -.-> A5
  G3["G3 Fake Runtime and artificial latency remain explicitly labeled"] -.-> A3
  G3 -.-> X1
```

```mermaid
sequenceDiagram
  actor V as Test or probe caller
  participant P as Parent process
  participant C as Owned writer child
  participant S as SQLite temporary DB
  participant F as Fake external marker
  participant R as New inspection child
  V->>P: Invoke named crash or contention scenario
  P->>C: Initialize isolated Core fixture
  alt Crash barrier
    C->>S: BEGIN IMMEDIATE; prepareGovernedDispatch
    alt Before COMMIT
      C-->>P: IPC barrier with uncommitted tuple
      P->>C: SIGKILL exact owned ChildProcess
      S->>S: Roll back uncommitted TX-3
    else After COMMIT
      C->>S: COMMIT Execution / Dispatch / Lease
      opt Fake accepted before Receipt
        C->>F: Write and flush FAKE_RUNTIME_ACCEPTANCE
      end
      C-->>P: IPC barrier before receipt persistence
      P->>C: SIGKILL exact owned ChildProcess
    end
    P->>R: Launch genuinely new process on same test DB
    R->>S: Read durable tuple and explicitly apply indeterminate recovery
    R->>S: Attempt same-Session Lease; verify rejection
    R->>R: Worker guard rejects before Runtime action
    R-->>P: Bounded rows and rejection categories
  else Two-process contention
    P->>C: Launch two connections; wait for both READY
    P->>C: GO to both processes
    C->>S: Two actual BEGIN IMMEDIATE acquire attempts
    C-->>P: Both ATTEMPTING and first LOCK_HELD
    P->>C: Release test barrier after bounded artificial hold
    S-->>C: One commit; one uniqueness or busy rejection
    C-->>P: Lease results and local elapsed observations
    P->>R: Reopen and confirm exactly one Lease, no Dispatch
  end
  P-->>V: Local fake-Runtime report or assertion failure
  P->>P: Stop only owned children and remove owned scratch
```

```mermaid
stateDiagram-v2
  [*] --> LeaseReady: T1 seed ACQUIRED through DISPATCH_READY with fake enforcement
  LeaseReady --> PreparedUncommitted: T2 prepare real TX-3
  PreparedUncommitted --> LeaseReady: T5 forced kill before COMMIT rolls back
  PreparedUncommitted --> CommittedIntent: T2 COMMIT STARTING / INTENDED / EXECUTING
  CommittedIntent --> Recovering: T3 explicit indeterminate decision after restart
  Recovering --> Recovering: T3 retry rejected and Lease remains blocking
  LeaseReady --> LeaseReady: T3 retry rejected without Dispatch
  [*] --> AffinityReady: T1 contention fixture without Lease
  AffinityReady --> OneAcquiredLease: T4 competing processes produce one durable Lease
  OneAcquiredLease --> OneAcquiredLease: T4 second process rejected
```

Validation: `node --test tests/governed-process-boundaries.test.ts`, using the
current emitted library or an isolated verification stage. The optional
`KINGDOM_PROCESS_PROBE_LIB_ROOT` selects that stage; optional
`KINGDOM_PROCESS_PROBE_REPORT` writes a private JSON result from the same test
execution. Public reports contain no temporary database paths, credentials,
conversation content or file hashes. Process timing is recorded dynamically.
