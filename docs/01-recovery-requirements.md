# Recovery Requirements

Project: **Automated S3 Backup and Recovery**

This document defines what we protect, how fast we must restore it, and how much data loss is acceptable. Later steps (versioning, lifecycle, optional replication, and recovery tests) must satisfy these numbers.

## 1. What we are protecting

Primary store: source bucket in `us-east-1` (N. Virginia).

| Prefix | Contents | Protection |
|--------|----------|------------|
| `critical/` | Contracts, invoices, customer records, and other files that cannot be recreated | Full — versioning, lifecycle retention, and cross-region replica |
| `app-data/` | Application uploads and working files users create or replace | Full — versioning, lifecycle retention, and cross-region replica |
| `temp/` | Scratch files and short-lived exports | None — may be overwritten or expire without recovery |

Admin and users write to the source bucket. Recovery must cover both accidental operator mistakes and user mistakes.

Out of scope for this project:

- Files that never left a local disk
- Data in services other than S3
- Point-in-time restore of an entire bucket to an arbitrary historical second (we restore object versions, not a snapshot of the whole bucket)

## 2. Failure scenarios

| ID | Scenario | Typical cause |
|----|----------|----------------|
| F1 | Accidental overwrite | User or admin `PUT`s a new object on an existing key |
| F2 | Accidental deletion | User or admin deletes an object (S3 creates a delete marker) |
| F3 | Bulk delete / prefix wipe | Script or console delete of many keys |
| F4 | Region disruption | `us-east-1` unavailable; replica in `us-west-2` is the recovery source |

## 3. RTO and RPO

**RTO (Recovery Time Objective)** — maximum time from “we decided to recover” until the needed file is usable again.

**RPO (Recovery Point Objective)** — maximum acceptable data loss, measured as time between the last recoverable copy and the incident.

| Scenario | RTO | RPO | Recovery method |
|----------|-----|-----|-----------------|
| F1 Overwrite of one object | **15 minutes** | **0** — previous version must already exist | Restore prior version in the source bucket |
| F2 Delete of one object | **15 minutes** | **0** — object version must still exist | Remove delete marker or copy a prior version |
| F3 Bulk delete (up to 100 objects) | **1 hour** | **0** | Same as F2, scripted over the affected keys |
| F4 `us-east-1` unavailable | **1 hour** | **15 minutes** | Read or promote objects from the `us-west-2` replica |

Why these numbers:

- Versioning makes the previous object available immediately after overwrite or delete. RPO is therefore **zero** for F1–F3 as long as versioning is on before the incident.
- Fifteen minutes of RTO for a single file is enough for a person or a small script to list versions and restore one key. We are not targeting a fully automated self-service portal in this project.
- Cross-region replication is **asynchronous**. A 15-minute RPO for F4 covers normal replication lag. Objects written in the last few minutes may not be on the replica yet.
- One hour of RTO for a region event covers deciding to fail over, pointing recovery at the destination bucket, and restoring the needed keys.

## 4. Retention (how long versions stay recoverable)

| Data class | Keep noncurrent versions | Keep delete markers |
|------------|--------------------------|---------------------|
| `critical/` | 90 days | 90 days (then expire if the current object is gone) |
| `app-data/` | 30 days | 30 days |
| `temp/` | 0 days — current object only; no version restore required | Not required |

After the retention window, lifecycle rules may expire old versions. Recovery of incidents older than that window is **not** required.

## 5. Durability and copies

| Copy | Region | Role |
|------|--------|------|
| Source bucket (versioned) | `us-east-1` | Primary write target; first restore location for F1–F3 |
| Replica bucket (versioned) | `us-west-2` | Secondary copy for F4; also a second chance if the source is intact but a version is needed |

Both buckets use KMS encryption. Replication uses an IAM role assumed by the S3 service.

## 6. What “recovered” means

A recovery is successful when:

1. The required object key exists and is readable.
2. Its content matches a known good version (checksum or byte compare).
3. Time from start of recovery to a successful read is within the RTO for that scenario.
4. The restored version is no older than the RPO allows (for F1–F3: the version immediately before the incident; for F4: a replica no more than 15 minutes behind).

## 7. Requirements we will test later

These are the acceptance checks for the backup strategy:

- [ ] Versioning is enabled on source and destination buckets.
- [ ] Overwriting `app-data/sample.txt` leaves the previous bytes recoverable within 15 minutes (F1).
- [ ] Deleting `critical/sample.txt` leaves the object recoverable within 15 minutes (F2).
- [ ] A prior version older than the lifecycle window is expired; a version inside the window is still listed.
- [ ] An object written to the source (outside `temp/`) appears in the replica; measured lag is within 15 minutes under normal conditions (F4 / RPO).
- [ ] `temp/` objects are not required to replicate or retain versions.

## 8. Assumptions

- This is a lab / portfolio implementation, not a production multi-account landing zone.
- Recovery is operator-driven (CLI or console), not an end-user “undelete” UI.
- Workload size for tests is small (individual objects and a bulk set of about 100 keys), not petabytes.
- Replication lag of up to 15 minutes is acceptable; we will not require Synchronous replication.
