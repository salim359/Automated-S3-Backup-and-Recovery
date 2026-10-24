import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? '127.0.0.1';
const SOURCE_REGION = process.env.SOURCE_REGION ?? 'us-east-1';
const DEST_REGION = process.env.DEST_REGION ?? 'us-west-2';
const SOURCE_STACK = process.env.SOURCE_STACK ?? 'BackupSysStack';
const DEST_STACK = process.env.DEST_STACK ?? 'BackupBucketStack';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const FOLDERS = [
  {
    id: 'critical',
    prefix: 'critical/',
    name: 'Important records',
    summary: 'Contracts, invoices, and records you cannot recreate.',
    retentionDays: 90,
    backedUp: true,
  },
  {
    id: 'app-data',
    prefix: 'app-data/',
    name: 'Working files',
    summary: 'Everyday uploads. Previous copies are kept for 30 days.',
    retentionDays: 30,
    backedUp: true,
  },
  {
    id: 'temp',
    prefix: 'temp/',
    name: 'Temporary',
    summary: 'Scratch files. These are not copied to the second location.',
    retentionDays: 1,
    backedUp: false,
  },
] as const;

type Folder = (typeof FOLDERS)[number];
type Target = 'source' | 'replica';

interface Env {
  source: { bucket: string; region: string };
  replica: { bucket: string; region: string };
}

interface VersionRow {
  versionId: string;
  isLatest: boolean;
  lastModified?: string;
  size?: number;
}

const s3 = {
  source: new S3Client({ region: SOURCE_REGION }),
  replica: new S3Client({ region: DEST_REGION }),
};

let env: Env | undefined;
let envError: string | undefined;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, err: unknown, fallback = 500): void {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  const status = name === 'NoSuchKey' || name === 'NotFound' ? 404 : fallback;
  json(res, status, { error: name, message });
}

async function readRaw(req: IncomingMessage, limit = MAX_UPLOAD_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      throw new Error(`File is too large. The limit is ${Math.round(limit / 1024 / 1024)} MB.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readRaw(req, 64 * 1024)).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

async function stackOutput(region: string, stackName: string, outputKey: string): Promise<string> {
  const cfn = new CloudFormationClient({ region });
  const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const value = out.Stacks?.[0]?.Outputs?.find((item) => item.OutputKey === outputKey)?.OutputValue;
  if (!value) {
    throw new Error(`CloudFormation stack ${stackName} in ${region} has no ${outputKey} output`);
  }
  return value;
}

async function loadEnv(): Promise<Env> {
  const sts = new STSClient({ region: SOURCE_REGION });
  await sts.send(new GetCallerIdentityCommand({}));
  return {
    source: {
      bucket: process.env.SOURCE_BUCKET ?? await stackOutput(SOURCE_REGION, SOURCE_STACK, 'SourceBucketName'),
      region: SOURCE_REGION,
    },
    replica: {
      bucket: process.env.DEST_BUCKET ?? await stackOutput(DEST_REGION, DEST_STACK, 'BackupBucketName'),
      region: DEST_REGION,
    },
  };
}

function buckets(): Env {
  if (!env) {
    throw new Error(envError ?? 'Backup storage is not ready yet');
  }
  return env;
}

function client(target: Target): { s3: S3Client; bucket: string; region: string } {
  const resolved = buckets();
  return target === 'source'
    ? { s3: s3.source, bucket: resolved.source.bucket, region: resolved.source.region }
    : { s3: s3.replica, bucket: resolved.replica.bucket, region: resolved.replica.region };
}

function folderFor(key: string): Folder {
  const folder = FOLDERS.find((item) => key.startsWith(item.prefix));
  if (!folder) {
    throw new Error('Choose a folder for this file');
  }
  return folder;
}

function parseKey(key: string): { folder: Folder; name: string } {
  const folder = folderFor(key);
  const name = key.slice(folder.prefix.length);
  if (!name || name.includes('..') || name.split('/').some((part) => part.length === 0)) {
    throw new Error('Use a simple file name in one folder');
  }
  return { folder, name };
}

function makeKey(folderId: string, name: string): string {
  const folder = FOLDERS.find((item) => item.id === folderId);
  if (!folder) {
    throw new Error('Unknown folder');
  }
  const clean = name.replace(/^.*[\\/]/, '').trim();
  if (!clean || clean.includes('..')) {
    throw new Error('File name is required');
  }
  return `${folder.prefix}${clean}`;
}

async function streamToBytes(body: unknown): Promise<Uint8Array> {
  if (body && typeof body === 'object' && 'transformToByteArray' in body) {
    return await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }
  throw new Error('The file was empty');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function asText(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > 200_000 || bytes.includes(0)) {
    return undefined;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  if (text.length > 0 && replacement / text.length > 0.1) {
    return undefined;
  }
  return text.length > 8000 ? `${text.slice(0, 8000)}\n…` : text;
}

async function listVersions(target: Target, prefix: string, exactKey?: string) {
  const { s3: s3c, bucket } = client(target);
  const versions: Array<VersionRow & { key: string }> = [];
  const deleteMarkers: Array<VersionRow & { key: string }> = [];
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const page = await s3c.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: prefix,
      KeyMarker: keyMarker,
      VersionIdMarker: versionMarker,
    }));
    for (const item of page.Versions ?? []) {
      if (!item.Key || !item.VersionId) continue;
      if (exactKey && item.Key !== exactKey) continue;
      versions.push({
        key: item.Key,
        versionId: item.VersionId,
        isLatest: Boolean(item.IsLatest),
        lastModified: item.LastModified?.toISOString(),
        size: item.Size,
      });
    }
    for (const item of page.DeleteMarkers ?? []) {
      if (!item.Key || !item.VersionId) continue;
      if (exactKey && item.Key !== exactKey) continue;
      deleteMarkers.push({
        key: item.Key,
        versionId: item.VersionId,
        isLatest: Boolean(item.IsLatest),
        lastModified: item.LastModified?.toISOString(),
      });
    }
    if (page.IsTruncated) {
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    } else {
      keyMarker = undefined;
      versionMarker = undefined;
    }
  } while (keyMarker);
  return { versions, deleteMarkers };
}

async function catalog() {
  const files: Array<{
    key: string;
    name: string;
    folderId: string;
    folderName: string;
    size?: number;
    lastModified?: string;
    removed: boolean;
    copies: number;
    backedUp: boolean;
    secondCopy: boolean;
    retentionDays: number;
  }> = [];

  const listings = await Promise.all(FOLDERS.map(async (folder) => {
    const [source, replica] = await Promise.all([
      listVersions('source', folder.prefix),
      folder.backedUp
        ? listVersions('replica', folder.prefix).catch(() => ({ versions: [], deleteMarkers: [] }))
        : Promise.resolve({ versions: [], deleteMarkers: [] }),
    ]);
    return { folder, source, replica };
  }));

  for (const { folder, source, replica } of listings) {

    const keys = new Set([
      ...source.versions.map((item) => item.key),
      ...source.deleteMarkers.map((item) => item.key),
    ]);

    for (const key of keys) {
      const { name } = parseKey(key);
      const current = source.versions.find((item) => item.key === key && item.isLatest);
      const removed = !current && source.deleteMarkers.some((item) => item.key === key && item.isLatest);
      if (!current && !removed) {
        continue;
      }
      const newest = current ?? source.versions
        .filter((item) => item.key === key)
        .sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''))[0];
      const secondCopy = replica.versions.some((item) => item.key === key);
      files.push({
        key,
        name,
        folderId: folder.id,
        folderName: folder.name,
        size: newest?.size,
        lastModified: current?.lastModified ?? source.deleteMarkers.find((item) => item.key === key && item.isLatest)?.lastModified,
        removed,
        copies: source.versions.filter((item) => item.key === key).length,
        backedUp: folder.backedUp,
        secondCopy,
        retentionDays: folder.retentionDays,
      });
    }
  }

  files.sort((a, b) => Number(a.removed) - Number(b.removed) || a.key.localeCompare(b.key));
  return files;
}

async function fileHistory(key: string) {
  parseKey(key);
  const folder = folderFor(key);
  const source = await listVersions('source', key, key);
  const replica = folder.backedUp
    ? await listVersions('replica', key, key).catch(() => ({ versions: [], deleteMarkers: [] }))
    : { versions: [], deleteMarkers: [] };
  const byDate = (a: VersionRow, b: VersionRow) => (b.lastModified ?? '').localeCompare(a.lastModified ?? '');
  return {
    key,
    folder,
    versions: source.versions.sort(byDate),
    removed: source.deleteMarkers.some((item) => item.isLatest),
    deleteMarkers: source.deleteMarkers.sort(byDate),
    secondCopy: replica.versions.length > 0,
    replicaUpdated: replica.versions.find((item) => item.isLatest)?.lastModified,
  };
}

async function readObjectOn(target: Target, key: string, versionId?: string) {
  parseKey(key);
  const { s3: s3c, bucket } = client(target);
  const out = await s3c.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  const bytes = await streamToBytes(out.Body);
  return {
    key,
    target,
    versionId: out.VersionId ?? versionId,
    contentType: out.ContentType,
    contentLength: bytes.byteLength,
    sha256: sha256(bytes),
    text: asText(bytes),
    bytes,
  };
}

async function readObject(key: string, versionId?: string) {
  return readObjectOn('source', key, versionId);
}

async function sideSnapshot(target: Target, key: string) {
  try {
    const listed = await listVersions(target, key, key);
    const byDate = (a: VersionRow, b: VersionRow) => (b.lastModified ?? '').localeCompare(a.lastModified ?? '');
    const versions = listed.versions.sort(byDate);
    const current = versions.some((item) => item.isLatest)
      ? await readObjectOn(target, key)
      : undefined;
    return {
      present: versions.length > 0 || listed.deleteMarkers.length > 0,
      removed: listed.deleteMarkers.some((item) => item.isLatest),
      versions,
      deleteMarkers: listed.deleteMarkers,
      current: current
        ? { versionId: current.versionId, sha256: current.sha256, text: current.text, contentLength: current.contentLength }
        : undefined,
    };
  } catch (err) {
    return {
      present: false,
      removed: false,
      versions: [],
      deleteMarkers: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function compareKey(key: string) {
  parseKey(key);
  const [source, replica] = await Promise.all([
    sideSnapshot('source', key),
    sideSnapshot('replica', key),
  ]);
  return {
    key,
    folder: folderFor(key),
    source,
    replica,
    sameBytes: Boolean(source.current && replica.current && source.current.sha256 === replica.current.sha256),
  };
}

const RETENTION = [
  { prefix: 'critical/', days: 90 },
  { prefix: 'app-data/', days: 30 },
  { prefix: 'temp/', days: 1 },
] as const;

async function lifecycleRules(target: Target) {
  const { s3: s3c, bucket } = client(target);
  const out = await s3c.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
  return (out.Rules ?? []).map((rule) => ({
    id: rule.ID,
    prefix: rule.Filter?.Prefix ?? rule.Prefix,
    days: rule.NoncurrentVersionExpiration?.NoncurrentDays,
  }));
}

async function retentionCheck() {
  const [source, replica] = await Promise.all([
    lifecycleRules('source'),
    lifecycleRules('replica'),
  ]);
  const matches = (rules: Array<{ prefix?: string; days?: number }>) => RETENTION.every((expected) =>
    rules.some((rule) => rule.prefix === expected.prefix && rule.days === expected.days),
  );
  const samples = await Promise.all([
    compareKey('critical/sample.txt'),
    compareKey('app-data/sample.txt'),
  ]);
  const now = Date.now();
  const insideWindow = samples.map((sample) => {
    const folder = sample.folder;
    const cutoff = now - folder.retentionDays * 24 * 60 * 60 * 1000;
    const versions = sample.source.versions.map((version) => {
      const ageMs = version.lastModified ? now - Date.parse(version.lastModified) : 0;
      return {
        versionId: version.versionId,
        lastModified: version.lastModified,
        insideWindow: !version.lastModified || Date.parse(version.lastModified) >= cutoff,
        ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      };
    });
    return {
      key: sample.key,
      retentionDays: folder.retentionDays,
      listed: versions.length,
      insideWindow: versions.filter((item) => item.insideWindow).length,
      versions,
    };
  });
  return {
    expected: RETENTION,
    source,
    replica,
    rulesMatch: matches(source) && matches(replica),
    insideWindow,
    note: 'A version older than the window is expected to expire. This lab cannot wait 30 or 90 days, so the check is: the bucket rules match, and every listed version is still inside the window.',
  };
}

function bulkKeys(prefix: string, count: number): string[] {
  if (!prefix.startsWith('app-data/') && !prefix.startsWith('critical/')) {
    throw new Error('Bulk tests must use a backed-up prefix');
  }
  if (count < 1 || count > 100) {
    throw new Error('Bulk count must be between 1 and 100');
  }
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(3, '0')}.txt`);
}

async function bulkSeed(prefix: string, count: number) {
  const keys = bulkKeys(prefix, count);
  const results = await Promise.all(keys.map((key, index) =>
    putFile(key, Buffer.from(`BULK ${index + 1} — keep this copy.\n`, 'utf8'), 'text/plain; charset=utf-8'),
  ));
  return { keys, results };
}

async function bulkDelete(prefix: string, count: number) {
  const keys = bulkKeys(prefix, count);
  const results = await Promise.all(keys.map((key) => removeFile(key)));
  return { keys, results };
}

async function bulkRestore(prefix: string, count: number) {
  const keys = bulkKeys(prefix, count);
  const results = await Promise.all(keys.map((key) => restorePrevious(key)));
  return { keys, results };
}

async function prefixStatus(prefix: string, count: number) {
  const keys = bulkKeys(prefix, count);
  const rows = await Promise.all(keys.map(async (key) => {
    const view = await compareKey(key);
    return {
      key,
      sourcePresent: Boolean(view.source.current),
      sourceRemoved: Boolean(view.source.removed),
      replicaPresent: Boolean(view.replica.current),
      sha256: view.source.current?.sha256,
    };
  }));
  return {
    prefix,
    count,
    readable: rows.filter((row) => row.sourcePresent).length,
    removed: rows.filter((row) => row.sourceRemoved).length,
    replica: rows.filter((row) => row.replicaPresent).length,
    rows,
  };
}

async function restorePrevious(key: string) {
  const listed = await listVersions('source', key, key);
  const previous = listed.versions
    .filter((item) => !item.isLatest)
    .sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''))[0];
  if (!previous) {
    throw new Error('There is no older version to bring back');
  }
  return restoreFile(key, previous.versionId);
}

async function putFile(key: string, body: Buffer, contentType: string) {
  parseKey(key);
  const { s3: s3c, bucket } = client('source');
  const out = await s3c.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));
  return {
    key,
    versionId: out.VersionId,
    sha256: sha256(body),
    contentLength: body.byteLength,
    replaced: true,
  };
}

async function removeFile(key: string) {
  parseKey(key);
  const { s3: s3c, bucket } = client('source');
  const out = await s3c.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  return { key, removed: true, deleteMarker: Boolean(out.DeleteMarker) };
}

async function restoreFile(key: string, versionId: string) {
  parseKey(key);
  const { s3: s3c, bucket } = client('source');
  const copySource = `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}?versionId=${encodeURIComponent(versionId)}`;
  const out = await s3c.send(new CopyObjectCommand({
    Bucket: bucket,
    Key: key,
    CopySource: copySource,
  }));
  return { key, restoredFrom: versionId, versionId: out.VersionId };
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (file.includes('..') || path.isAbsolute(file)) {
    json(res, 400, { error: 'BadRequest', message: 'Invalid path' });
    return;
  }
  const full = path.join(process.cwd(), 'ui', 'public', file);
  const ext = path.extname(full);
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  };
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'NotFound', message: 'Not found' });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/api/status') {
      if (!env) {
        try {
          env = await loadEnv();
          envError = undefined;
        } catch (err) {
          envError = err instanceof Error ? err.message : String(err);
        }
      }
      json(res, 200, {
        ready: Boolean(env),
        error: envError,
        source: env?.source,
        replica: env?.replica,
        folders: FOLDERS,
        defaultKey: 'app-data/scenario-test.txt',
        rto: { overwriteMinutes: 15, deleteMinutes: 15, bulkMinutes: 60, replicaMinutes: 15 },
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/files') {
      json(res, 200, { files: await catalog() });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/compare') {
      const key = url.searchParams.get('key');
      if (!key) throw new Error('key is required');
      json(res, 200, await compareKey(key));
      return;
    }

    if (method === 'GET' && url.pathname === '/api/history') {
      const key = url.searchParams.get('key');
      if (!key) throw new Error('key is required');
      json(res, 200, await fileHistory(key));
      return;
    }

    if (method === 'GET' && url.pathname === '/api/preview') {
      const key = url.searchParams.get('key');
      if (!key) throw new Error('key is required');
      const versionId = url.searchParams.get('versionId') ?? undefined;
      const object = await readObject(key, versionId);
      json(res, 200, {
        key: object.key,
        versionId: object.versionId,
        contentType: object.contentType,
        contentLength: object.contentLength,
        sha256: object.sha256,
        text: object.text,
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/download') {
      const key = url.searchParams.get('key');
      if (!key) throw new Error('key is required');
      const { name } = parseKey(key);
      const versionId = url.searchParams.get('versionId') ?? undefined;
      const object = await readObject(key, versionId);
      res.writeHead(200, {
        'content-type': object.contentType ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
        'cache-control': 'no-store',
      });
      res.end(Buffer.from(object.bytes));
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/files') {
      const folderId = url.searchParams.get('folder') ?? '';
      const name = url.searchParams.get('name') ?? '';
      const key = url.searchParams.get('key') || makeKey(folderId, name);
      const contentType = String(req.headers['content-type'] ?? 'application/octet-stream');
      json(res, 200, await putFile(key, await readRaw(req), contentType));
      return;
    }

    if (method === 'DELETE' && url.pathname === '/api/files') {
      const body = await readJson(req);
      json(res, 200, await removeFile(requireString(body, 'key')));
      return;
    }

    if (method === 'GET' && url.pathname === '/api/retention') {
      json(res, 200, await retentionCheck());
      return;
    }

    if (method === 'GET' && url.pathname === '/api/prefix') {
      const prefix = url.searchParams.get('prefix') ?? 'app-data/bulk-scenario/';
      const count = Number(url.searchParams.get('count') ?? 10);
      json(res, 200, await prefixStatus(prefix, count));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/bulk') {
      const body = await readJson(req);
      const prefix = typeof body.prefix === 'string' ? body.prefix : 'app-data/bulk-scenario/';
      const count = typeof body.count === 'number' ? body.count : 10;
      const action = requireString(body, 'action');
      if (action === 'seed') json(res, 200, await bulkSeed(prefix, count));
      else if (action === 'delete') json(res, 200, await bulkDelete(prefix, count));
      else if (action === 'restore') json(res, 200, await bulkRestore(prefix, count));
      else throw new Error('action must be seed, delete, or restore');
      return;
    }

    if (method === 'POST' && url.pathname === '/api/restore-previous') {
      const body = await readJson(req);
      json(res, 200, await restorePrevious(requireString(body, 'key')));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/restore') {
      const body = await readJson(req);
      json(res, 200, await restoreFile(requireString(body, 'key'), requireString(body, 'versionId')));
      return;
    }

    if (method === 'GET' && (url.pathname === '/' || !url.pathname.startsWith('/api/'))) {
      await serveStatic(res, url.pathname);
      return;
    }

    json(res, 404, { error: 'NotFound', message: `${method} ${url.pathname}` });
  } catch (err) {
    fail(res, err, err instanceof Error && /required|folder|name|large|simple/i.test(err.message) ? 400 : 500);
  }
});

async function main(): Promise<void> {
  try {
    env = await loadEnv();
    console.log(`Source  ${env.source.region}  ${env.source.bucket}`);
    console.log(`Backup  ${env.replica.region}  ${env.replica.bucket}`);
  } catch (err) {
    envError = err instanceof Error ? err.message : String(err);
    console.error(`Could not reach backup storage yet: ${envError}`);
  }
  server.listen(PORT, HOST, () => {
    console.log(`Backup scenarios  http://${HOST}:${PORT}`);
  });
}

void main();
