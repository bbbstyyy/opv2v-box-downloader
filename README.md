# OPV2V 数据集下载器（Box 游客态）

从 UCLA MobilityLab 的 Box 公开分享链接下载 OPV2V 数据集，**无需登录、无需 Box API token**。
纯 Node 内置模块实现，生产流程零第三方依赖，适合在无 GUI 的 Ubuntu 22 server 上跑。

分享链接：<https://ucla.app.box.com/v/UCLA-MobilityLab-OPV2V/folder/279976559690>

- **断点续传**：连接断了、进程杀了、机器重启了，重跑同一条命令即从 `.part` 继续
- **弱网友好**：只有「本轮几乎没传到数据」才消耗重试配额，实测拉 1.95 GB 期间自动重连若干次仍零重试消耗
- **零依赖**：只用 Node 内置 `http`/`https`/`stream`，不用 `fetch`（原因见[关于下载速度](#关于下载速度为什么不用内置-fetch)）
- **清单已备好**：`manifest.json` 是现成的，6715 个文件 / 270.70 GB，不必自己重新遍历

## 目录

- [快速开始](#快速开始)
- [数据集构成](#数据集构成2026-08-14-实测)
- [用法](#用法)
- [断点续传的正确姿势](#断点续传的正确姿势)
- [下载完之后怎么解压](#下载完之后怎么解压)
- [在 Ubuntu 22 server 上跑一遍](#在-ubuntu-22-server-上跑一遍)
- [逆向结论](#逆向结论游客态下载链接是怎么生成的)
- [关于下载速度](#关于下载速度为什么不用内置-fetch)
- [文件结构](#文件结构)
- [数据集出处与合规](#数据集出处与合规)
- [License](#license)

## 快速开始

只需要 Node.js >= 20，**不用 `npm install`**（playwright 只是 `sniff.mjs` 的可选 devDependency）。

```bash
git clone https://github.com/bbbstyyy/opv2v-box-downloader.git
cd opv2v-box-downloader
node -v                                             # 需 >= 20

# 直接用仓库里现成的 manifest.json 下载，不必重新 crawl
npm run download -- -o /mnt/data/opv2v -c 4 --exclude v2vreal

# 断了就重跑同一条命令，自动续传；下完校验
npm run verify -- -o /mnt/data/opv2v
```

全量 271 GB，只要 OPV2V 主体约 124 GB——先看下面「数据集构成」决定下哪些。

**代理**：直接 `export HTTPS_PROXY=http://<host>:<port>` 即可（与 curl 约定一致）。
项目不使用内置 fetch，所以**不需要** `NODE_USE_ENV_PROXY`，原因见「关于下载速度」。

## 数据集构成（2026-08-14 实测）

遍历结果：**6715 个文件 / 43 个目录 / 270.70 GB**（`manifest.json`）

| 体积 | 文件数 | 顶层路径 | 说明 |
| --- | --- | --- | --- |
| 144.05 GB | 7 | *（根目录 zip）* | 整包：`train-003.zip` 66.67 GB、`validate-002.zip` 37.10 GB、`test-012.zip` 19.69 GB 等 |
| 62.45 GB | 32 | `DATA_train/` | 分卷：`train_chunks-…-NNN.zip`，每卷约 1.95 GB |
| 37.10 GB | 19 | `DATA_validate/` | 分卷，同上 |
| 24.27 GB | 14 | `DATA_test/` | 分卷，同上 |
| 2.24 GB | 6627 | `v2vreal-…-003/` | V2V4Real 相关数据与模型，海量小文件 |
| 0.41 GB | 14 | `Models-…-001/` | 预训练模型 |
| 0.19 GB | 2 | `CoBEVT_Models-…-001/` | CoBEVT 模型 |

**根目录整包与 `DATA_*` 分卷是同一批数据的两种打包形式**（体积不完全对应，未逐字节比对）。
按需二选一即可，不必两套都下：

```bash
npm run download -- --filter DATA_               # 分卷版 123.81 GB，单文件 1.95 GB，网络不稳时更友好
npm run download -- --regex '^[^/]+\.zip$'       # 整包版 144.05 GB，7 个文件，单个最大 66 GB
npm run download -- --exclude v2vreal            # 全量但跳过 6627 个小文件的 v2vreal（268.46 GB）
```

## 用法

### 1. 生成文件清单

仓库里的 `manifest.json` 可以直接用，只有在数据集更新后才需要重新生成：

```bash
npm run crawl                      # 输出 manifest.json
npm run crawl -- --resume          # 中断后续爬（状态存在 crawl-state.json）
npm run crawl -- --delay 500       # 被限流时加大目录间隔（默认 250ms）
```

目录数量多且 Box 会限流，遍历采用显式队列 + 每 20 个目录存盘，
失败目录自动退避重试（单目录最多 3 轮），中断后 `--resume` 可继续。

耗时参考：本次完整遍历约 20 分钟。慢点主要在 `v2vreal` 下的几个目录——
每个有 1244 个文件、要翻 63 页，一页一个 HTTP 请求。
只要 OPV2V 主体数据的话可以跳过它们，直接用现成的 `manifest.json` 下载即可。

### 2. 下载

```bash
npm run download                                   # 全量下载到 ./data
npm run download -- -o /mnt/data/opv2v -c 4        # 指定目录与并发
npm run download -- --filter DATA_train            # 路径含该子串
npm run download -- --regex '^DATA_(train|test)/'  # 正则匹配路径
npm run download -- --exclude v2vreal              # 排除路径含该子串（可重复）
npm run download -- --dry-run                      # 只列出将要下载什么
```

- **断点续传**：写 `<文件>.part`，重跑同一条命令即从断点继续；已完成且大小一致的文件自动跳过。
  （已实测：把 3.36 MB 文件截断到 1 MB 再续传，结果与完整下载 SHA-256 完全一致。）
- **重试**：只有「本轮几乎没传到数据」才消耗重试配额（连续 6 次放弃）。弱网下连接频繁断开但
  每次都有进展时，会一直续传下去——实测拉 1.95 GB 的 chunk 期间自动重连若干次，全部判定为
  有进展、零重试消耗，最终完整下载成功。
- **超时**：响应头 60s、传输停滞 90s 自动中断重连（不加的话卡住的连接会永久挂起）。
- **直链过期**：每次重试重新换取签名 URL，不会因为 URL 过期而失败。
- **并发**：默认 3。Box 对游客态有限流，不建议开太高。

### 3. 校验

```bash
npm run verify                     # 按 manifest 校验本地文件大小
```

⚠️ **Box 游客态拿不到文件哈希**：分享页数据里没有 `sha1` 字段（本次遍历 6715 个文件全部为空），
所以只能做**大小校验**。`--check-sha1` 参数保留了，但清单没有 sha1 时它不会生效。
需要更强的完整性保证，可在解压时用 `unzip -t` 测试压缩包：

```bash
find /mnt/data/opv2v -name '*.zip' -print0 | xargs -0 -n1 -P4 unzip -t > ziptest.log 2>&1
grep -v "No errors" ziptest.log
```

校验不通过的文件会列在最后，且退出码为 1；直接重跑 `npm run download` 即可补齐。

## 断点续传的正确姿势

下载中途按 `Ctrl-C` 或断网都不要紧，`.part` 文件保留了已下载的字节：

```bash
npm run download -- -o /mnt/data/opv2v      # 中断
npm run download -- -o /mnt/data/opv2v      # 同一条命令，自动续传
```

后台长跑建议：

```bash
nohup npm run download -- -o /mnt/data/opv2v -c 3 > download.log 2>&1 &
tail -f download.log
```

## 下载完之后怎么解压

⚠️ **`DATA_train/` 里的 zip 不是直接可用的数据**，而是套了两层：

```
train_chunks-20240808T030344Z-001.zip     ← 下载得到的文件（1.95 GB）
└── train_chunks/
    ├── train.zip.partdy                  ← 每片 500 MB，是 train.zip 被 split 后的碎片
    ├── train.zip.partee
    ├── train.zip.partep
    └── train.zip.partes
```

所以要先把 32 个 chunk 全部解开，再把所有 `train.zip.part??` **按文件名字母序**拼回
`train.zip`，最后才能解压出数据：

```bash
cd /mnt/data/opv2v/DATA_train

# 1. 解开全部 chunk（都会落到同一个 train_chunks/ 目录）
for z in train_chunks-*.zip; do unzip -q -o "$z"; done

# 2. 按字母序拼接碎片（ls 的默认排序即字母序，务必确认没有缺片）
cd train_chunks
ls train.zip.part?? | wc -l          # 期望 128 片（32 chunk × 4 片）
cat $(ls train.zip.part??) > ../train.zip

# 3. 解压
cd .. && unzip train.zip
```

`DATA_validate/`、`DATA_test/` 同理（碎片名分别是 `validate.zip.part??`、`test.zip.part??`）。

根目录的整包 zip（`train-003.zip` 等）则是直接解压即可，没有这层碎片。

> 说明：上面的合并步骤是依据已下载 chunk 的实际内部结构写的（已确认每片 500 MB、
> 命名为 `split` 风格的两字母后缀），并与 OpenCOOD 官方文档一致——官方给的命令就是
> `cat train.zip.part* > train.zip` 再 `unzip`（shell 的 `*` 展开同样是字母序，
> 与上面的 `ls` 等价）。但完整的 128 片合并本机没有端到端跑过——只拉了第 1 个
> chunk 做验证。合并后建议先 `unzip -t train.zip` 再正式解压。

## 在 Ubuntu 22 server 上跑一遍

```bash
# 1. 装 Node 22（Ubuntu 22 自带的 nodejs 版本太老）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v            # 需 >= 20

# 2. 拷贝本项目（只需 src/、scripts/、package.json、manifest.json）
#    manifest.json 可以直接复用，不必在服务器上重新 crawl

# 3. 确认磁盘空间：全量 271 GB，只要 OPV2V 主体约 124 GB
df -h /mnt/data

# 4. 后台下载，日志落盘
mkdir -p /mnt/data/opv2v
nohup npm run download -- -o /mnt/data/opv2v -c 3 --exclude v2vreal \
      > download.log 2>&1 &

tail -f download.log

# 5. 断了就重跑同一条命令，自动从 .part 续传
# 6. 全部完成后校验
npm run verify -- -o /mnt/data/opv2v
```

需要走代理时设置环境变量即可：

```bash
export HTTPS_PROXY=http://<host>:<port>
```

## 逆向结论（游客态下载链接是怎么生成的）

这是本项目最初要搞清楚的问题，结论如下：

1. **不需要 headless 浏览器。** 分享页 HTML 里直接内嵌了 `sharedName`
   （本例为 `vxetzti0z0dv97yeh1jgxdprxxqucs2a`），游客态即可取得。

2. **列目录靠页面直出，不是 XHR。**
   目录内容由服务端渲染进 HTML 的
   `Box.postStreamData['/app-api/enduserapp/shared-folder']`，
   包含 `items` / `pageCount` / `currentFolderID`。
   所以列举任意子目录只要 `GET /v/<vanityName>/folder/<folderId>` 再解析这个 JSON，
   翻页用 `?page=N`。

   ⚠️ **坑**：看起来很顺手的 XHR 接口
   `GET /app-api/enduserapp/shared-folder?folder_id=<id>&shared_name=<sn>`
   会**忽略 `folder_id`，永远返回分享根目录**（试过 `folderId`、`parent_id`、
   `X-Box-EndUser-API: sharedName=…&folderId=…`、`Referer` 等各种变体都一样）。
   直接拿它递归会得到 `DATA_validate/DATA_validate/DATA_validate/…` 的无限嵌套。
   `src/box-client.mjs` 里对 `currentFolderID` 做了强校验来防这个坑。

3. **下载链接是一次 302 换来的短时效签名 URL。**

   ```
   GET https://ucla.app.box.com/index.php?rm=box_download_shared_file
       &shared_name=<sharedName>&file_id=f_<fileId>
   → 302 Location: https://public.boxcloud.com/d/1/b1!<签名>../download
   ```

   `public.boxcloud.com` 上的签名 URL 只有几分钟有效期，且支持 HTTP `Range`。
   因此下载器**每次（重）试都重新换取直链**，再用 `Range` 从断点续传。

`scripts/sniff.mjs` 是当时用来抓包定位上述行为的一次性辅助脚本（需要 playwright），
生产流程不依赖它。

> 上述行为是 2026-08 实测的结果。Box 改前端后可能失效——如果 `npm run crawl` 报
> 「未能从分享页解析出 sharedName」或「页面未包含 shared-folder 数据」，就是这里变了。

## 关于下载速度：为什么不用内置 fetch

**Node 内置的 `fetch`（undici）在走 HTTP 代理拉大文件时有严重问题**，这是本项目踩过最深的坑。

症状：下载速度只有 0.75 MB/s，且每隔十几 MB 就断开一次（`UND_ERR_SOCKET` /
"other side closed"），拉一个 1.95 GB 的 chunk 要重连 40 次。
而同一时刻浏览器点击下载能跑到 10 MB+/s。

同一条链路、同一个直链、同样的 Range 请求，四种客户端实测（`scripts/diag.mjs`）：

| 客户端 | 吞吐 |
| --- | --- |
| curl（HTTP/1.1，走代理） | 3.52 MB/s |
| curl `--http2`（走代理） | 3.44 MB/s |
| **Node 原生 `http`/`https`（走代理 CONNECT）** | **2.93 MB/s** |
| Node 内置 `fetch`（undici） | ❌ 反复 `UND_ERR_SOCKET` 断开 |

结论很清楚：**问题在 undici 的代理实现，不在链路、不在 Box、也不在 HTTP/2**
（curl 用 h2 反而略快）。所以 `src/http-stream.mjs` 用 Node 原生 `http`/`https`
自己做代理 CONNECT 隧道，全项目不再使用 `fetch`——依然零第三方依赖。

换掉之后，同一台机器同一个代理：

| | 换之前（fetch） | 换之后（原生 https） |
| --- | --- | --- |
| 吞吐 | 0.75 MB/s | **4.9 ~ 6 MB/s** |
| 拉 1.95 GB 耗时 | 39 分钟 | **6 分钟** |
| 重连次数 | 40 次 | 7 次 |

### 并发能吃满带宽，用 `-c 4`

换掉 fetch 之后多连接才真正起作用（`scripts/speedtest.mjs`，20s/档）：

| 连接数 | 吞吐 | 加速比 |
| --- | --- | --- |
| 1 | 4.80 MB/s | 1.00x |
| 2 | 8.27 MB/s | 1.72x |
| 4 | **9.91 MB/s** | 2.07x |

真实下载器实测同样成立：`-c 4` 同时拉 4 个 chunk，**聚合 9.39 MB/s**，
和浏览器点击下载的速度持平。所以：

```bash
npm run download -- -o /mnt/data/opv2v -c 4
```

`-c` 控制的是**同时下载几个文件**——文件多的时候这就等于多连接，不需要再对单个文件
做分段并发。只有在下载单个巨大文件（比如根目录 66 GB 的 `train-003.zip`）时才吃不到
并发红利。

> 早期版本得出过"瓶颈在代理出口带宽、多连接无用"的结论（1/4/8 连接只有 1.31x）——
> 那是在 fetch 有问题的前提下测的，把 undici 的断连误当成了带宽上限，结论不成立。

> 以上数字是特定机器 + 特定代理下的实测，你的链路会不一样。真正可复现的是**相对关系**：
> 原生 `http`/`https` 显著快于 undici，且多连接有效。

### 代理配置

直接用标准环境变量即可，和 `curl` 的约定一致，**不需要** `NODE_USE_ENV_PROXY`：

```bash
export HTTPS_PROXY=http://<host>:<port>
npm run download
```

也支持 `HTTP_PROXY`、`NO_PROXY`、以及带用户名密码的 `http://user:pass@host:port`。
服务器能直连 Box 就不用设。

## 文件结构

```
src/box-client.mjs     Box 游客态客户端：会话、列目录、换取下载直链
src/http-stream.mjs    原生 http/https 流式请求 + 代理 CONNECT（替代 fetch）
scripts/crawl.mjs      递归遍历目录树 → manifest.json（支持 --resume）
scripts/download.mjs   按清单下载/校验（断点续传、并发、重试）
scripts/speedtest.mjs  测单连接 vs 多连接吞吐
scripts/diag.mjs       对比 curl / 原生 https / fetch 的吞吐，定位瓶颈在哪一层
scripts/sniff.mjs      一次性逆向辅助（playwright 抓包），生产不依赖
manifest.json          现成的文件清单（6715 个文件 / 270.70 GB），可直接用于下载
```

## 数据集出处与合规

**本仓库只是一个下载客户端，不包含也不再分发 OPV2V 的任何数据。**

数据集由 UCLA Mobility Lab 发布：

- 官方主页：<https://mobility-lab.seas.ucla.edu/opv2v>
- 论文：[OPV2V: An Open Benchmark Dataset and Fusion Pipeline for Perception with
  Vehicle-to-Vehicle Communication](https://arxiv.org/abs/2109.07644)（ICRA 2022，
  pp. 2583-2589）
- 官方代码库（数据格式说明、devkit、benchmark）：<https://github.com/DerrickXuNu/OpenCOOD>

官方主页标注 **Copyright © 2021 UCLA Mobility Lab, All Rights Reserved**，
数据的版权与使用条款归原作者所有。用于研究请按 OpenCOOD 要求引用：

```bibtex
@inproceedings{xu2022opencood,
  author    = {Runsheng Xu and Hao Xiang and Xin Xia and Xu Han and Jinlong Li and Jiaqi Ma},
  title     = {OPV2V: An Open Benchmark Dataset and Fusion Pipeline for Perception
               with Vehicle-to-Vehicle Communication},
  booktitle = {2022 IEEE International Conference on Robotics and Automation (ICRA)},
  year      = {2022}
}
```

关于本工具本身：

- 走的是数据集作者**主动公开**的 Box 分享链接——OpenCOOD 官方文档原话就是
  "All the data can be downloaded from UCLA BOX"。用的是任何浏览器访问该链接时
  同样的游客态接口，不绕过任何鉴权、不做任何越权访问。请勿用它去访问未公开的分享。
- 并发默认 3，请不要为了提速把并发调得过高——那是在给别人的公益托管添麻烦。

## License

代码以 [MIT License](LICENSE) 发布。

注意：MIT 只覆盖**本仓库的代码**，不覆盖通过本工具下载的 OPV2V 数据集——
数据的许可见上一节。
