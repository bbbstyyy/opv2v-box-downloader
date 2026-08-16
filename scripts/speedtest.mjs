/**
 * 测速辅助脚本：对比单连接与多连接分段下载的吞吐。
 *
 * Box 的 public.boxcloud.com 支持 Range，如果限速是"每连接"而不是"每账号/每 IP"，
 * 那么分段并发能成倍提速。这个脚本用来验证这一点，不参与生产下载。
 *
 * 走 src/http-stream.mjs（原生 http/https），和生产下载器同一条路径——
 * 早期版本用内置 fetch 测过，因为 undici 的代理实现有问题，结论是错的。
 *
 * 用法: node scripts/speedtest.mjs [--file <文件名子串>] [--seconds 20]
 */

import { readFile } from 'node:fs/promises';
import { BoxShareClient, UA } from '../src/box-client.mjs';
import { requestStream } from '../src/http-stream.mjs';

function parseArgs(argv) {
  const o = { file: null, seconds: 20, lanes: [1, 4, 8] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') o.file = argv[++i];
    else if (argv[i] === '--seconds') o.seconds = Number(argv[++i]);
    else if (argv[i] === '--lanes') o.lanes = argv[++i].split(',').map(Number);
  }
  return o;
}

const humanSpeed = (bps) =>
  bps > 1024 * 1024 ? `${(bps / 1024 / 1024).toFixed(2)} MB/s` : `${(bps / 1024).toFixed(1)} KB/s`;

const opts = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));

const file = opts.file
  ? manifest.files.find((f) => f.path.includes(opts.file))
  : manifest.files.filter((f) => f.size > 100 * 1024 * 1024)[0];
if (!file) throw new Error('未找到合适的测试文件');

console.error(`测试文件: ${file.path} (${(file.size / 1024 ** 3).toFixed(2)} GB)`);
console.error(`每档测 ${opts.seconds}s\n`);

const client = await new BoxShareClient(manifest.shareUrl).init();

/**
 * 开 n 条连接，每条从文件的不同位置拉数据，统计 seconds 秒内的总字节数。
 * 起点分散开，避免命中同一段缓存导致结果偏乐观。
 */
async function measure(lanes, seconds) {
  let total = 0;
  const streams = [];
  const chunkSpan = Math.floor(file.size / (lanes + 1));
  const startedAt = Date.now();

  const stopper = setTimeout(() => {
    for (const s of streams) s.destroy();
  }, seconds * 1000);

  const tasks = Array.from({ length: lanes }, async (_, i) => {
    const start = chunkSpan * i;
    const url = await client.resolveDownloadUrl(file.id);
    const res = await requestStream(url, {
      headers: {
        'User-Agent': UA,
        Cookie: client.cookieHeader(),
        Range: `bytes=${start}-`,
      },
    });
    if (res.statusCode !== 206) {
      res.stream.destroy();
      throw new Error(`连接 ${i} 未返回 206（实际 ${res.statusCode}），服务端可能不支持分段`);
    }
    streams.push(res.stream);
    await new Promise((resolve, reject) => {
      res.stream.on('data', (c) => (total += c.length));
      res.stream.on('end', resolve);
      res.stream.on('close', resolve);
      res.stream.on('error', (err) =>
        // 到点主动 destroy 造成的报错不算失败
        /premature close|aborted|destroy/i.test(err.message) ? resolve() : reject(err)
      );
    });
  });

  const settled = await Promise.allSettled(tasks);
  clearTimeout(stopper);
  for (const s of streams) s.destroy();
  const elapsed = (Date.now() - startedAt) / 1000;

  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) throw failed.reason;

  return { bps: total / elapsed, total, elapsed };
}

const results = [];
for (const lanes of opts.lanes) {
  const r = await measure(lanes, opts.seconds);
  results.push({ lanes, ...r });
  console.error(
    `${String(lanes).padStart(2)} 连接: ${humanSpeed(r.bps).padStart(11)}  ` +
      `(${(r.total / 1024 / 1024).toFixed(1)} MB / ${r.elapsed.toFixed(1)}s)`
  );
}

const base = results[0].bps;
console.error('\n相对单连接的加速比:');
for (const r of results) {
  console.error(`  ${String(r.lanes).padStart(2)} 连接: ${(r.bps / base).toFixed(2)}x`);
}
