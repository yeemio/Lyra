import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactRef } from '../contracts.js';

/** 原件库具名错误（POINT-IN-TIME §9）。code 为稳定错误名，不携带实现细节。 */
export class ArtifactError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'ArtifactError';
  }
}

/** 区间读结果（POINT-IN-TIME §9 第 4 条）。nextCursor 为下一读取起点；读完为 null。 */
export interface ArtifactRange {
  bytes: Uint8Array;
  deliveredHash: string;
  total: number;
  truncated: boolean;
  nextCursor: number | null;
}

const HASH_RE = /^[a-f0-9]{64}$/;

interface MetaContent {
  sha256: string;
  mediaType: string;
  firstObservedAt: string;
}

function parseIso(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ArtifactError('INVALID_ARTIFACT_INPUT', field);
  return d;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

/**
 * 原件库（CAS，POINT-IN-TIME §9 六条款）：
 * 1. sha256 为唯一身份，目录按哈希前 2 位分片，无语义命名主存储路径；
 * 2. 写入即校验（临时文件 → fsync → 链接落位 → 立即按哈希读回校验），同哈希幂等、保留首次 firstObservedAt；
 * 3. 哈希校验读（每次重算比对，不符 HASH_MISMATCH；符号链接路径拒绝）；
 * 4. 字节区间读（与全量读切片逐字节一致）；
 * 5. 不可变：无更新/覆盖/删除 API（隐私清除通道首版不做，也不提供任意删除）；
 * 6. 隐私级：根目录 0700、文件 0600。
 * rootDir 未传时取 env LYRA_ARTIFACTS_DIR；两者皆缺省抛 ARTIFACTS_DIR_MISSING。
 * 元数据（mediaType/firstObservedAt，非内容身份的一部分）以哈希命名的 dot 侧车文件存于分片目录，
 * 只在首次写入时落盘（wx，先到先得），不构成第二份内容。
 */
export class ArtifactStore {
  private readonly root: string;
  private ready: Promise<void> | undefined;
  private realRoot: string | undefined;

  constructor(rootDir?: string) {
    const root = rootDir ?? process.env.LYRA_ARTIFACTS_DIR;
    if (root === undefined || root.length === 0) {
      throw new ArtifactError('ARTIFACTS_DIR_MISSING', 'no rootDir argument and LYRA_ARTIFACTS_DIR unset');
    }
    this.root = root;
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await chmod(this.root, 0o700); // 防 umask 放宽；合同要求根目录 0700
      // 记录规范化根路径为基准：父链上的 OS 级符号链接（如 macOS /var）不算违约；
      // 根自身中途被替换成符号链接才触发 PATH_DENIED。内容路径由 lstat/O_NOFOLLOW 把关。
      this.realRoot = await realpath(this.root);
    })();
    return this.ready;
  }

  private async directory(hash: string, create = false): Promise<string> {
    if (!HASH_RE.test(hash)) throw new ArtifactError('INVALID_ARTIFACT_HASH', hash);
    if (this.realRoot === undefined) await this.init();
    if ((await realpath(this.root)) !== this.realRoot) throw new ArtifactError('PATH_DENIED', this.root);
    const dir = join(this.root, hash.slice(0, 2));
    if (create) {
      try {
        await mkdir(dir, { mode: 0o700 });
        await this.fsyncDir(this.root);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
      }
    }
    let stat;
    try {
      stat = await lstat(dir);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) throw new ArtifactError('ARTIFACT_MISSING', hash);
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArtifactError('PATH_DENIED', dir);
    return dir;
  }

  private async fsyncDir(path: string): Promise<void> {
    const fd = await open(path, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  }

  private async readMeta(dir: string, hash: string): Promise<MetaContent | null> {
    const metaPath = join(dir, `.${hash}.meta.json`);
    let fd;
    try {
      fd = await open(metaPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error; // ELOOP（符号链接）等按原样抛出
    }
    try {
      const raw = await fd.readFile();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new ArtifactError('ARTIFACT_META_CORRUPT', metaPath);
      }
      const meta = parsed as Partial<MetaContent>;
      if (
        typeof meta !== 'object' ||
        meta === null ||
        typeof meta.sha256 !== 'string' ||
        typeof meta.mediaType !== 'string' ||
        typeof meta.firstObservedAt !== 'string'
      ) {
        throw new ArtifactError('ARTIFACT_META_CORRUPT', metaPath);
      }
      return meta as MetaContent;
    } finally {
      await fd.close();
    }
  }

  /** 元数据先到先得：同哈希重复 put 保留首次 firstObservedAt（POINT-IN-TIME §9 第 2 条）。 */
  private async ensureMeta(dir: string, hash: string, mediaType: string, firstObservedAt: string): Promise<MetaContent> {
    const metaPath = join(dir, `.${hash}.meta.json`);
    const fd = await open(metaPath, 'wx', 0o600).catch((error: unknown) => {
      if (isErrno(error, 'EEXIST')) return null;
      throw error;
    });
    if (fd !== null) {
      try {
        await fd.writeFile(JSON.stringify({ sha256: hash, mediaType, firstObservedAt }));
        await fd.sync();
      } finally {
        await fd.close();
      }
      await this.fsyncDir(dir);
    }
    const meta = await this.readMeta(dir, hash);
    if (meta === null || meta.sha256 !== hash) throw new ArtifactError('ARTIFACT_META_CORRUPT', metaPath);
    return meta;
  }

  private async statContent(hash: string): Promise<{ dir: string; size: number }> {
    const dir = await this.directory(hash);
    const target = join(dir, hash);
    const stat = await lstat(target).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) throw new ArtifactError('ARTIFACT_MISSING', hash);
      throw error;
    });
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ArtifactError('PATH_DENIED', target);
    return { dir, size: stat.size };
  }

  /** 写入原件并返回 ArtifactRef。同哈希重复 put 幂等：不产生第二份内容，保留首次观察元数据。 */
  async put(bytes: Uint8Array, mediaType: string, firstObservedAt: string): Promise<ArtifactRef> {
    if (mediaType.length === 0) throw new ArtifactError('INVALID_ARTIFACT_INPUT', 'mediaType empty');
    const observed = parseIso(firstObservedAt, 'firstObservedAt').toISOString();
    await this.init();
    const hash = createHash('sha256').update(bytes).digest('hex');
    const dir = await this.directory(hash, true);
    const target = join(dir, hash);
    const existing = await lstat(target).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    });
    if (existing === null) {
      // 写入即校验：临时文件 → fsync → 以目标名落位 → 立即按哈希读回校验一致才算成功
      const temporary = join(dir, `.${randomUUID()}.tmp`);
      const fd = await open(temporary, 'wx', 0o600);
      try {
        await fd.writeFile(bytes);
        await fd.sync();
      } finally {
        await fd.close();
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error; // 并发同哈希写入：以已落位内容为准
      }
      await unlink(temporary).catch((error: unknown) => {
        if (!isErrno(error, 'ENOENT')) throw error;
      });
    } else if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new ArtifactError('PATH_DENIED', target);
    }
    await this.readBytes(hash); // 校验失败即 put 失败
    const stored = await this.ensureMeta(dir, hash, mediaType, observed);
    const { size } = await this.statContent(hash);
    return { sha256: hash, bytes: size, mediaType: stored.mediaType, firstObservedAt: stored.firstObservedAt };
  }

  /** 哈希校验读：每次重算 sha256 与目标比对，不符抛 HASH_MISMATCH，不返回可疑内容。 */
  async readBytes(hash: string): Promise<Uint8Array> {
    await this.init();
    const dir = await this.directory(hash);
    let fd;
    try {
      fd = await open(join(dir, hash), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) throw new ArtifactError('ARTIFACT_MISSING', hash);
      if (isErrno(error, 'ELOOP')) throw new ArtifactError('PATH_DENIED', join(dir, hash));
      throw error;
    }
    try {
      const stat = await fd.stat();
      if (!stat.isFile()) throw new ArtifactError('PATH_DENIED', join(dir, hash));
      const bytes = await fd.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== hash) {
        throw new ArtifactError('HASH_MISMATCH', hash);
      }
      return bytes;
    } finally {
      await fd.close();
    }
  }

  /** 字节区间读：返回区间字节（拷贝）、区间哈希、total、truncated 与 nextCursor。 */
  async readRange(hash: string, start: number, limit: number): Promise<ArtifactRange> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(limit) || start < 0 || limit < 1) {
      throw new ArtifactError('RANGE_INVALID', `start=${start} limit=${limit}`);
    }
    const all = await this.readBytes(hash);
    if (start > all.length) throw new ArtifactError('RANGE_INVALID', `start ${start} beyond total ${all.length}`);
    const part = all.slice(start, start + limit);
    const end = start + part.length;
    return {
      bytes: part,
      deliveredHash: createHash('sha256').update(part).digest('hex'),
      total: all.length,
      truncated: end < all.length,
      nextCursor: end < all.length ? end : null,
    };
  }

  /** 读取 ArtifactRef（不经全量内容读；bytes 取自文件 stat，元数据取自先到先得侧车）。 */
  async refOf(hash: string): Promise<ArtifactRef> {
    await this.init();
    const { size } = await this.statContent(hash);
    const meta = await this.readMeta(join(this.root, hash.slice(0, 2)), hash);
    if (meta === null) throw new ArtifactError('ARTIFACT_META_MISSING', hash);
    return { sha256: hash, bytes: size, mediaType: meta.mediaType, firstObservedAt: meta.firstObservedAt };
  }
}
