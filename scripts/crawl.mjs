/**
 * 递归遍历 Box 分享目录，产出 manifest.json（完整文件清单）。
 *
 * 目录数量多、Box 会限流，因此采用显式队列 + 定期存盘：
 * 中断后加 --resume 可从 crawl-state.json 继续，不用整棵树重来。
 *
 * 用法:
 *   node scripts/crawl.mjs [shareUrl] [-o manifest.json] [--delay 250]
 *                          [--resume] [--state crawl-state.json]
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { BoxShareClient } from '../src/box-client.mjs';

const DEFAULT_SHARE_URL =
  'https://ucla.app.box.com/v/UCLA-MobilityLab-OPV2V/folder/279976559690';

function parseArgs(argv) {
  const out = {
    shareUrl: DEFAULT_SHARE_URL,
    output: 'manifest.json',
    state: 'crawl-state.json',
    delay: 250,
    resume: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') out.output = argv[++i];
    else if (a === '--state') out.state = argv[++i];
    else if (a === '--delay') out.delay = Number(argv[++i]);
    else if (a === '--resume') out.resume = true;
    else rest.push(a);
  }
  if (rest[0]) out.shareUrl = rest[0];
  return out;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const opts = parseArgs(process.argv.slice(2));

console.error(`→ 初始化会话: ${opts.shareUrl}`);
const client = await new BoxShareClient(opts.shareUrl).init();
console.error(
  `  vanityName=${client.vanityName} sharedName=${client.sharedName} rootFolder=${client.rootFolderId}\n`
);

// 状态：待访问队列 + 已访问集合 + 已收集的文件/目录
let state = {
  queue: [{ id: client.rootFolderId, path: '' }],
  visited: [],
  files: [],
  folders: [],
};

if (opts.resume && existsSync(opts.state)) {
  state = JSON.parse(readFileSync(opts.state, 'utf8'));
  console.error(
    `↩︎ 从 ${opts.state} 续爬：已访问 ${state.visited.length} 目录，` +
      `已收集 ${state.files.length} 文件，队列剩 ${state.queue.length}\n`
  );
}

const visited = new Set(state.visited);

function saveState() {
  state.visited = [...visited];
  writeFileSync(opts.state, JSON.stringify(state));
}

let processed = 0;
const MAX_FOLDER_FAILURES = 3;
const permanentFailures = [];

while (state.queue.length > 0) {
  const job = state.queue.shift();
  const { id, path: relPath } = job;
  if (visited.has(String(id))) continue;

  let result;
  try {
    result = await client.listFolder(id);
  } catch (err) {
    const failures = (job.failures ?? 0) + 1;
    console.error(`❌ ${relPath || '/'} (${id}) 第 ${failures} 次失败: ${err.message}`);
    if (failures >= MAX_FOLDER_FAILURES) {
      permanentFailures.push({ id, path: relPath, error: err.message });
      visited.add(String(id)); // 不再重试，但记录下来供人工排查
    } else {
      // 放回队尾，等限流缓过来再试
      state.queue.push({ ...job, failures });
    }
    saveState();
    await sleep(opts.delay * 4);
    continue;
  }

  visited.add(String(id));
  const { items, pageCount } = result;
  const subFolders = items.filter((i) => i.type === 'folder');
  const files = items.filter((i) => i.type !== 'folder');
  const bytes = files.reduce((s, f) => s + (f.size ?? f.itemSize ?? 0), 0);

  for (const item of files) {
    state.files.push({
      id: String(item.id),
      name: item.name,
      path: relPath ? `${relPath}/${item.name}` : item.name,
      size: item.size ?? item.itemSize ?? 0,
      sha1: item.sha1 ?? null,
      contentUpdated: item.contentUpdated ?? null,
    });
  }

  for (const item of subFolders) {
    const childPath = relPath ? `${relPath}/${item.name}` : item.name;
    state.folders.push(childPath);
    state.queue.push({ id: String(item.id), path: childPath });
  }

  processed++;
  console.error(
    `[${processed}] ${relPath || '/'}  —  ${files.length} 文件 (${humanSize(bytes)}), ` +
      `${subFolders.length} 子目录${pageCount > 1 ? `, ${pageCount} 页` : ''}` +
      `  | 队列剩 ${state.queue.length}`
  );

  if (processed % 20 === 0) saveState();
  if (opts.delay > 0) await sleep(opts.delay);
}

saveState();

const totalBytes = state.files.reduce((s, f) => s + f.size, 0);
const manifest = {
  shareUrl: opts.shareUrl,
  vanityName: client.vanityName,
  sharedName: client.sharedName,
  rootFolderId: client.rootFolderId,
  crawledAt: new Date().toISOString(),
  totalFiles: state.files.length,
  totalBytes,
  folders: state.folders,
  files: state.files,
};

writeFileSync(opts.output, JSON.stringify(manifest, null, 2));
console.error(
  `\n✅ 共 ${state.files.length} 个文件 / ${state.folders.length} 个目录，` +
    `合计 ${humanSize(totalBytes)}\n   清单已写入 ${opts.output}`
);

if (permanentFailures.length) {
  console.error(`\n⚠️  有 ${permanentFailures.length} 个目录始终无法列举，清单可能不完整：`);
  for (const f of permanentFailures) console.error(`   - ${f.path} (${f.id}): ${f.error}`);
  console.error(`   可稍后用 --resume 重跑，或人工核对这些目录。`);
  process.exit(1);
}
