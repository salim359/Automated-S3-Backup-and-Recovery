#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BackupBucketStack } from '../lib/backup-bucket-stack';
import { BackupSysStack } from '../lib/backup-sys-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
};

const backupStack = new BackupBucketStack(app, 'BackupBucketStack', {
  description: 'Automated S3 backup and recovery — versioned backup bucket',
  crossRegionReferences: true,
  env: { ...env, region: 'us-west-2' },
});

new BackupSysStack(app, 'BackupSysStack', {
  description: 'Automated S3 backup and recovery — versioned source bucket with cross-region replication',
  crossRegionReferences: true,
  env: { ...env, region: 'us-east-1' },
  replicaBucket: backupStack.backupBucket,
  replicaKey: backupStack.encryptionKey,
});
