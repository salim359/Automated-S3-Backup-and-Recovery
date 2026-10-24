# Recovery Runbook

Use this when an object in the source bucket was overwritten and a previous version must be made current again. If `us-east-1` cannot be used, run the same steps against the replica in `us-west-2`.

Recovery time starts when the decision to recover is made, and stops when a normal read of the key returns the known-good bytes. Replication lag is not part of that clock.

Targets from the recovery requirements:

| Scenario | Bucket | RTO |
|---|---|---|
| F1 Overwrite | Source, `us-east-1` | 15 minutes |
| F4 Region unavailable | Replica, `us-west-2` | 1 hour |

## Buckets

```bash
SOURCE=$(aws cloudformation describe-stacks --region us-east-1 --stack-name BackupSysStack \
  --query "Stacks[0].Outputs[?OutputKey=='SourceBucketName'].OutputValue" --output text)
DEST=$(aws cloudformation describe-stacks --region us-west-2 --stack-name BackupBucketStack \
  --query "Stacks[0].Outputs[?OutputKey=='BackupBucketName'].OutputValue" --output text)
```

Protected keys live under `critical/` and `app-data/`. `temp/` is not replicated and previous versions there expire after one day, so do not use this procedure for `temp/`.

Have the known-good checksum before you start. A SHA-256 recorded at the last accepted upload is enough. For a single-part SSE-S3 object, the version `ETag` is also the MD5 of the body. Replica objects encrypted with the backup bucket key do not have an `ETag` equal to the content MD5, so compare bytes or SHA-256 for those.

## 1. Identify the correct version

List versions for the exact key. `Prefix` must be the full key, not a folder.

```bash
aws s3api list-object-versions \
  --bucket "$SOURCE" \
  --prefix "app-data/sample.txt" \
  --region us-east-1
```

Read `Versions`, not `DeleteMarkers`.

- The current object is the entry with `IsLatest: true`. After an overwrite, that entry is the bad copy.
- Ignore delete markers. A latest delete marker means the key was deleted. The bytes to restore are still a noncurrent version.
- Download each remaining version and hash it. The correct version is the newest one whose SHA-256 equals the known-good checksum.
- Replication keeps the source version id on the replica. The same id can be used in `us-west-2` after that version has replicated.

```bash
aws s3api get-object \
  --bucket "$SOURCE" \
  --key "app-data/sample.txt" \
  --version-id "VERSION_ID" \
  --region us-east-1 \
  /tmp/candidate.txt
sha256sum /tmp/candidate.txt
```

## 2. Restore the object

Copy the chosen version onto the same key. That writes a new current version. It does not delete the bad version.

```bash
aws s3api copy-object \
  --bucket "$SOURCE" \
  --key "app-data/sample.txt" \
  --copy-source "${SOURCE}/app-data/sample.txt?versionId=VERSION_ID" \
  --region us-east-1
```

On the replica, use `--region us-west-2` and `$DEST`. The copy is stored with that bucket's default encryption. The replica bucket default is the customer-managed key, so the caller needs permission to use that key.

## 3. Validate contents

Read the candidate file from step 1, or the restored object, and compare it to the known-good checksum.

```bash
sha256sum /tmp/candidate.txt
```

The restore is not complete until the hash matches. A matching version id alone is not enough.

## 4. Confirm application access

An application reads the key with no version id. This project has no separate application process, so this read is the access check.

```bash
aws s3api get-object \
  --bucket "$SOURCE" \
  --key "app-data/sample.txt" \
  --region us-east-1 \
  /tmp/app-read.txt
sha256sum /tmp/app-read.txt
```

Access is confirmed when that command succeeds and the hash equals the known-good checksum. If it returns the overwrite, or `AccessDenied`, the application is still not seeing the restored object.

## Recovery from the destination bucket

Use this when the source region cannot serve the object, or when the replica must be checked on its own.

1. Repeat section 1 against `$DEST` in `us-west-2`.
2. Restore with `copy-object` onto `$DEST` in `us-west-2`.
3. Validate the checksum.
4. Confirm access with `get-object` and no version id, in `us-west-2`.

Only `critical/` and `app-data/` objects written after replication was enabled are on the replica. Objects already in the source bucket before that configuration were not copied. A missing replica key is a replication gap, not a failed version lookup.

The replica can lag the source by up to 15 minutes. Wait for the known-good version to appear before starting the recovery clock. Do not add that wait to the recovery time.

## Drill record — 24 October 2026

Object: `app-data/sample.txt`.

Known-good SHA-256: `15769fb151ce8e667fb0d287d824d64528867b86fa1b4abaf6140479e60bcb4e`

The original file was overwritten with a different body, then recovered by copying the previous version back to the same key. The replica was restored on its own, before the source was restored.

| Step | Region | Result | Time |
|---|---|---|---|
| Original object visible on the replica | `us-west-2` | SHA-256 matched | 7.8 seconds after the check started. Not part of RTO. |
| Overwrite visible as a second replica version | `us-west-2` | Bad and good versions both listed | Within about 30 seconds. Not part of RTO. |
| Restore previous version on the source | `us-east-1` | Application read matched known-good SHA-256 | **15.4 seconds** |
| Restore previous version on the replica | `us-west-2` | Application read matched known-good SHA-256 | **22.9 seconds** |

Version restored: `8R3M1xmUV3kg5Qbxrv.x1FYcdF2KkZkh`.

Both times are inside the 15-minute overwrite RTO. The replica restore is also inside the 1-hour region RTO.

Restored text:

```text
APP-DATA v1 — weekly application upload.
Overwrite this key in recovery tests to verify a prior version is kept.
```
