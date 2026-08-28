---
feature_id: "release.v1-pipeline"
title: "v1.0 release pipeline P0-P3 local gate and post-audit handoff"
status: "implemented"
---

# v1.0 release pipeline P0-P3 local gate and post-audit handoff

## Purpose

`scripts/release.ps1` is only a local P0-P3 validation and pack tool. It reads
the frozen version, runs local quality gates, and creates a fresh tgz in a new
temporary directory. It never stages, commits, tags, pushes, uploads, publishes,
or announces a release.

After P3, `-DryRun` exits before P4. A non-DryRun invocation fails closed with
requirements for a separate post-audit governed command. P4-P8 are not callable
through this script.

## Entry, preconditions, and terminal outcomes

- Entry: `pwsh -File scripts/release.ps1 -Version <version>`, with or without
  `-DryRun`.
- Preconditions: P0 passes, `package.json` is already frozen at the requested
  version, and local TypeScript/test/pack tools are available.
- Success: P2/P3 pass and a DryRun exits zero before P4.
- Non-DryRun: P0-P3 may complete, then the script throws before P4-P8.
- Failure: a failed local gate, mismatch, failed pack, stale target, or missing
  target stops before a later stage.

## Runtime flow

```mermaid
flowchart TD
    E1(["E1 Invoke release.ps1 with Version and optional DryRun"]) --> A1["A1 P0 checks the local Git worktree"]
    A1 --> D1{"D1 P0 check passes"}
    D1 -->|No| X1(["X1 Throw before P1-P8"])
    D1 -->|Yes| A2["A2 P1 reads the frozen package version"]
    A2 --> D2{"D2 Frozen package version equals Version"}
    D2 -->|No| X2(["X2 Throw without package metadata change"])
    D2 -->|Yes| A3["A3 P2 runs typecheck and node tests"]
    A3 --> D3{"D3 P2 commands succeed"}
    D3 -->|No| X3(["X3 Throw before P3-P8"])
    D3 -->|Yes| A4["A4 P3 creates a GUID temp directory and runs npm pack"]
    A4 --> D4{"D4 Pack is zero exit and creates the expected fresh tgz"}
    D4 -->|No| X4(["X4 Throw before P4-P8; no stale artifact substitution"])
    D4 -->|Yes| D5{"D5 DryRun requested"}
    D5 -->|Yes| X5(["X5 Exit zero after P3; no P4-P8 side effect"])
    D5 -->|No| A5["A5 Emit external P4-P8 identity requirements and throw"]
    A5 --> X6(["X6 Non-DryRun fail-closed; P4-P8 unavailable"])
    G1[["G1 Check gate: failed local gate throws before a later stage"]] -.-> A1
    G1 -.-> D1
    G2[["G2 Frozen-version guard: the script only reads package metadata"]] -.-> A2
    G2 -.-> D2
    G3[["G3 Fresh-artifact guard: new temp path and expected file are required"]] -.-> A4
    G3 -.-> D4
    G4[["G4 Side-effect cutoff: neither mode can enter P4-P8"]] -.-> D5
    G4 -.-> A5
    G5[["G5 External identity contract: future P4/P6 need immutable audited inputs"]] -.-> A5
```

## Component sequence

```mermaid
sequenceDiagram
    actor Operator
    participant Script as release.ps1
    participant Git as Git CLI
    participant NPM as npm CLI
    Operator->>Script: Version and optional DryRun
    Script->>Git: P0 git status --porcelain
    alt P0/P1 rejection
        Script-->>Operator: throw before P2-P8
    else P0 and version pass
        Script->>Script: P2 typecheck and node tests
        alt P2 failure
            Script-->>Operator: throw before P3-P8
        else P2 passes
            Script->>NPM: P3 npm pack to new temporary directory
            alt pack failure or non-fresh expected tgz
                Script-->>Operator: throw before P4-P8
            else fresh P3 tgz
                alt DryRun
                    Script-->>Operator: exit zero before P4
                else non-DryRun
                    Script-->>Operator: throw with external P4-P8 requirements
                end
            end
        end
    end
```

## External post-audit contract

The script does not implement an external release command. Its fail-closed
handoff requires that a separately authorized post-audit governed command:

- consumes a frozen explicit path manifest plus exact commit/tag identity for
  future P4 and stops before Git side effects on a missing or mismatched input;
- receives an exact audited tgz path plus expected SHA-256 for future P6, verifies
  both before side effects, and invokes `npm publish <exact-audited-tgz>` rather
  than repacking the working directory;
- remains separately governed and hard blocked here. These requirements neither
  authorize nor prove P4-P8.

## State lifecycle

The script persists no release state, so this contract has no state diagram.

## Safeguards

- G1: `Check` throws immediately on a failed local gate.
- G2: P1 reads the frozen package version and never changes package metadata.
- G3: P3 accepts only an invocation-specific expected tgz in a new temporary directory.
- G4: neither DryRun nor non-DryRun can execute P4-P8 through this script.
- G5: an external immutable-identity contract prevents fixed two-file staging,
  broad tag pushes, and working-directory publish from becoming callable routes.

## Failure, recovery, and observability

`Check` writes bounded PASS/FAIL detail and throws on failure. There is no retry,
Git mutation, registry mutation, or remote operation. A non-DryRun completion at
P3 is not release success: it ends in a fail-closed handoff requiring separate
audited evidence and authority.

## Implementation notes

The machine-readable code and test mapping is maintained in `traceability.yaml`.
