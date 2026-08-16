/**
 * 按 manifest.json 下载 Box 分享目录中的文件。
 *
 * 特性：断点续传（HTTP Range）、并发控制、指数退避重试、
 *       签名直链过期后自动重新换取、大小/SHA1 校验、路径过滤。
 *
 * 用法:
 *   node scripts/download.mjs [-m manifest.json] [-o ./data] [-c 3]
 *                             [--filter <子串>] [--verify-only] [--dry-run]
 */

import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, stat, rename, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { BoxShareClient, UA } from '../src/box-client.mjs';
import { requestStream } from '../src/http-stream.mjs';

// 连续「毫无进展」多少次后放弃这个文件
const MAX_RETRIES = 6;
// 总轮数硬上限，防止病态链路下无限循环
const MAX_ROUNDS = 300;
// 本轮传到多少字节才算「有进展」（有进展就不消耗重试配额）
const MIN_PROGRESS_BYTES = 256 * 1024;
// 等待响应头的上限
const HEADER_TIMEOUT_MS = 60_000;
// 传输过程中多久没收到数据就判定为断流（Node fetch 本身不会超时）
const STALL_TIMEOUT_MS = 90_000;

function parseArgs(argv) {
  const o = {
    manifest: 'manifest.json',
    out: './data',
    concurrency: 3,
    filter: null,
    regex: null,
    exclude: [],
    verifyOnly: false,
    dryRun: false,
    checkSha1: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' || a === '--manifest') o.manifest = argv[++i];
    else if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a === '-c' || a === '--concurrency') o.concurrency = Number(argv[++i]);
    else if (a === '--filter') o.filter = argv[++i];
    else if (a === '--regex') o.regex = new RegExp(argv[++i]);
    else if (a === '--exclude') o.exclude.push(argv[++i]);
    else if (a === '--verify-only') o.verifyOnly = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--check-sha1') o.checkSha1 = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return o;
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

function humanTime(seconds) {
  if (!Number.isFinite(seconds)) return '未知';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fileSize(p) {
  try {
    return (await stat(p)).size;
  } catch {
    return -1;
  }
}

async function sha1OfFile(p) {
  const h = createHash('sha1');
  await pipeline(createReadStream(p), h);
  return h.digest('hex');
}

/**
 * 下载单个文件，支持从已有 .part 续传。
 * 每次重试都重新换取签名直链（直链有效期只有几分钟）。
 */
async function downloadFile(client, file, opts, report) {
  const dest = path.join(opts.out, file.path);
  const part = `${dest}.part`;
  await mkdir(path.dirname(dest), { recursive: true });

  const done = await fileSize(dest);
  if (done === file.size) {
    report('skip', file, `已存在且大小一致 (${humanSize(done)})`);
    return { status: 'skipped', bytes: 0 };
  }
  if (done >= 0 && done !== file.size) {
    report('warn', file, `已存在但大小不符 (本地 ${done} ≠ 清单 ${file.size})，将重新下载`);
  }

  if (opts.dryRun) {
    report('plan', file, `待下载 ${humanSize(file.size)}`);
    return { status: 'planned', bytes: 0 };
  }

  let attempt = 0;
  let rounds = 0;
  let bytesThisRun = 0;

  while (attempt <= MAX_RETRIES && rounds < MAX_ROUNDS) {
    rounds++;
    const offset = Math.max(0, await fileSize(part));
    if (offset === file.size) break; // .part 已完整
    if (offset > file.size) {
      report('warn', file, `.part 超出预期大小，丢弃重下`);
      attempt++;
      try {
        await rename(part, `${part}.bad`);
      } catch (err) {
        report('fail', file, `无法丢弃异常的 .part 文件: ${err.message}`);
        return { status: 'failed', bytes: bytesThisRun, error: 'stale part file' };
      }
      continue;
    }

    // 提到 try 外面：catch 里要根据本轮实际传了多少来决定是否消耗重试次数
    let received = 0;

    try {
      const url = await client.resolveDownloadUrl(file.id);
      const headers = { 'User-Agent': UA, Cookie: client.cookieHeader() };
      if (offset > 0) headers.Range = `bytes=${offset}-`;

      // 大文件不能用整体超时，改为：响应头超时 + 传输停滞超时。
      // 断流时直接 destroy 流，pipeline 抛错后进入重试分支，从断点继续。
      let stallTimer = null;
      let stallReason = null;
      let body = null;
      const armStallTimer = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stallReason = `传输停滞超过 ${STALL_TIMEOUT_MS / 1000}s`;
          body?.destroy(new Error(stallReason));
        }, STALL_TIMEOUT_MS);
      };

      try {
        const res = await requestStream(url, { headers, headerTimeoutMs: HEADER_TIMEOUT_MS });
        body = res.stream;
        armStallTimer();

        if (offset > 0 && res.statusCode !== 206) {
          body.destroy();
          // 服务端不认 Range（或直链已换），从头重来
          if (res.statusCode === 200) {
            report('warn', file, `服务端未接受 Range，从头下载`);
            attempt++;
            try {
              await rename(part, `${part}.bad`);
            } catch (err) {
              report('fail', file, `无法丢弃 .part 文件: ${err.message}`);
              return { status: 'failed', bytes: bytesThisRun, error: 'stale part file' };
            }
            continue;
          }
          throw new Error(`续传失败: HTTP ${res.statusCode}`);
        }
        if (res.statusCode >= 400) {
          body.destroy();
          throw new Error(`HTTP ${res.statusCode}`);
        }

        const startedAt = Date.now();
        let lastLog = startedAt;

        // 计数放在 pipeline 中间的 Transform 里，而不是 stream.on('data')。
        // 监听 'data' 会把流切到 flowing 模式，与 pipeline 的背压控制打架。
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            received += chunk.length;
            armStallTimer();
            const now = Date.now();
            if (now - lastLog > 5000) {
              lastLog = now;
              const total = offset + received;
              const pct = ((total / file.size) * 100).toFixed(1);
              const speed = received / ((now - startedAt) / 1000);
              const eta = speed > 0 ? (file.size - total) / speed : Infinity;
              report(
                'progress',
                file,
                `${pct}%  ${humanSize(total)}/${humanSize(file.size)}  ` +
                  `${humanSize(speed)}/s  剩余 ${humanTime(eta)}`
              );
            }
            cb(null, chunk);
          },
        });

        await pipeline(body, meter, createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }));

        const nowSize = await fileSize(part);
        if (nowSize < file.size) {
          throw new Error(`连接提前结束 (${humanSize(nowSize)}/${humanSize(file.size)})`);
        }
      } catch (err) {
        throw stallReason ? new Error(stallReason) : err;
      } finally {
        clearTimeout(stallTimer);
        // 无论成功失败，本轮写进 .part 的字节都只在这里累计一次
        bytesThisRun += received;
      }
      break;
    } catch (err) {
      // 弱网/不稳定代理下连接会频繁断开。只要本轮拿到了实质数据，
      // 就说明在推进，不该消耗重试配额——否则大文件永远下不完。
      if (received >= MIN_PROGRESS_BYTES) {
        attempt = 0;
        report(
          'retry',
          file,
          `${err.message}（本轮 +${humanSize(received)}，有进展，不计入重试）；3s 后继续`
        );
        await sleep(3000);
        continue;
      }

      attempt++;
      if (attempt > MAX_RETRIES) {
        report('fail', file, `连续 ${MAX_RETRIES} 次无进展后放弃: ${err.message}`);
        return { status: 'failed', bytes: bytesThisRun, error: err.message };
      }
      const wait = Math.min(60_000, 2 ** attempt * 1000);
      report('retry', file, `${err.message}；${wait / 1000}s 后第 ${attempt} 次重试`);
      await sleep(wait);
    }
  }

  if (rounds >= MAX_ROUNDS) {
    report('fail', file, `断连过于频繁（已尝试 ${MAX_ROUNDS} 轮），放弃`);
    return { status: 'failed', bytes: bytesThisRun, error: 'too many rounds' };
  }

  const finalSize = await fileSize(part);
  if (finalSize !== file.size) {
    report('fail', file, `大小校验不通过: ${finalSize} ≠ ${file.size}`);
    return { status: 'failed', bytes: bytesThisRun, error: 'size mismatch' };
  }

  if (opts.checkSha1 && file.sha1) {
    const digest = await sha1OfFile(part);
    if (digest !== file.sha1) {
      report('fail', file, `SHA1 校验不通过: ${digest} ≠ ${file.sha1}`);
      return { status: 'failed', bytes: bytesThisRun, error: 'sha1 mismatch' };
    }
  }

  await rename(part, dest);
  report('ok', file, `完成 ${humanSize(file.size)}`);
  return { status: 'downloaded', bytes: bytesThisRun };
}

/** 只校验本地已有文件，不发起下载。 */
async function verifyFile(file, opts, report) {
  const dest = path.join(opts.out, file.path);
  const size = await fileSize(dest);
  if (size < 0) {
    report('fail', file, '缺失');
    return { status: 'missing' };
  }
  if (size !== file.size) {
    report('fail', file, `大小不符: 本地 ${size} ≠ 清单 ${file.size}`);
    return { status: 'bad-size' };
  }
  if (opts.checkSha1 && file.sha1) {
    const digest = await sha1OfFile(dest);
    if (digest !== file.sha1) {
      report('fail', file, `SHA1 不符: ${digest} ≠ ${file.sha1}`);
      return { status: 'bad-sha1' };
    }
  }
  report('ok', file, `校验通过 (${humanSize(size)})`);
  return { status: 'ok' };
}

/** 简单的固定并发工作池。 */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---- 主流程 ----

const opts = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));

let files = manifest.files;
if (opts.filter) files = files.filter((f) => f.path.includes(opts.filter));
if (opts.regex) files = files.filter((f) => opts.regex.test(f.path));
for (const ex of opts.exclude) files = files.filter((f) => !f.path.includes(ex));
if (files.length === 0) {
  console.error('没有匹配的文件，检查 --filter / --regex / --exclude 条件');
  process.exit(1);
}

const selectors = [
  opts.filter && `filter="${opts.filter}"`,
  opts.regex && `regex=${opts.regex}`,
  ...opts.exclude.map((e) => `exclude="${e}"`),
].filter(Boolean);

// 清单里的 path 由远端目录名拼成（crawl.mjs），带 `..` 就能让 path.join 写到
// 输出目录外面去。开源后 shareUrl 是任意可传的，所以下手之前先整体校验一遍。
const outRoot = path.resolve(opts.out);
const unsafe = files.filter((f) => {
  const dest = path.resolve(outRoot, f.path);
  return dest !== outRoot && !dest.startsWith(outRoot + path.sep);
});
if (unsafe.length) {
  console.error(`清单中有 ${unsafe.length} 个路径会越出输出目录 ${outRoot}，已中止：`);
  for (const f of unsafe.slice(0, 10)) console.error(`  - ${f.path}`);
  process.exit(1);
}

const totalBytes = files.reduce((s, f) => s + f.size, 0);
console.error(
  `目标: ${files.length} 个文件 / ${humanSize(totalBytes)}` +
    (selectors.length ? `（${selectors.join(', ')}）` : '') +
    `\n输出: ${path.resolve(opts.out)}\n并发: ${opts.concurrency}\n`
);

const tag = {
  ok: '✅',
  skip: '⏭️ ',
  fail: '❌',
  retry: '🔁',
  warn: '⚠️ ',
  progress: '   ',
  plan: '📋',
};
const report = (kind, file, msg) => {
  console.error(`${tag[kind] ?? '  '} ${file.path}  ${msg}`);
};

let client = null;
if (!opts.verifyOnly && !opts.dryRun) {
  client = await new BoxShareClient(manifest.shareUrl).init();
}

const results = await runPool(files, opts.concurrency, (f) =>
  opts.verifyOnly ? verifyFile(f, opts, report) : downloadFile(client, f, opts, report)
);

const counts = results.reduce((m, r) => {
  m[r.status] = (m[r.status] ?? 0) + 1;
  return m;
}, {});
console.error(
  `\n===== 汇总 =====\n` +
    Object.entries(counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
);

const failed = files.filter((_, i) => ['failed', 'missing', 'bad-size', 'bad-sha1'].includes(results[i].status));
if (failed.length) {
  console.error(`\n失败清单（重跑同一命令即可续传）:`);
  for (const f of failed) console.error(`  - ${f.path}`);
  process.exit(1);
}
console.error('\n全部完成。');
