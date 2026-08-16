/**
 * 逆向辅助脚本（一次性使用，不参与生产下载流程）。
 *
 * 用 headless 浏览器打开某个子目录页面，抓取真实发出的 app-api 请求，
 * 用来搞清楚"列举子目录"到底带了哪些参数。
 *
 * 用法: NODE_USE_ENV_PROXY=1 node scripts/sniff.mjs [folderUrl]
 */

import { chromium } from 'playwright';

const url =
  process.argv[2] ||
  'https://ucla.app.box.com/v/UCLA-MobilityLab-OPV2V/folder/280322713666';

const proxyServer =
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;

const browser = await chromium.launch({
  headless: true,
  proxy: proxyServer ? { server: proxyServer } : undefined,
});
const page = await browser.newPage();

const captured = [];
page.on('request', (req) => {
  const u = req.url();
  if (!/app-api|\/index\.php|api\.box\.com|box_download/.test(u)) return;
  captured.push({
    method: req.method(),
    url: u,
    headers: req.headers(),
    body: req.postData(),
  });
});

console.error(`→ 打开 ${url}`);
await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 });
// 等前端把目录内容渲染出来
await page.waitForTimeout(5000);

console.error(`\n捕获到 ${captured.length} 条相关请求：\n`);
for (const r of captured) {
  console.error(`── ${r.method} ${r.url}`);
  const interesting = Object.entries(r.headers).filter(([k]) =>
    /token|box|shared|referer|content-type/i.test(k)
  );
  for (const [k, v] of interesting) console.error(`     ${k}: ${v.slice(0, 160)}`);
  if (r.body) console.error(`     body: ${r.body.slice(0, 500)}`);
  console.error('');
}

await browser.close();
