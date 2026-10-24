import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * Retention from the recovery requirements.
 *
 * Noncurrent versions stay for the whole window, then expire. Current
 * critical/ and app-data/ objects are not expired. Delete markers are removed
 * only after the versions under them are gone.
 *
 * temp/ has no version-recovery requirement. S3 rejects a 0-day noncurrent
 * expiration, so those versions expire after the 1-day minimum. The current
 * temp object is kept.
 */
export function retentionLifecycleRules(): s3.LifecycleRule[] {
  return [
    {
      id: 'CriticalNoncurrentVersions',
      prefix: 'critical/',
      noncurrentVersionExpiration: cdk.Duration.days(90),
      expiredObjectDeleteMarker: true,
    },
    {
      id: 'AppDataNoncurrentVersions',
      prefix: 'app-data/',
      noncurrentVersionExpiration: cdk.Duration.days(30),
      expiredObjectDeleteMarker: true,
    },
    {
      id: 'TempNoncurrentVersions',
      prefix: 'temp/',
      noncurrentVersionExpiration: cdk.Duration.days(1),
      expiredObjectDeleteMarker: true,
    },
  ];
}
