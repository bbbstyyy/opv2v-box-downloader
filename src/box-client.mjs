/**
 * Box 公开分享链接（游客态）客户端。
 *
 * 逆向结论：
 *  1. 分享页 HTML 内嵌 sharedName，无需登录即可取得。
 *  2. 列目录：GET /v/<vanityName>/folder/<folderId>，目录内容由服务端直出在
 *     HTML 的 Box.postStreamData['/app-api/enduserapp/shared-folder'] 中
 *     （含 items / pageCount / currentFolderID）。
 *     注意：/app-api/enduserapp/shared-folder?folder_id=… 这个 XHR 接口会
 *     忽略 folder_id，永远返回分享根目录，不能用来遍历子目录。
 *  3. 下载：GET /index.php?rm=box_download_shared_file&shared_name=&file_id=f_<id>
 *     返回 302，Location 指向 public.boxcloud.com 的短时效签名 URL。
 *
 * 所有请求都走 src/http-stream.mjs（Node 原生 http/https），不用内置 fetch——
 * undici 在走 HTTP 代理时会频繁断连且吞吐只有 1/4，详见该文件头部说明。
 * 代理直接读 HTTPS_PROXY/HTTP_PROXY，与 curl 的约定一致，不需要 NODE_USE_ENV_PROXY。
 */

import { requestStream, requestText } from './http-stream.mjs';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 页面/接口请求的超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 指数退避重试。网络抖动、代理繁忙、Box 限流都靠它兜底。 */
async function withRetry(fn, { retries = 4, label = '操作' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(30_000, 2 ** attempt * 1000));
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${label}失败（已重试 ${retries} 次）: ${lastErr.message}`);
}

/**
 * 从 `Box.xxx = {...}` 这类内联赋值中截出完整的 JSON 对象。
 * 需要感知字符串与转义，否则名字里带花括号的条目会把括号配对算错。
 */
function extractJsonObject(html, assignmentRe) {
  const m = html.match(assignmentRe);
  if (!m) return null;
  const start = html.indexOf('{', m.index);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let quote = null;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 极简 cookie jar：Box 只需要按名字回传最新值。 */
class CookieJar {
  constructor() {
    this.jar = new Map();
  }

  /** @param {object} headers Node 响应头对象（set-cookie 是字符串数组） */
  absorb(headers) {
    const raw = headers['set-cookie'] ?? [];
    for (const line of Array.isArray(raw) ? raw : [raw]) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      // 服务端用空值 + 过期时间来删除 cookie
      if (!value || /expires=Thu, 01 Jan 1970/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export class BoxShareClient {
  /**
   * @param {string} shareUrl 形如 https://<host>.app.box.com/v/<vanityName>[/folder/<id>]
   */
  constructor(shareUrl) {
    const u = new URL(shareUrl);
    this.origin = u.origin;
    this.shareUrl = shareUrl;

    const vanity = u.pathname.match(/\/v\/([^/]+)/);
    if (!vanity) throw new Error(`分享链接格式无法识别（缺少 /v/<name>）: ${shareUrl}`);
    this.vanityName = vanity[1];

    this.jar = new CookieJar();
    this.sharedName = null;
    this.rootFolderId = null;
  }

  /** 拉取分享页，提取 sharedName / 根目录 ID，并建立会话 cookie。 */
  async init() {
    const html = await withRetry(() => this.#getHtml(this.shareUrl), {
      label: '打开分享页',
    });

    const sn = html.match(/"sharedName"\s*:\s*"([A-Za-z0-9]+)"/);
    if (!sn) throw new Error('未能从分享页解析出 sharedName，页面结构可能已变更');
    this.sharedName = sn[1];

    const fromUrl = this.shareUrl.match(/\/folder\/(\d+)/);
    if (fromUrl) {
      this.rootFolderId = fromUrl[1];
    } else {
      const itemId = html.match(/"itemID"\s*:\s*(\d+)/);
      if (!itemId) throw new Error('未能从分享页解析出根目录 ID');
      this.rootFolderId = itemId[1];
    }

    return this;
  }

  async #getHtml(url) {
    const res = await requestText(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        Cookie: this.jar.header(),
      },
      headerTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (res.statusCode >= 400) throw new Error(`GET ${url} 失败: HTTP ${res.statusCode}`);
    this.jar.absorb(res.headers);
    return res.body;
  }

  /**
   * 列举一页目录内容（走目录页面，解析服务端直出的数据）。
   * 密集抓取时 Box 偶发返回不含数据的页面，故内置重试退避。
   * @returns {Promise<{items: object[], pageCount: number, folderName: string}>}
   */
  async listFolderPage(folderId, page = 1, retries = 4) {
    const url =
      `${this.origin}/v/${this.vanityName}/folder/${folderId}` +
      (page > 1 ? `?page=${page}` : '');

    return withRetry(
      async () => {
        const html = await this.#getHtml(url);
        const stream = extractJsonObject(html, /Box\.postStreamData\s*=/);
        const data = stream?.['/app-api/enduserapp/shared-folder'];
        if (!data) {
          throw new Error(`页面未包含 shared-folder 数据（HTML ${html.length} 字节）`);
        }

        // 关键防护：XHR 版接口曾出现过忽略 folder id、回退到根目录的行为。
        // 不校验的话遍历会陷入 A/A/A/… 的无限递归。
        if (String(data.currentFolderID) !== String(folderId)) {
          throw new Error(
            `目录 ID 不匹配：请求 ${folderId}，实际返回 ${data.currentFolderID}` +
              `（${data.currentFolderName}）`
          );
        }

        return {
          items: data.items ?? [],
          pageCount: data.pageCount ?? 1,
          pageNumber: data.pageNumber ?? page,
          folderName: data.currentFolderName,
        };
      },
      { retries, label: `列举目录 ${folderId} 第 ${page} 页` }
    );
  }

  /** 列举目录全部内容，自动翻页。 */
  async listFolder(folderId) {
    const first = await this.listFolderPage(folderId, 1);
    const all = [...first.items];
    for (let p = 2; p <= first.pageCount; p++) {
      const next = await this.listFolderPage(folderId, p);
      if (next.items.length === 0) break;
      all.push(...next.items);
    }
    return { items: all, folderName: first.folderName, pageCount: first.pageCount };
  }

  /**
   * 换取文件的直链（public.boxcloud.com 签名 URL，有效期约数分钟）。
   * 签名 URL 会过期，因此只在真正要下载前调用。
   */
  async resolveDownloadUrl(fileId) {
    const url =
      `${this.origin}/index.php?rm=box_download_shared_file` +
      `&shared_name=${this.sharedName}&file_id=f_${fileId}`;

    return withRetry(
      async () => {
        // maxRedirects: 0 —— 我们要的就是那个 302 的 Location，不能跟过去
        const res = await requestStream(url, {
          headers: { 'User-Agent': UA, Cookie: this.jar.header() },
          headerTimeoutMs: REQUEST_TIMEOUT_MS,
          maxRedirects: 0,
        });
        res.stream.resume(); // 丢弃 body，释放连接
        this.jar.absorb(res.headers);
        const loc = res.headers.location;
        if (!loc) throw new Error(`HTTP ${res.statusCode}（未返回 Location）`);
        return loc;
      },
      { retries: 2, label: `换取 file ${fileId} 直链` }
    );
  }

  cookieHeader() {
    return this.jar.header();
  }
}

export { UA, extractJsonObject };
