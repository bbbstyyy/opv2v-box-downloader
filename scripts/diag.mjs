/**
 * 诊断脚本：同一条直链，用不同客户端/不同方式各拉一段，对比吞吐。
 *
 * 目的是回答"为什么脚本比浏览器慢"——是链路问题，还是 Node 这边的问题。
 *
 * 用法: node scripts/diag.mjs [--file <文件名子串>] [--mb 40]
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { BoxShareClient, UA } from '../src/box-client.mjs';

function parseArgs(argv) {
  const o = { file: 'train_chunks-20240808T030344Z-002.zip', mb: 40 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') o.file = argv[++i];
    else if (argv[i] === '--mb') o.mb = Number(argv[++i]);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const BYTES = opts.mb * 1024 * 1024;
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

const speed = (bytes, ms) => `${(bytes / 1024 / 1024 / (ms / 1000)).toFixed(2)} MB/s`;

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const file = manifest.files.find((f) => f.path.includes(opts.file));
if (!file) throw new Error(`清单里找不到 ${opts.file}`);

console.error(`测试文件: ${file.path}`);
console.error(`每项拉取: ${opts.mb} MB    代理: ${PROXY ?? '(无)'}\n`);

const client = await new BoxShareClient(manifest.shareUrl).init();

/** 每项测试都用新鲜直链，避免签名过期干扰结果。 */
async function freshUrl() {
  return client.resolveDownloadUrl(file.id);
}

const results = [];
const record = (name, bytes, ms) => {
  results.push({ name, speed: bytes / (ms / 1000) });
  console.error(`  ${name.padEnd(42)} ${speed(bytes, ms).padStart(11)}`);
};

/** 单项失败不该中断整轮对比——失败本身也是结果。 */
async function probe(name, fn) {
  const t0 = Date.now();
  try {
    const bytes = await fn();
    record(name, bytes, Date.now() - t0);
  } catch (err) {
    const cause = err.cause?.code ?? err.cause?.message ?? '';
    console.error(`  ${name.padEnd(42)} ❌ ${err.message} ${cause}`);
    results.push({ name, speed: 0, error: err.message });
  }
}

// ── 1. curl 走代理（对照组：非 Node 客户端，默认 HTTP/1.1）
await probe('curl（走代理，HTTP/1.1）', async () => {
  const url = await freshUrl();
  const args = ['-s', '-o', '/dev/null', '-A', UA, '-r', `0-${BYTES - 1}`];
  if (PROXY) args.push('-x', PROXY);
  args.push(url);
  await new Promise((res, rej) => {
    const p = spawn('curl', args);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`curl exit ${c}`))));
  });
  return BYTES;
});

// ── 1b. curl 强制 HTTP/2（验证 h2 是不是慢的元凶）
await probe('curl --http2（走代理）', async () => {
  const url = await freshUrl();
  const args = ['-s', '-o', '/dev/null', '--http2', '-A', UA, '-r', `0-${BYTES - 1}`];
  if (PROXY) args.push('-x', PROXY);
  args.push(url);
  await new Promise((res, rej) => {
    const p = spawn('curl', args);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`curl exit ${c}`))));
  });
  return BYTES;
});

// ── 2. Node fetch + fromWeb + Transform + 写盘（=生产下载器的完整链路）
await probe('node fetch → fromWeb → Transform → 盘', async () => {
  const url = await freshUrl();
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Cookie: client.cookieHeader(), Range: `bytes=0-${BYTES - 1}` },
    redirect: 'follow',
  });
  let got = 0;
  const meter = new Transform({
    transform(c, _e, cb) {
      got += c.length;
      cb(null, c);
    },
  });
  await pipeline(Readable.fromWeb(res.body), meter, createWriteStream('/dev/null'));
  return got;
});

// ── 3. Node fetch，直接消费 web stream（排除 fromWeb / Transform 的开销）
await probe('node fetch → 裸读 web stream（不落盘）', async () => {
  const url = await freshUrl();
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Cookie: client.cookieHeader(), Range: `bytes=0-${BYTES - 1}` },
    redirect: 'follow',
  });
  let got = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
  }
  return got;
});

// ── 4. Node 原生 http/https 模块（绕开 undici，走代理 CONNECT 隧道，天然 HTTP/1.1）
if (PROXY) {
  await probe('node 原生 https（绕开 undici，h1）', async () => {
    const url = await freshUrl();
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const px = new URL(PROXY);
      // 代理本身是明文 HTTP，必须用 http.request 发 CONNECT（不是 https.request）
      const req = http.request({
        host: px.hostname,
        port: px.port || 80,
        method: 'CONNECT',
        path: `${target.hostname}:443`,
        agent: false,
      });
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          reject(new Error(`代理 CONNECT 返回 ${res.statusCode}`));
          socket.destroy();
          return;
        }
        const r = https.request(
          {
            method: 'GET',
            path: target.pathname + target.search,
            headers: {
              Host: target.hostname,
              'User-Agent': UA,
              Range: `bytes=0-${BYTES - 1}`,
            },
            socket,
            agent: false,
            servername: target.hostname,
          },
          (r2) => {
            let n = 0;
            r2.on('data', (c) => (n += c.length));
            r2.on('end', () => resolve(n));
            r2.on('error', reject);
          }
        );
        r.on('error', reject);
        r.end();
      });
      req.on('error', reject);
      req.end();
    });
  });
}

const ok = results.filter((r) => r.speed > 0);
if (ok.length > 1) {
  console.error('\n相对最慢项的倍数:');
  const min = Math.min(...ok.map((r) => r.speed));
  for (const r of ok) {
    console.error(`  ${r.name.padEnd(42)} ${(r.speed / min).toFixed(2)}x`);
  }
}
