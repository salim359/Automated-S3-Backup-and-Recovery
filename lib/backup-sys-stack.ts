import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { retentionLifecycleRules } from './retention';

export interface BackupSysStackProps extends cdk.StackProps {
  /** Versioned replica in us-west-2. Receives new critical/ and app-data/ objects. */
  readonly replicaBucket: s3.IBucket;
  /** Customer-managed key used to encrypt replica objects. */
  readonly replicaKey: kms.IKey;
}

export class BackupSysStack extends cdk.Stack {
  public readonly sourceBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: BackupSysStackProps) {
    super(scope, id, props);

    // S3 assumes this role. Same-account KMS access is granted on the role;
    // the replica key policy already allows this account, so the stacks do not
    // need to reference each other in both directions.
    const replicationRole = new iam.Role(this, 'ReplicationRole', {
      assumedBy: new iam.ServicePrincipal('s3.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': this.account,
          },
        },
      }),
      description: 'Assumed by S3 to replicate objects to the us-west-2 backup bucket',
    });

    // Versioning is how an overwrite or delete is recovered in us-east-1.
    // Replication copies only objects written after this configuration exists.
    // Objects already in the bucket need a separate batch replication action.
    // temp/ is omitted: it does not need a replica.
    this.sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: retentionLifecycleRules(),
      replicationRole,
      replicationRules: [
        {
          id: 'Critical',
          priority: 1,
          filter: { prefix: 'critical/' },
          destination: props.replicaBucket,
          kmsKey: props.replicaKey,
          // Required when replicas are encrypted with a customer-managed key.
          // SSE-S3 objects still replicate; this also allows SSE-KMS sources.
          sseKmsEncryptedObjects: true,
          deleteMarkerReplication: true,
        },
        {
          id: 'AppData',
          priority: 2,
          filter: { prefix: 'app-data/' },
          destination: props.replicaBucket,
          kmsKey: props.replicaKey,
          sseKmsEncryptedObjects: true,
          deleteMarkerReplication: true,
        },
      ],
    });

    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetReplicationConfiguration', 's3:ListBucket'],
      resources: [this.sourceBucket.bucketArn],
    }));
    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:GetObjectVersionForReplication',
        's3:GetObjectVersionAcl',
        's3:GetObjectVersionTagging',
      ],
      resources: [this.sourceBucket.arnForObjects('*')],
    }));
    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ReplicateObject', 's3:ReplicateDelete', 's3:ReplicateTags'],
      resources: [props.replicaBucket.arnForObjects('*')],
    }));
    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Encrypt', 'kms:GenerateDataKey*'],
      resources: [props.replicaKey.keyArn],
    }));

    new s3deploy.BucketDeployment(this, 'SampleDataset', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'sample-data'))],
      destinationBucket: this.sourceBucket,
      // Keep objects created later during overwrite/delete recovery tests.
      prune: false,
    });

    new cdk.CfnOutput(this, 'SourceBucketName', {
      value: this.sourceBucket.bucketName,
      description: 'Versioned source bucket (us-east-1)',
    });
  }
}
