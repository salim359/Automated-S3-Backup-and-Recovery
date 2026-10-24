import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BackupBucketStack } from '../lib/backup-bucket-stack';
import { BackupSysStack } from '../lib/backup-sys-stack';

const account = '123456789012';

function stacks() {
  const app = new cdk.App();
  const backup = new BackupBucketStack(app, 'BackupBucketStack', {
    crossRegionReferences: true,
    env: { account, region: 'us-west-2' },
  });
  const source = new BackupSysStack(app, 'BackupSysStack', {
    crossRegionReferences: true,
    env: { account, region: 'us-east-1' },
    replicaBucket: backup.backupBucket,
    replicaKey: backup.encryptionKey,
  });
  return { backup, source };
}

test('source bucket is versioned and receives the sample dataset', () => {
  const { source } = stacks();
  const template = Template.fromStack(source);

  template.resourceCountIs('AWS::S3::Bucket', 1);

  template.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
        },
      ],
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });

  template.hasResourceProperties('Custom::CDKBucketDeployment', {
    Prune: false,
    SourceObjectKeys: Match.anyValue(),
  });
});

test('backup bucket is private, versioned, and encrypted with a customer-managed key', () => {
  const { backup } = stacks();
  const template = Template.fromStack(backup);

  expect(backup.region).toBe('us-west-2');
  template.resourceCountIs('AWS::S3::Bucket', 1);

  template.hasResourceProperties('AWS::KMS::Key', {
    EnableKeyRotation: true,
  });

  template.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          BucketKeyEnabled: true,
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: 'aws:kms',
            KMSMasterKeyID: Match.anyValue(),
          },
        },
      ],
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test('new critical and app-data objects replicate to us-west-2', () => {
  const { source } = stacks();
  const template = Template.fromStack(source);

  expect(source.region).toBe('us-east-1');

  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'sts:AssumeRole',
          Principal: { Service: 's3.amazonaws.com' },
          Condition: {
            StringEquals: { 'aws:SourceAccount': account },
          },
        }),
      ]),
    },
  });

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            's3:GetObjectVersionForReplication',
            's3:GetObjectVersionAcl',
            's3:GetObjectVersionTagging',
          ]),
        }),
        Match.objectLike({
          Action: Match.arrayWith([
            's3:ReplicateObject',
            's3:ReplicateDelete',
            's3:ReplicateTags',
          ]),
        }),
        Match.objectLike({
          Action: Match.arrayWith(['kms:Encrypt', 'kms:GenerateDataKey*']),
        }),
      ]),
    },
  });

  const buckets = template.findResources('AWS::S3::Bucket');
  const rules = Object.values(buckets)[0].Properties.ReplicationConfiguration.Rules as Array<{
    Filter: { Prefix: string };
    Status: string;
    DeleteMarkerReplication: { Status: string };
    Destination: { EncryptionConfiguration: { ReplicaKmsKeyID: unknown } };
    SourceSelectionCriteria?: { SseKmsEncryptedObjects?: { Status: string } };
  }>;

  expect(rules.map((rule) => rule.Filter.Prefix)).toEqual(['critical/', 'app-data/']);
  expect(rules.every((rule) => rule.Status === 'Enabled')).toBe(true);
  expect(rules.every((rule) => rule.DeleteMarkerReplication.Status === 'Enabled')).toBe(true);
  expect(rules.every((rule) => rule.Destination.EncryptionConfiguration.ReplicaKmsKeyID)).toBe(true);
  expect(rules.every((rule) => rule.SourceSelectionCriteria?.SseKmsEncryptedObjects?.Status === 'Enabled')).toBe(true);
});

test('noncurrent versions expire only after the recovery window', () => {
  const { source, backup } = stacks();

  for (const stack of [source, backup]) {
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'CriticalNoncurrentVersions',
            Prefix: 'critical/',
            Status: 'Enabled',
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
            ExpiredObjectDeleteMarker: true,
          }),
          Match.objectLike({
            Id: 'AppDataNoncurrentVersions',
            Prefix: 'app-data/',
            Status: 'Enabled',
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            ExpiredObjectDeleteMarker: true,
          }),
          Match.objectLike({
            Id: 'TempNoncurrentVersions',
            Prefix: 'temp/',
            Status: 'Enabled',
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            ExpiredObjectDeleteMarker: true,
          }),
        ]),
      },
    });

    const buckets = template.findResources('AWS::S3::Bucket');
    const rules = Object.values(buckets)[0].Properties.LifecycleConfiguration.Rules as Array<{
      Prefix?: string;
      ExpirationInDays?: number;
      ExpirationDate?: string;
    }>;
    const protectedRules = rules.filter((rule) => rule.Prefix === 'critical/' || rule.Prefix === 'app-data/');
    expect(protectedRules.every((rule) => rule.ExpirationInDays === undefined && rule.ExpirationDate === undefined)).toBe(true);
  }
});
