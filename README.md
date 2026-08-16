# OPV2V 数据集下载器 · OPV2V Dataset Downloader（Box 游客态 / Box Guest Mode）

从 UCLA MobilityLab 的 Box 公开分享链接下载 OPV2V 数据集，**无需登录、无需 Box API token**。
纯 Node 内置模块实现，生产流程零第三方依赖，适合在无 GUI 的 Ubuntu 22 server 上跑。

Download the OPV2V dataset from UCLA MobilityLab's public Box share link — **no login, no Box API token required**.
Built entirely on Node's built-in modules with zero third-party dependencies, so it runs fine on a headless Ubuntu 22 server.

## 📖 完整文档 / Full Documentation

| | |
| --- | --- |
| 🇨🇳 **[中文文档](docs/README.zh-CN.md)** | 用法、数据集构成、解压步骤、逆向结论、速度实测 |
| 🇬🇧 **[English](docs/README.en.md)** | Usage, dataset breakdown, extraction steps, reverse-engineering findings, benchmarks |

分享链接 / Share link: <https://ucla.app.box.com/v/UCLA-MobilityLab-OPV2V/folder/279976559690>

## 特性 / Features

- **断点续传 / Resumable** — 连接断了、进程杀了、机器重启了，重跑同一条命令即从 `.part` 继续
  · rerun the same command and it picks up from the `.part` file
- **弱网友好 / Flaky-network tolerant** — 只有「本轮几乎没传到数据」才消耗重试配额
  · a retry is only charged against the budget when a round transfers almost nothing
- **零依赖 / Zero dependencies** — 只用 Node 内置 `http`/`https`/`stream`，不用 `fetch`
  · built-ins only, no `fetch`（原因见文档 / see the docs for why）
- **清单已备好 / Manifest included** — `manifest.json` 是现成的，6715 个文件 / 270.70 GB
  · ready to use, 6715 files / 270.70 GB

## 快速开始 / Quick Start

只需要 Node.js >= 20，**不用 `npm install`**。
All you need is Node.js >= 20 — **no `npm install`**.

```bash
git clone https://github.com/bbbstyyy/opv2v-box-downloader.git
cd opv2v-box-downloader
node -v                                             # 需 >= 20 / requires >= 20

# 直接用仓库里现成的 manifest.json 下载，不必重新 crawl
# download with the bundled manifest.json — no need to re-crawl
npm run download -- -o /mnt/data/opv2v -c 4 --exclude v2vreal

# 断了就重跑同一条命令，自动续传；下完校验
# if it breaks, rerun the same command to resume; verify when done
npm run verify -- -o /mnt/data/opv2v
```

全量 271 GB，只要 OPV2V 主体约 124 GB——先看文档里的「数据集构成」决定下哪些。
The full set is 271 GB; the OPV2V core alone is about 124 GB — see "What's in the Dataset" in the docs to decide.

## 数据集出处 / Dataset Attribution

**本仓库只是一个下载客户端，不包含也不再分发 OPV2V 的任何数据。**
**This repository is only a download client. It does not contain or redistribute any OPV2V data.**

数据集由 UCLA Mobility Lab 发布 / Published by UCLA Mobility Lab:
<https://mobility-lab.seas.ucla.edu/opv2v> · [OpenCOOD](https://github.com/DerrickXuNu/OpenCOOD) · [论文 / Paper (ICRA 2022)](https://arxiv.org/abs/2109.07644)

引用要求与合规说明见完整文档 / See the full docs for citation requirements and compliance notes.

## License

代码以 [MIT License](LICENSE) 发布，不覆盖通过本工具下载的数据集。
The code is released under the [MIT License](LICENSE); it does not cover the dataset downloaded through this tool.
