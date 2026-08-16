# OPV2V Dataset Downloader (Box Guest Mode)

[中文](README.zh-CN.md) | **English** | [← Project home](../README.md)

Download the OPV2V dataset from UCLA MobilityLab's public Box share link — **no login, no Box API token required**.
Built entirely on Node's built-in modules, with zero third-party dependencies in the production path, so it runs fine on a headless Ubuntu 22 server.

Share link: <https://ucla.app.box.com/v/UCLA-MobilityLab-OPV2V/folder/279976559690>

- **Resumable**: connection dropped, process killed, machine rebooted — rerun the same command and it picks up from the `.part` file
- **Tolerant of flaky networks**: a retry is only charged against the budget when a round transfers almost nothing. Pulling 1.95 GB in practice reconnected several times and still burned zero retries
- **Zero dependencies**: only Node's built-in `http`/`https`/`stream`; no `fetch` (see [About Download Speed](#about-download-speed-why-not-built-in-fetch) for why)
- **Manifest included**: `manifest.json` ships with the repo — 6715 files / 270.70 GB — so you don't have to crawl it yourself

## Table of Contents

- [Quick Start](#quick-start)
- [What's in the Dataset](#whats-in-the-dataset-measured-2026-08-14)
- [Usage](#usage)
- [Resuming a Broken Download](#resuming-a-broken-download)
- [How to Extract What You Downloaded](#how-to-extract-what-you-downloaded)
- [Running It on an Ubuntu 22 Server](#running-it-on-an-ubuntu-22-server)
- [Reverse-Engineering Findings](#reverse-engineering-findings-how-guest-mode-download-urls-are-generated)
- [About Download Speed](#about-download-speed-why-not-built-in-fetch)
- [File Layout](#file-layout)
- [Dataset Attribution and Compliance](#dataset-attribution-and-compliance)
- [License](#license)

## Quick Start

All you need is Node.js >= 20. **No `npm install`** (playwright is only an optional devDependency for `sniff.mjs`).

```bash
git clone https://github.com/bbbstyyy/opv2v-box-downloader.git
cd opv2v-box-downloader
node -v                                             # must be >= 20

# Download using the manifest.json that ships with the repo — no need to re-crawl
npm run download -- -o /mnt/data/opv2v -c 4 --exclude v2vreal

# If it breaks, rerun the same command — it resumes automatically. Verify when done
npm run verify -- -o /mnt/data/opv2v
```

The full set is 271 GB; the OPV2V core alone is about 124 GB — check "What's in the Dataset" below to decide what you actually need.

**Proxy**: just `export HTTPS_PROXY=http://<host>:<port>` (same convention as curl).
This project does not use the built-in fetch, so `NODE_USE_ENV_PROXY` is **not** needed — see "About Download Speed".

## What's in the Dataset (measured 2026-08-14)

Crawl result: **6715 files / 43 directories / 270.70 GB** (`manifest.json`)

| Size | Files | Top-level path | Notes |
| --- | --- | --- | --- |
| 144.05 GB | 7 | *(root-level zips)* | Full archives: `train-003.zip` 66.67 GB, `validate-002.zip` 37.10 GB, `test-012.zip` 19.69 GB, etc. |
| 62.45 GB | 32 | `DATA_train/` | Split volumes: `train_chunks-…-NNN.zip`, ~1.95 GB each |
| 37.10 GB | 19 | `DATA_validate/` | Split volumes, same as above |
| 24.27 GB | 14 | `DATA_test/` | Split volumes, same as above |
| 2.24 GB | 6627 | `v2vreal-…-003/` | V2V4Real-related data and models; huge number of small files |
| 0.41 GB | 14 | `Models-…-001/` | Pretrained models |
| 0.19 GB | 2 | `CoBEVT_Models-…-001/` | CoBEVT models |

**The root-level full archives and the `DATA_*` split volumes are two packagings of the same data** (sizes don't match exactly; not compared byte for byte).
Pick one or the other — there's no need to download both:

```bash
npm run download -- --filter DATA_               # split version, 123.81 GB, 1.95 GB per file, friendlier on unstable networks
npm run download -- --regex '^[^/]+\.zip$'       # full-archive version, 144.05 GB, 7 files, largest is 66 GB
npm run download -- --exclude v2vreal            # everything except the 6627 small v2vreal files (268.46 GB)
```

## Usage

### 1. Build the File Manifest

The `manifest.json` in the repo works as-is; you only need to regenerate it if the dataset changes:

```bash
npm run crawl                      # writes manifest.json
npm run crawl -- --resume          # continue an interrupted crawl (state lives in crawl-state.json)
npm run crawl -- --delay 500       # increase the per-directory delay when rate limited (default 250ms)
```

There are a lot of directories and Box rate-limits, so the crawl uses an explicit queue and checkpoints every 20 directories.
Failed directories back off and retry automatically (up to 3 rounds each), and `--resume` continues after an interruption.

Timing reference: a full crawl took about 20 minutes. Most of that is a handful of directories under `v2vreal` —
each holds 1244 files across 63 pages, and every page is one HTTP request.
If you only want the OPV2V core data you can skip them entirely and just download with the bundled `manifest.json`.

### 2. Download

```bash
npm run download                                   # download everything to ./data
npm run download -- -o /mnt/data/opv2v -c 4        # set output directory and concurrency
npm run download -- --filter DATA_train            # path contains this substring
npm run download -- --regex '^DATA_(train|test)/'  # match paths by regex
npm run download -- --exclude v2vreal              # exclude paths containing this substring (repeatable)
npm run download -- --dry-run                      # just list what would be downloaded
```

- **Resumable**: writes `<file>.part`; rerun the same command to continue from where it stopped. Files that already exist with a matching size are skipped.
  (Verified: a 3.36 MB file truncated to 1 MB and then resumed produced a SHA-256 identical to a full download.)
- **Retries**: a retry is only charged against the budget when a round transfers almost nothing (give up after 6 in a row). On a flaky link where the
  connection drops often but each attempt makes progress, it will keep resuming indefinitely — in practice, pulling a 1.95 GB chunk reconnected
  several times, every one counted as progress, zero retries consumed, and the download completed intact.
- **Timeouts**: 60s for response headers, 90s of transfer stall before aborting and reconnecting (without these, a hung connection hangs forever).
- **Expiring direct links**: every retry fetches a fresh signed URL, so a download never fails just because the URL expired.
- **Concurrency**: defaults to 3. Box rate-limits guest-mode access, so going much higher is not recommended.

### 3. Verify

```bash
npm run verify                     # check local file sizes against the manifest
```

⚠️ **Box guest mode gives you no file hashes**: the share-page data has no `sha1` field (all 6715 files came back empty in this crawl),
so only **size verification** is possible. The `--check-sha1` flag is still there, but it does nothing when the manifest has no sha1.
For a stronger integrity guarantee, test the archives with `unzip -t` at extraction time:

```bash
find /mnt/data/opv2v -name '*.zip' -print0 | xargs -0 -n1 -P4 unzip -t > ziptest.log 2>&1
grep -v "No errors" ziptest.log
```

Files that fail verification are listed at the end and the exit code is 1; just rerun `npm run download` to fill in the gaps.

## Resuming a Broken Download

Hitting `Ctrl-C` mid-download or losing the network is fine — the `.part` file keeps the bytes already fetched:

```bash
npm run download -- -o /mnt/data/opv2v      # interrupted
npm run download -- -o /mnt/data/opv2v      # same command, resumes automatically
```

For long unattended runs:

```bash
nohup npm run download -- -o /mnt/data/opv2v -c 3 > download.log 2>&1 &
tail -f download.log
```

## How to Extract What You Downloaded

⚠️ **The zips under `DATA_train/` are not directly usable data** — there are two layers of wrapping:

```
train_chunks-20240808T030344Z-001.zip     ← the file you downloaded (1.95 GB)
└── train_chunks/
    ├── train.zip.partdy                  ← 500 MB each; pieces of a split train.zip
    ├── train.zip.partee
    ├── train.zip.partep
    └── train.zip.partes
```

So you have to unpack all 32 chunks first, then concatenate every `train.zip.part??` back into
`train.zip` **in filename alphabetical order**, and only then extract the data:

```bash
cd /mnt/data/opv2v/DATA_train

# 1. Unpack every chunk (they all land in the same train_chunks/ directory)
for z in train_chunks-*.zip; do unzip -q -o "$z"; done

# 2. Concatenate the pieces in alphabetical order (ls sorts alphabetically by default; make sure none are missing)
cd train_chunks
ls train.zip.part?? | wc -l          # expect 128 pieces (32 chunks × 4 pieces)
cat $(ls train.zip.part??) > ../train.zip

# 3. Extract
cd .. && unzip train.zip
```

`DATA_validate/` and `DATA_test/` work the same way (the pieces are named `validate.zip.part??` and `test.zip.part??`).

The root-level full archives (`train-003.zip` and friends) extract directly — they don't have this extra split layer.

> Note: the merge steps above are written from the actual internal structure of the chunks that were downloaded
> (confirmed: 500 MB per piece, `split`-style two-letter suffixes), and they match the official OpenCOOD docs —
> the official command is `cat train.zip.part* > train.zip` followed by `unzip` (the shell's `*` also expands in
> alphabetical order, equivalent to the `ls` above). That said, the full 128-piece merge was never run end to end
> here — only the first chunk was pulled for verification. Run `unzip -t train.zip` after merging before extracting for real.

## Running It on an Ubuntu 22 Server

```bash
# 1. Install Node 22 (the nodejs shipped with Ubuntu 22 is too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v            # must be >= 20

# 2. Copy this project over (you only need src/, scripts/, package.json, manifest.json)
#    manifest.json can be reused as-is; no need to re-crawl on the server

# 3. Check disk space: 271 GB for everything, about 124 GB for the OPV2V core
df -h /mnt/data

# 4. Download in the background, logging to disk
mkdir -p /mnt/data/opv2v
nohup npm run download -- -o /mnt/data/opv2v -c 3 --exclude v2vreal \
      > download.log 2>&1 &

tail -f download.log

# 5. If it breaks, rerun the same command — it resumes from the .part files
# 6. Verify once everything is done
npm run verify -- -o /mnt/data/opv2v
```

If you need a proxy, just set the environment variable:

```bash
export HTTPS_PROXY=http://<host>:<port>
```

## Reverse-Engineering Findings (how guest-mode download URLs are generated)

This was the original question the project set out to answer. The findings:

1. **No headless browser required.** The share page's HTML embeds `sharedName` directly
   (`vxetzti0z0dv97yeh1jgxdprxxqucs2a` in this case), obtainable in guest mode.

2. **Directory listings come from the page itself, not from XHR.**
   Directory contents are server-rendered into the HTML under
   `Box.postStreamData['/app-api/enduserapp/shared-folder']`,
   which contains `items` / `pageCount` / `currentFolderID`.
   So listing any subdirectory is just `GET /v/<vanityName>/folder/<folderId>` plus parsing that JSON,
   with `?page=N` for pagination.

   ⚠️ **Gotcha**: the XHR endpoint that looks so convenient,
   `GET /app-api/enduserapp/shared-folder?folder_id=<id>&shared_name=<sn>`,
   **ignores `folder_id` and always returns the share root** (tried `folderId`, `parent_id`,
   `X-Box-EndUser-API: sharedName=…&folderId=…`, `Referer`, and every other variant — same result).
   Recursing on it directly gives you infinite nesting like `DATA_validate/DATA_validate/DATA_validate/…`.
   `src/box-client.mjs` validates `currentFolderID` strictly to guard against exactly this.

3. **The download link is a short-lived signed URL obtained through a single 302.**

   ```
   GET https://ucla.app.box.com/index.php?rm=box_download_shared_file
       &shared_name=<sharedName>&file_id=f_<fileId>
   → 302 Location: https://public.boxcloud.com/d/1/b1!<signature>../download
   ```

   The signed URL on `public.boxcloud.com` is valid for only a few minutes, and it supports HTTP `Range`.
   That's why the downloader **fetches a fresh direct link on every (re)try**, then resumes from the offset with `Range`.

`scripts/sniff.mjs` was the one-off helper used to capture traffic and pin down the behavior above (it needs playwright);
the production path does not depend on it.

> The behavior above was measured in 2026-08. It may break if Box changes their frontend — if `npm run crawl` reports
> "failed to parse sharedName from the share page" or "page contains no shared-folder data", this is what changed.

## About Download Speed: Why Not Built-in fetch

**Node's built-in `fetch` (undici) has serious problems pulling large files through an HTTP proxy.** This was the deepest pitfall in the project.

Symptoms: throughput of only 0.75 MB/s, with a disconnect every dozen or so MB (`UND_ERR_SOCKET` /
"other side closed") — pulling one 1.95 GB chunk took 40 reconnects.
Meanwhile, clicking download in a browser at the same moment ran at 10+ MB/s.

Same link, same direct URL, same Range requests, four clients measured (`scripts/diag.mjs`):

| Client | Throughput |
| --- | --- |
| curl (HTTP/1.1, via proxy) | 3.52 MB/s |
| curl `--http2` (via proxy) | 3.44 MB/s |
| **Node native `http`/`https` (via proxy CONNECT)** | **2.93 MB/s** |
| Node built-in `fetch` (undici) | ❌ repeated `UND_ERR_SOCKET` disconnects |

The conclusion is unambiguous: **the problem is undici's proxy implementation — not the link, not Box, not HTTP/2**
(curl was actually slightly faster with h2). So `src/http-stream.mjs` builds its own proxy CONNECT tunnel on
Node's native `http`/`https`, and `fetch` is no longer used anywhere in the project — still zero third-party dependencies.

After the switch, same machine, same proxy:

| | Before (fetch) | After (native https) |
| --- | --- | --- |
| Throughput | 0.75 MB/s | **4.9 ~ 6 MB/s** |
| Time for 1.95 GB | 39 minutes | **6 minutes** |
| Reconnects | 40 | 7 |

### Concurrency Does Saturate the Link — Use `-c 4`

Multiple connections only started paying off after dropping fetch (`scripts/speedtest.mjs`, 20s per step):

| Connections | Throughput | Speedup |
| --- | --- | --- |
| 1 | 4.80 MB/s | 1.00x |
| 2 | 8.27 MB/s | 1.72x |
| 4 | **9.91 MB/s** | 2.07x |

The real downloader confirms it: `-c 4` pulling 4 chunks at once reaches an **aggregate 9.39 MB/s**,
on par with clicking download in a browser. So:

```bash
npm run download -- -o /mnt/data/opv2v -c 4
```

`-c` controls **how many files download simultaneously** — with many files that's equivalent to multiple connections,
so there's no need to add ranged parallelism within a single file. You only miss out on the concurrency win when
downloading one enormous file (like the 66 GB `train-003.zip` at the root).

> An earlier version concluded that "the bottleneck is proxy egress bandwidth, multiple connections don't help"
> (1/4/8 connections showed only 1.31x) — that was measured while fetch was broken, mistaking undici's disconnects
> for a bandwidth ceiling. That conclusion does not hold.

> The numbers above come from one specific machine and one specific proxy; your link will differ. What does reproduce
> is the **relative relationship**: native `http`/`https` is significantly faster than undici, and concurrency helps.

### Proxy Configuration

Just use the standard environment variables, same convention as `curl`. `NODE_USE_ENV_PROXY` is **not** needed:

```bash
export HTTPS_PROXY=http://<host>:<port>
npm run download
```

`HTTP_PROXY`, `NO_PROXY`, and credentials in the form `http://user:pass@host:port` are supported too.
If your server reaches Box directly, don't set anything.

## File Layout

```
src/box-client.mjs     Box guest-mode client: session, directory listing, direct-link exchange
src/http-stream.mjs    Native http/https streaming requests + proxy CONNECT (replaces fetch)
scripts/crawl.mjs      Recursive directory-tree crawl → manifest.json (supports --resume)
scripts/download.mjs   Download/verify against the manifest (resume, concurrency, retries)
scripts/speedtest.mjs  Measure single- vs multi-connection throughput
scripts/diag.mjs       Compare curl / native https / fetch throughput to locate the bottleneck
scripts/sniff.mjs      One-off reverse-engineering helper (playwright capture); not needed in production
manifest.json          Ready-made file manifest (6715 files / 270.70 GB), usable for downloading as-is
```

## Dataset Attribution and Compliance

**This repository is only a download client. It does not contain, and does not redistribute, any OPV2V data.**

The dataset is published by UCLA Mobility Lab:

- Official page: <https://mobility-lab.seas.ucla.edu/opv2v>
- Paper: [OPV2V: An Open Benchmark Dataset and Fusion Pipeline for Perception with
  Vehicle-to-Vehicle Communication](https://arxiv.org/abs/2109.07644) (ICRA 2022,
  pp. 2583-2589)
- Official code (data format docs, devkit, benchmark): <https://github.com/DerrickXuNu/OpenCOOD>

The official page states **Copyright © 2021 UCLA Mobility Lab, All Rights Reserved**;
copyright and terms of use for the data belong to the original authors. For research use, cite as OpenCOOD requests:

```bibtex
@inproceedings{xu2022opencood,
  author    = {Runsheng Xu and Hao Xiang and Xin Xia and Xu Han and Jinlong Li and Jiaqi Ma},
  title     = {OPV2V: An Open Benchmark Dataset and Fusion Pipeline for Perception
               with Vehicle-to-Vehicle Communication},
  booktitle = {2022 IEEE International Conference on Robotics and Automation (ICRA)},
  year      = {2022}
}
```

About this tool itself:

- It uses the Box share link the dataset authors **published deliberately** — the OpenCOOD docs say verbatim that
  "All the data can be downloaded from UCLA BOX". It uses the same guest-mode endpoints any browser hits when visiting
  that link, bypasses no authentication, and accesses nothing it isn't entitled to. Please don't point it at shares that aren't public.
- Concurrency defaults to 3. Please don't crank it up for speed — that's just a burden on someone else's freely provided hosting.

## License

The code is released under the [MIT License](../LICENSE).

Note: MIT covers **the code in this repository only**, not the OPV2V dataset downloaded through this tool —
see the previous section for the data's license.
