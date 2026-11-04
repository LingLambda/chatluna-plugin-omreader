# chatluna-plugin-omreader

chatluna的 URL 内容读取插件：网页、站点接口、PDF/Office 文档、图片等统一转换为模型可读的内容。

给模型提供一个 `web_read` 工具：给出任意 HTTP/HTTPS 地址，插件按内容类型处理后返回。网页转成 Markdown，常见站点改走官方接口，PDF / Office / EPUB 文档转成 Markdown，图片直接交给模型查看，Notebook、SQLite、压缩包列出内容，长内容分页读取。

## 关于 HTML 转换库

为了保证抓取效果与一致性，HTML → Markdown 转换使用 WASM 库 [`@xberg-io/html-to-markdown-wasm`](https://www.npmjs.com/package/@xberg-io/html-to-markdown-wasm)（Rust 核心，固定版本 3.12.3，Aggressive 预处理、Tier2 策略、最大嵌套深度 64）。版本和选项固定，同一个页面每次得到相同的 Markdown；站点接口返回的 HTML 片段（README、回答正文、简介等）也统一用它转换，不同来源的输出风格一致。

WASM 转换是同步计算，插件把它放在独立的 worker 线程里执行：大页面不会阻塞 ChatLuna 主线程，调用被取消或超时时 worker 会立即终止。

## 读取流程

1. **站点接口**：URL 属于已适配的站点时，直接调用该站点的公开 API，返回整理好的 Markdown（`raw` 模式跳过这一步）。接口失败时回到通用抓取。
2. **通用抓取**：经由宿主的 `http` 服务发出（沿用其代理配置），手动跟随重定向（最多 10 次，每一跳都检查域名白名单，跨域时去掉认证头）。遇到 Cloudflare / 验证码拦截页时依次换用 3 个 User-Agent；429 按 `Retry-After` 等待后重试一次（最长 10 秒）。文本最多读取 10 MiB，按 BOM → `Content-Type` → `<meta charset>` 解码。
3. **按内容类型处理**：

| 内容 | 处理 |
| --- | --- |
| 图片（PNG / JPEG / GIF / WebP） | 解码校验后交给模型查看；超过 300 KB 时逐级缩小并转 JPEG（GIF 取首帧）；原图上限 20 MiB |
| PDF / DOCX / PPTX / XLSX / EPUB | 下载（上限 50 MiB）后转 Markdown，结果按内容哈希缓存 |
| Jupyter Notebook（`.ipynb`） | 按单元格展开 |
| SQLite 数据库 | 列出表名和行数 |
| 压缩包（zip / tar / tar.gz） | 列出根目录内容 |
| JSON | 格式化输出 |
| RSS / Atom | 汇总为 Markdown（前 10 条） |
| 纯文本 / Markdown | 原样返回 |
| HTML | 见下 |

4. **HTML**：依次尝试站点提供的 Markdown 版本（`<link rel="alternate" type="text/markdown">`、`.md` 后缀、`Accept: text/markdown` 内容协商、页面关联的 RSS/Atom）；都没有时本地转换。本地转换得不到可读正文时，按配置顺序交给远程阅读服务；页面只是一层包装、正文是链接的 PDF/DOCX 时，抓取并转换该文档；仍然不行时尝试 `llms.txt` / `llms.md`。

返回内容开头附带最终 URL、`Content-Type`、实际使用的处理方式（`Method`）和说明。

## 已适配的站点

| 类别 | 站点 |
| --- | --- |
| 代码托管 | GitHub（仓库、文件、目录、Issue、PR、Discussion、提交、Actions）、GitHub Gist、GitLab |
| 开发内容 | Stack Overflow / Stack Exchange、DEV、MDN、docs.rs、Read the Docs、searchcode、Sourcegraph、tldr、cheat.sh |
| 包仓库 | npm、PyPI、crates.io、RubyGems、Packagist、pub.dev、Hex、Hackage、MetaCPAN、Maven Central、Clojars、NuGet、Chocolatey、Homebrew、AUR、Go 包、Docker Hub、Artifact Hub、Terraform Registry、F-Droid、Flathub、Snapcraft、Repology、VS Code 扩展、Open VSX、JetBrains 插件、Firefox 扩展 |
| 社区 / 新闻 | Hacker News、Lobsters、Reddit、Bluesky、Mastodon、Lemmy、Discourse 论坛 |
| 学术 | arXiv、bioRxiv / medRxiv、Crossref（DOI）、IACR ePrint、ORCID、Semantic Scholar、PubMed、RFC |
| 安全 | NVD（CVE）、OSV、CISA KEV |
| AI / 模型 | Hugging Face、Ollama |
| 媒体 | Vimeo、Spotify、Discogs、MusicBrainz、RAWG |
| 其他 | Wikipedia、Wikidata、Open Library、W3C、SPDX、choosealicense、CoinGecko、OpenCorporates、SEC EDGAR |

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `timeout` | `30000` | 单次抓取的总时限（毫秒），含站点接口、重试、文档下载与转换、备用资源探测。 |
| `maxBytes` | `51200` | 每次返回给模型的正文字节上限（UTF-8）。 |
| `maxLines` | `300` | 每次返回给模型的正文行数上限。 |
| `allowedHosts` | `[]` | 留空不限制；填写后只允许这些域名及其子域名，重定向目标和站点接口请求同样受限。 |
| `readers` | `[]` | 远程阅读服务回退链：Jina Reader（Key 可选）、Firecrawl（支持自建地址）、Parallel Extract、DeepSeek Fetch（与 DeepSeek API 共用 Key，按成功请求计费）。本地转换得不到正文时按顺序尝试，单个服务最多 30 秒，且不超过 `timeout` 的剩余时间。 |
| `githubToken` | — | 可选。提高 GitHub API 速率限制，读取 Actions 日志需要它。 |

```yaml
- id: omreader
  name: chatluna-plugin-omreader
  config:
    readers:
      - type: jina
      - type: firecrawl
        apiKey: fc-...
    githubToken: ghp_...
```

## 工具

`web_read({ url, raw?, offset?, limit? })`

- `url`：要抓取的地址；`www.` 开头时自动补 `https://`。
- `raw`：为 `true` 时返回响应原文（例如 HTML 源码），不走站点接口和转换。
- `offset` / `limit`：从第 `offset` 行（从 1 开始）起读取 `limit` 行。内容超过单次上限时，结果里会注明总行数和下一次的 `offset`。抓取结果在内存中缓存 10 分钟，翻页不会重新下载。

## 注意

- 不执行 JavaScript：完全依赖前端渲染的页面，需要配置能渲染 JS 的远程阅读服务（Firecrawl）才能读到正文。
- PDF 用 pdf.js 提取文字，能还原标题、段落和列表；表格和多栏排版不做还原，扫描件（无文字层）只会提示文字缺失。
- `allowedHosts` 为空时，模型可以访问宿主机能访问的任何地址，包括内网和本机服务；面向公开群聊时建议配置白名单。
- 依赖宿主的 `tools`（`@chatluna/tool`）和 `http`（`@cordisjs/plugin-http`）服务。

## 许可

MIT。部分代码改编自其他 MIT 项目，版权声明见 [NOTICE](./NOTICE)。
