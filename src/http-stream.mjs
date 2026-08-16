/**
 * 基于 Node 原生 http/https 的流式 GET，支持 HTTP 代理（CONNECT 隧道）。
 *
 * 为什么不用内置 fetch：
 *   实测在走本地 HTTP 代理拉大文件时，Node 内置 fetch（undici）会在传输十几 MB 后
 *   抛 UND_ERR_SOCKET / "other side closed" 断开，实际吞吐只有 curl 的 1/4~1/5。
 *   同一条链路下 curl 3.5 MB/s、本模块 2.9 MB/s，而 fetch 反复断连、约 0.75 MB/s。
 *   小请求（列目录、换直链）用 fetch 没问题，只有大流量长连接会踩到，所以下载走这里。
 *
 * 仍然只用 Node 内置模块，无第三方依赖。
 */

import http from 'node:http';
import https from 'node:https';

/** 从环境变量取代理地址（与 curl 的约定一致）。 */
export function envProxy() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null
  );
}

/** 目标是否应绕过代理（NO_PROXY）。 */
function shouldBypass(hostname) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!noProxy) return false;
  return noProxy
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => rule === '*' || hostname === rule || hostname.endsWith(`.${rule.replace(/^\./, '')}`));
}

/** 通过 HTTP 代理建立到目标主机的 CONNECT 隧道，拿到裸 socket。 */
function connectViaProxy(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const px = new URL(proxyUrl);
    const headers = {};
    if (px.username) {
      const cred = `${decodeURIComponent(px.username)}:${decodeURIComponent(px.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
    }

    // 代理本身是明文 HTTP，必须用 http.request 发 CONNECT
    const req = http.request({
      host: px.hostname,
      port: px.port || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`代理 CONNECT 超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);

    req.on('connect', (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 返回 ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

/**
 * 发起流式 GET，自动跟随重定向。
 * @returns {Promise<{statusCode: number, headers: object, stream: import('node:stream').Readable}>}
 *          stream 是 Node 可读流；调用方负责消费或 destroy()。
 */
export async function requestStream(url, opts = {}) {
  const {
    headers = {},
    proxy = envProxy(),
    headerTimeoutMs = 60_000,
    maxRedirects = 5,
  } = opts;

  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = new URL(current);
    const isTls = target.protocol === 'https:';
    const port = Number(target.port) || (isTls ? 443 : 80);
    const useProxy = proxy && !shouldBypass(target.hostname);

    let socket = null;
    if (useProxy && isTls) {
      socket = await connectViaProxy(proxy, target.hostname, port, headerTimeoutMs);
    }

    const res = await new Promise((resolve, reject) => {
      const reqOpts = {
        method: 'GET',
        headers: { Host: target.host, ...headers },
        agent: false,
      };

      if (socket) {
        // 隧道已建好，在其上做 TLS + HTTP/1.1
        reqOpts.socket = socket;
        reqOpts.servername = target.hostname;
        reqOpts.path = target.pathname + target.search;
      } else if (useProxy && !isTls) {
        // 明文 HTTP 走代理：请求行里带绝对 URL
        reqOpts.host = new URL(proxy).hostname;
        reqOpts.port = new URL(proxy).port || 80;
        reqOpts.path = current;
      } else {
        reqOpts.host = target.hostname;
        reqOpts.port = port;
        reqOpts.path = target.pathname + target.search;
      }

      const mod = isTls ? https : http;
      const req = mod.request(reqOpts, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      const timer = setTimeout(() => {
        req.destroy(new Error(`等待响应头超过 ${headerTimeoutMs / 1000}s`));
      }, headerTimeoutMs);
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    });

    if (
      [301, 302, 303, 307, 308].includes(res.statusCode) &&
      res.headers.location &&
      hop < maxRedirects
    ) {
      res.resume(); // 丢弃 body，释放连接
      current = new URL(res.headers.location, current).toString();
      continue;
    }

    return { statusCode: res.statusCode, headers: res.headers, stream: res };
  }

  throw new Error(`重定向超过 ${maxRedirects} 次`);
}

/** 便捷封装：把响应体读成字符串（用于列目录这类小请求）。 */
export async function requestText(url, opts = {}) {
  const res = await requestStream(url, opts);
  const chunks = [];
  for await (const c of res.stream) chunks.push(c);
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}
