# Fork 上游：信任根与发布流程

本仓库是 `dsh-our-free-model` 的 fork，用作插件自身的应用内升级上游。

## 为什么必须换信任根

原实现把仓库名和验签公钥写死在 `src/updater.js`：

```js
const REPO = 'Ebony-Vinyl/dsh-our-free-model'
export const PINNED_MANIFEST_PUBLIC_KEY = 'MCowBQYDK2VwAyEAeLdSVwYFyazc2PIBC0oLsvo4LghGEQz9iXIl3CqRuXI='
```

`DEFAULT_MANIFEST_SOURCES` 全部由 `REPO` 拼出，`downloadManifest()` 的默认 `verifyKey` 就是那把官方公钥。官方私钥不可得，所以**我们签的清单对旧 pin 永远验不过**——只改 `REPO` 会让升级器拉到我们的清单再拒绝它。

两处必须一起改：

| 常量 | 值 |
| --- | --- |
| `REPO` | `licy18/dsh-our-free-model` |
| `PINNED_MANIFEST_PUBLIC_KEY` | `MCowBQYDK2VwAyEAVuUrSTzUrQ8OxXBLfaqE5zvDDZ43SRIc/NybEqpvCqA=` |

## 签名密钥

- 私钥：`C:\Users\CORE\dsh-plugins\ofm-signing\ofm-manifest-key.pem`（PKCS8 PEM，0600，仅本机 `CORE` 可读）
- 公钥：同目录 `public-key.txt`，与上面 `PINNED_MANIFEST_PUBLIC_KEY` 一致
- **私钥永不进仓库**；`.gitignore` 已忽略 `ofm-manifest-key.pem` 与 `*.pem`

密钥丢失的就后果等同于更换信任根：所有已安装实例的升级会失败，必须重新手动装一次。请离线备份。

## 发布步骤

```powershell
cd C:\PC2\dsh-our-free-model

# 1. 改代码后重建生成的包（网关源码在 vendor/channel-pack/src）
$env:OFM_ESBUILD_DIR="$env:TEMP\ofm-esbuild"
node scripts/build-channel-pack.mjs

# 2. 回归
node scripts/gateway-source-test.mjs
node scripts/test-all.mjs --mode contributor
node scripts/build-manifest.mjs --check      # 未改文件时应通过

# 3. 签名清单（改了任何发布文件都必须重签）
$env:OFM_MANIFEST_KEY='C:\Users\CORE\dsh-plugins\ofm-signing\ofm-manifest-key.pem'
node scripts/build-manifest.mjs

# 4. 确认清单可被当前 pin 验过
node scripts/build-manifest.mjs --check

# 5. 提交并推送（manifest 必须进 main，升级器从 raw/main 读它）
git add -A
git commit -m '...'
git push origin main
```

## 关键约束

- **`feed/manifest.json` 必须在 `main` 分支上。** `DEFAULT_MANIFEST_SOURCES` 走 `raw.githubusercontent.com/<REPO>/main/feed/manifest.json` 与 jsDelivr 镜像；只把清单当 Release 附件不行。
- **`base` 固定 `../`。** `parseManifest` 拒绝绝对 URL、协议相对路径、反斜杠；它相对于清单自身 URL 解析，因此文件从 `raw.githubusercontent.com/<REPO>/main/<path>` 取。
- **`files` 上限 80→现已 93 条**（`MAX_FILES` 允许）。`package.json` 必须在列表里。
- **版本号只能前进。** 升级器拒绝把清单版本降到已装版本以下。
- **改了发布文件就必须重签**，否则 `build-manifest.mjs --check` 会报 `the committed digests do not describe the files on disk`。

## 验证清单已就绪的方法

```powershell
# 清单可读
Invoke-WebRequest 'https://raw.githubusercontent.com/licy18/dsh-our-free-model/main/feed/manifest.json' -UseBasicParsing

# 签名可验（用 parseManifest 规整后的文档验，直接对原始 JSON 验会失败）
node -e "
const m=require('fs').readFileSync('feed/manifest.json','utf8');
import('./src/updater.js').then(mod=>{
  const p=mod.parseManifest(JSON.parse(m));
  console.log(mod.verifyManifestSignature(p, mod.PINNED_MANIFEST_PUBLIC_KEY));
});"
```

> ⚠️ 验签必须用 `parseManifest()` 的输出。`verifyManifestSignature` 覆盖 `version/base/publishedAt/notes/files/minSupported`，而 `parseManifest` 会把 `publishedAt` 归一成时间戳、裁断 `notes`——直接喂原始 JSON 会得到 `false`，这不是签名错误。

## 引导：现有安装如何切过来

旧安装的 `PINNED_MANIFEST_PUBLIC_KEY` 还是官方的，所以**第一次必须手动装一次**：

```powershell
# 已在本机准备好 fork tarball
C:\Users\CORE\dsh-plugins\dsh-our-free-model-2.7.1.tgz

# profile 依赖已指向它
# ~/.dsh/profiles/desktop/package.json → file:...2.7.1.tgz

# 铺装后重启 DSH，此后应用内升级即走本 fork
```

装好之后 `src/updater.js` 里的 pin 就是我们的公钥，后续升级链完整属于 fork。

## 回滚

```powershell
# 代码
git -C C:\PC2\dsh-our-free-model revert <commit>

# 已装实例
# node_modules 下有 .bak-2.5.9-<时间戳> 目录，覆盖回去即可
```

若要彻底回到官方上游，需同时把 `REPO` 与 `PINNED_MANIFEST_PUBLIC_KEY` 改回官方值，并重新装官方 tarball。
