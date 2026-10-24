import * as cdk from 'aws-cdk-lib/core';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { retentionLifecycleRules } from './retention';

export class BackupBucketStack extends cdk.Stack {
  public readonly backupBucket: s3.IBucket;
  public readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Same account for this version. A later version can move this bucket
    // and its key into a separate backup account for stronger isolation.
    this.encryptionKey = new kms.Key(this, 'BackupBucketKey', {
      description: 'Customer-managed key for the backup bucket',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.backupBucket = new s3.Bucket(this, 'BackupBucket', {
      // Required so the us-east-1 stack can reference this bucket across regions.
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: retentionLifecycleRules(),
    });

    new cdk.CfnOutput(this, 'BackupBucketName', {
      value: this.backupBucket.bucketName,
      description: 'Private versioned backup bucket (us-west-2), encrypted with a customer-managed key',
    });
  }
}
