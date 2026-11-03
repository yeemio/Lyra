import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ArtifactError, ArtifactStore } from './store.js';

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ArtifactError, `expected ArtifactError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected error ${code}, but call succeeded`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 内容比较：readBytes/readRange 返回 Buffer（Uint8Array 子类），两侧归一原型后比较字节。 */
function assertBytes(actual: Uint8Array, expected: Uint8Array): void {
  assert.deepEqual(Uint8Array.from(actual), Uint8Array.from(expected));
}

function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 7 + 13) % 251;
  return bytes;
}

let rootDir: string;

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'lyra-w2-store-'));
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

test('put/readBytes roundtrip: CAS identity, shard layout, permissions', async () => {
  const store = new ArtifactStore(rootDir);
  const bytes = patternBytes(500);
  const ref = await store.put(bytes, 'application/pdf', '2026-03-10T08:00:00Z');
  const hash = sha256(bytes);
  assert.equal(ref.sha256, hash);
  assert.equal(ref.bytes, 500);
  assert.equal(ref.mediaType, 'application/pdf');
  assert.equal(ref.firstObservedAt, '2026-03-10T08:00:00.000Z'); // store 归一为 UTC ISO

  const readBack = await store.readBytes(hash);
  assertBytes(readBack, bytes);

  const shard = join(rootDir, hash.slice(0, 2));
  const fileStat = await stat(join(shard, hash));
  assert.equal(fileStat.mode & 0o777, 0o600); // 隐私级：文件 0600（§9 第 6 条）
  const rootStat = await stat(rootDir);
  assert.equal(rootStat.mode & 0o777, 0o700); // 根目录 0700
});

test('put idempotent: same hash produces one copy, keeps first firstObservedAt', async () => {
  const store = new ArtifactStore(rootDir);
  const bytes = patternBytes(64);
  const first = await store.put(bytes, 'text/plain', '2026-01-01T00:00:00Z');
  const second = await store.put(bytes, 'text/plain', '2026-06-01T00:00:00Z'); // 迟到的重复抓取
  assert.equal(second.firstObservedAt, first.firstObservedAt); // 保留首次
  assert.equal(second.sha256, first.sha256);

  const shard = join(rootDir, first.sha256.slice(0, 2));
  const contentFiles = (await readdir(shard)).filter((name) => !name.startsWith('.'));
  assert.equal(contentFiles.length, 1); // 不产生第二份内容（§9 第 2 条）
});

test('readBytes recomputes hash: tampered file rejected with HASH_MISMATCH', async () => {
  const store = new ArtifactStore(rootDir);
  const bytes = patternBytes(128);
  const ref = await store.put(bytes, 'text/plain', '2026-03-01T00:00:00Z');
  const target = join(rootDir, ref.sha256.slice(0, 2), ref.sha256);
  await writeFile(target, Buffer.concat([bytes, Buffer.from('X')])); // 白盒篡改磁盘内容
  await expectCode(() => store.readBytes(ref.sha256), 'HASH_MISMATCH');
  await expectCode(() => store.readRange(ref.sha256, 0, 10), 'HASH_MISMATCH'); // 区间读同样走校验
});

test('symlink paths rejected: readBytes ELOOP, put refuses to overwrite', async () => {
  const store = new ArtifactStore(rootDir);
  const bytes = patternBytes(32);
  const hash = sha256(bytes);
  const shard = join(rootDir, hash.slice(0, 2));
  const outside = join(rootDir, 'outside-target.bin');
  await writeFile(outside, bytes);
  await mkdir(shard, { recursive: true }); // 手工摆放符号链接前先建分片目录

  // 符号链接占住目标位：读与写都必须拒绝，不得跟随
  await symlink(outside, join(shard, hash));
  await expectCode(() => store.readBytes(hash), 'PATH_DENIED');
  await expectCode(() => store.put(bytes, 'text/plain', '2026-03-01T00:00:00Z'), 'PATH_DENIED');
  await unlink(join(shard, hash));

  // 正常放回后可读
  await store.put(bytes, 'text/plain', '2026-03-01T00:00:00Z');
  const readBack = await store.readBytes(hash);
  assertBytes(readBack, bytes);
});

test('readBytes missing artifact -> ARTIFACT_MISSING', async () => {
  const store = new ArtifactStore(rootDir);
  await expectCode(() => store.readBytes('f'.repeat(64)), 'ARTIFACT_MISSING');
});

test('readRange slices equal full read; cursor walks to exhaustion', async () => {
  const store = new ArtifactStore(rootDir);
  const bytes = patternBytes(1000);
  const ref = await store.put(bytes, 'application/octet-stream', '2026-03-02T00:00:00Z');

  const full = await store.readBytes(ref.sha256);
  // 游标步进走到末尾：[0,300) → [300,300) → [600,400)（最后一段恰好到底）
  const walk = [
    [0, 300],
    [300, 300],
    [600, 400],
  ] as const;
  let assembled = new Uint8Array(0);
  let cursor: number | null = 0;
  for (const [start, limit] of walk) {
    assert.equal(cursor, start);
    const part = await store.readRange(ref.sha256, start, limit);
    assertBytes(part.bytes, full.slice(start, start + limit)); // 与全量读切片逐字节一致（§9 第 4 条）
    assert.equal(part.total, 1000);
    assert.equal(part.deliveredHash, sha256(part.bytes));
    assert.equal(part.nextCursor, part.truncated ? start + part.bytes.length : null);
    const merged = new Uint8Array(assembled.length + part.bytes.length);
    merged.set(assembled);
    merged.set(part.bytes, assembled.length);
    assembled = merged;
    cursor = part.nextCursor;
  }
  assert.equal(cursor, null);
  assertBytes(assembled, full);

  // limit 超出尾部：截断到 total，不越界
  const overRead = await store.readRange(ref.sha256, 600, 10000);
  assert.equal(overRead.bytes.length, 400);
  assert.equal(overRead.truncated, false);
  assert.equal(overRead.nextCursor, null);
  assertBytes(overRead.bytes, full.slice(600));

  // 边界：start === total 允许（空区间读完）；start 越界 / 非法参数 → RANGE_INVALID
  const tail = await store.readRange(ref.sha256, 1000, 5);
  assert.equal(tail.bytes.length, 0);
  assert.equal(tail.truncated, false);
  assert.equal(tail.nextCursor, null);
  await expectCode(() => store.readRange(ref.sha256, 1001, 5), 'RANGE_INVALID');
  await expectCode(() => store.readRange(ref.sha256, -1, 5), 'RANGE_INVALID');
  await expectCode(() => store.readRange(ref.sha256, 0, 0), 'RANGE_INVALID');
});

test('refOf returns ref without full read; mediaType/firstObservedAt first-wins', async () => {
  const store = new ArtifactStore(rootDir);
  const bytes = patternBytes(20);
  await store.put(bytes, 'text/plain', '2026-02-01T00:00:00Z');
  await store.put(bytes, 'application/json', '2026-05-01T00:00:00Z');
  const ref = await store.refOf(sha256(bytes));
  assert.equal(ref.bytes, 20);
  assert.equal(ref.mediaType, 'text/plain');
  assert.equal(ref.firstObservedAt, '2026-02-01T00:00:00.000Z'); // 保留首次，UTC ISO
});

test('rootDir resolves from env LYRA_ARTIFACTS_DIR; missing both is a named error', async () => {
  const envDir = await mkdtemp(join(tmpdir(), 'lyra-w2-env-'));
  const previous = process.env.LYRA_ARTIFACTS_DIR;
  process.env.LYRA_ARTIFACTS_DIR = envDir;
  try {
    const store = new ArtifactStore(); // 无参构造走 env
    const bytes = patternBytes(8);
    const ref = await store.put(bytes, 'text/plain', '2026-03-03T00:00:00Z');
    const onDisk = await readFile(join(envDir, ref.sha256.slice(0, 2), ref.sha256));
    assertBytes(onDisk, bytes);
  } finally {
    if (previous === undefined) delete process.env.LYRA_ARTIFACTS_DIR;
    else process.env.LYRA_ARTIFACTS_DIR = previous;
    await rm(envDir, { recursive: true, force: true });
  }
  const saved = process.env.LYRA_ARTIFACTS_DIR;
  delete process.env.LYRA_ARTIFACTS_DIR;
  try {
    assert.throws(() => new ArtifactStore(), (error: unknown) => error instanceof ArtifactError && error.code === 'ARTIFACTS_DIR_MISSING');
  } finally {
    if (saved !== undefined) process.env.LYRA_ARTIFACTS_DIR = saved;
  }
});

test('invalid inputs are named: bad hash, bad time, empty mediaType', async () => {
  const store = new ArtifactStore(rootDir);
  await expectCode(() => store.readBytes('not-a-hash'), 'INVALID_ARTIFACT_HASH');
  await expectCode(() => store.put(patternBytes(4), 'text/plain', 'not-a-date'), 'INVALID_ARTIFACT_INPUT');
  await expectCode(() => store.put(patternBytes(4), '', '2026-03-03T00:00:00Z'), 'INVALID_ARTIFACT_INPUT');
});
