import { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import { defineTool } from '@chatluna/tool'
import type {} from '@cordisjs/plugin-http'
import { fetchPage, PageCache } from './fetch'
import { normalizeHosts } from './loader'
import { type ReaderEntry, readers } from './readers'

export type * from './types'
export { fetchPage, PageCache, type FetchOptions, type FetchResult } from './fetch'

export const name = 'omreader'

export interface Config {
  timeout: number
  maxBytes: number
  maxLines: number
  allowedHosts: string[]
  readers: ReaderEntry[]
  githubToken?: string
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    timeout: Schema.natural()
      .role('ms')
      .min(1000)
      .default(30_000)
      .label('抓取超时')
      .description('单次抓取（含站点接口、重定向、重试、文档下载与转换、备用资源探测）的总时限。'),
    maxBytes: Schema.natural()
      .min(1024)
      .default(50 * 1024)
      .label('单次输出字节数')
      .description('每次返回给模型的正文上限（UTF-8 字节）；更长的内容由模型用 offset 分页读取。'),
    maxLines: Schema.natural()
      .min(1)
      .default(300)
      .label('单次输出行数')
      .description('每次返回给模型的正文行数上限；更长的内容由模型用 offset 分页读取。'),
    allowedHosts: Schema.array(Schema.string())
      .default([])
      .label('允许的域名')
      .description('留空表示不限制。填写后只允许这些域名及其子域名，重定向目标同样受限。')
  }).description('读取'),
  Schema.object({
    readers: Schema.array(
      Schema.intersect([
        Schema.object({
          type: Schema.union(readers.map((reader) => Schema.const(reader.id).description(reader.label)))
            .required()
            .label('阅读服务'),
          enabled: Schema.boolean().default(true).label('启用')
        }),
        Schema.union(readers.map((reader) => reader.schema))
        // A new row needs a `type`, or SchemaForm renders every reader's fields at once.
      ]).default({ type: readers[0]!.id, enabled: true })
    )
      .default([])
      .label('远程阅读服务（回退链）')
      .description(
        '本地 HTML 转换得不到可读正文（例如需要执行 JavaScript 的页面）时，按顺序交给这些服务抓取；留空则不使用。'
      ),
    githubToken: Schema.string()
      .role('secret')
      .label('GitHub Token')
      .description('可选。提高 GitHub API 速率限制，并允许读取 Actions 日志。')
  }).description('扩展')
]).description('URL 内容读取：web_read 工具，把网页、站点接口、文档、图片等转换为模型可读的内容。')

export const inject = ['tools', 'http']

interface FetchValue {
  text: string
  image?: { data: string; mediaType: string } | undefined
}

export function apply(ctx: Context, config: Config) {
  const allowedHosts = normalizeHosts(config.allowedHosts)
  const cache = new PageCache()
  ctx.tools.define(
    defineTool({
      name: 'web_read',
      // The host's JSON Schema projection drops per-field descriptions, so argument guidance lives here.
      description:
        'Read an HTTP/HTTPS URL and return its content in a form you can read (Markdown text, or the image itself). ' +
        'Known sites (GitHub, package registries, Stack Overflow, arXiv, Wikipedia, Reddit, Hacker News…) are read through their APIs; ' +
        'PDF/DOCX/PPTX/XLSX/EPUB are converted, images are returned for viewing, JSON is pretty-printed, feeds are summarized. ' +
        'Arguments: `url` is the address; `raw: true` returns the original response text (e.g. HTML source) instead; ' +
        `\`offset\` (1-based line) and \`limit\` page through long content — each call returns at most ${config.maxLines} lines / ${config.maxBytes} bytes, ` +
        'and the result says which offset to continue from.',
      args: Schema.args({
        url: Schema.string().description('HTTP/HTTPS URL to fetch'),
        raw: Schema.boolean().optional().description('Return the original response text instead of Markdown'),
        offset: Schema.natural().min(1).optional().description('1-based line to start from'),
        limit: Schema.natural().min(1).optional().description(`Number of lines to return (max ${config.maxLines})`)
      }),
      traits: { effect: 'read', parallel: true },
      async run(
        input: { url: string; raw?: boolean | undefined; offset?: number | undefined; limit?: number | undefined },
        call
      ): Promise<FetchValue> {
        const result = await fetchPage(ctx, cache, {
          url: input.url,
          raw: input.raw ?? false,
          offset: input.offset,
          limit: input.limit,
          signal: call.signal,
          timeout: config.timeout,
          maxBytes: config.maxBytes,
          maxLines: config.maxLines,
          allowedHosts,
          readers: config.readers,
          githubToken: config.githubToken
        })
        return { text: result.text, image: result.image }
      },
      render: {
        result: (input, value) => {
          const { text, image } = value as unknown as FetchValue
          return {
            kind: 'web',
            title: input.url,
            content: [
              { type: 'text', text },
              ...(image === undefined
                ? []
                : [
                    {
                      type: 'file' as const,
                      mediaType: image.mediaType,
                      data: { type: 'data' as const, data: image.data }
                    }
                  ])
            ]
          }
        }
      }
    })
  )
}
