// docs.rs pages rendered from the crate's rustdoc JSON.
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type { Scraper } from './types'
import { tryParseJson } from './utils'

const gunzipAsync = promisify(gunzip)

// --- Rustdoc JSON types (subset we care about) ---

interface RustdocCrate {
  root: number
  crate_version: string | null
  index: Record<string, RustdocItem>
  paths: Record<string, { crate_id: number; path: string[]; kind: string }>
  format_version: number
}

interface RustdocItem {
  name: string | null
  docs: string | null
  attrs: string[]
  inner: Record<string, unknown>
  visibility: string | { restricted: { parent: number; path: string } }
  deprecation: { since: string | null; note: string | null } | null
}

interface FunctionData {
  sig: { inputs: [string, RustType][]; output: RustType | null }
  generics: Generics
  has_body: boolean
  is_async: boolean
  is_unsafe: boolean
  is_const: boolean
}

interface Generics {
  params: GenericParam[]
  where_predicates: unknown[]
}

interface GenericParam {
  name: string
  kind: Record<string, unknown>
}

// Rustdoc type representation — a union encoded as single-key objects
type RustType = Record<string, unknown>

// --- URL parsing ---

interface DocsRsTarget {
  crateName: string
  version: string
  /** e.g. "serde/de" for a submodule, "serde" for root */
  modulePath: string[]
  /** e.g. "struct", "trait", "fn", "enum", "macro", "type" */
  itemKind: string | null
  /** e.g. "Serialize" */
  itemName: string | null
}

function parseDocsRsUrl(parsed: URL): DocsRsTarget | null {
  if (parsed.hostname !== 'docs.rs') return null

  const segments = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean)

  // /crate/{name}/{version} overview pages are docs.rs chrome, not rustdoc
  if (segments[0] === 'crate') return null

  // Rustdoc pages: /{crate}/{version}/{crate_path}/[item.html]; minimum /{crate}/{version}/{crate}
  if (segments.length < 3) return null

  const crateName = segments[0]!
  const version = segments[1]! // "latest", "1.0.228", etc.

  // The rest is the module path, possibly ending with an item page
  const rest = segments.slice(2)
  let itemKind: string | null = null
  let itemName: string | null = null

  const last = rest[rest.length - 1]
  // Item pages: struct.Foo.html, trait.Bar.html, fn.baz.html, etc.
  const itemMatch = last?.match(
    /^(struct|trait|fn|enum|macro|type|constant|static|attr|derive|union|primitive)\.(.+)\.html$/
  )
  if (itemMatch) {
    itemKind = itemMatch[1]!
    itemName = itemMatch[2]!
    rest.pop()
  } else if (last === 'index.html') {
    rest.pop()
  }

  return { crateName, version, modulePath: rest, itemKind, itemName }
}

// --- Type rendering ---

function renderType(ty: RustType | null | undefined, depth = 0): string {
  if (!ty || depth > 10) return '_'

  if (typeof ty === 'string') return ty

  if ('generic' in ty) return ty.generic as string
  if ('primitive' in ty) return ty.primitive as string
  if ('infer' in ty) return '_'

  if ('resolved_path' in ty) {
    const rp = ty.resolved_path as { path: string; args?: { angle_bracketed?: { args: unknown[] } } }
    const args = rp.args?.angle_bracketed?.args
    if (args?.length) {
      const rendered = args
        .map((a: unknown) => {
          if (typeof a === 'object' && a !== null && 'type' in a) return renderType(a.type as RustType, depth + 1)
          if (typeof a === 'object' && a !== null && 'lifetime' in a) return `'${String(a.lifetime)}`
          return '_'
        })
        .join(', ')
      return `${rp.path}<${rendered}>`
    }
    return rp.path
  }

  if ('borrowed_ref' in ty) {
    const br = ty.borrowed_ref as { lifetime: string | null; is_mutable: boolean; type: RustType }
    const lt = br.lifetime ? `'${br.lifetime} ` : ''
    const mutStr = br.is_mutable ? 'mut ' : ''
    return `&${lt}${mutStr}${renderType(br.type, depth + 1)}`
  }

  if ('tuple' in ty) {
    const items = (ty.tuple as RustType[]).map((t) => renderType(t, depth + 1))
    return `(${items.join(', ')})`
  }

  if ('slice' in ty) return `[${renderType(ty.slice as RustType, depth + 1)}]`

  if ('array' in ty) {
    const arr = ty.array as { type: RustType; len: string }
    return `[${renderType(arr.type, depth + 1)}; ${arr.len}]`
  }

  if ('raw_pointer' in ty) {
    const rp = ty.raw_pointer as { is_mutable: boolean; type: RustType }
    return `*${rp.is_mutable ? 'mut' : 'const'} ${renderType(rp.type, depth + 1)}`
  }

  if ('qualified_path' in ty) {
    const qp = ty.qualified_path as { name: string; self_type: RustType; trait_: RustType | null }
    const self_ = renderType(qp.self_type, depth + 1)
    if (qp.trait_) return `<${self_} as ${renderType(qp.trait_, depth + 1)}>::${qp.name}`
    return `${self_}::${qp.name}`
  }

  if ('impl_trait' in ty) {
    const bounds = ty.impl_trait as { trait_bound?: { trait: RustType } }[]
    const parts = bounds.map((b) => (b.trait_bound ? renderType(b.trait_bound.trait, depth + 1) : '?')).join(' + ')
    return `impl ${parts}`
  }

  if ('dyn_trait' in ty) {
    const dt = ty.dyn_trait as { traits: { trait: RustType }[]; lifetime: string | null }
    const parts = dt.traits.map((t) => renderType(t.trait, depth + 1)).join(' + ')
    const lt = dt.lifetime ? ` + '${dt.lifetime}` : ''
    return `dyn ${parts}${lt}`
  }

  if ('function_pointer' in ty) return 'fn(...)'

  return '_'
}

function renderGenerics(generics: Generics): string {
  if (!generics.params.length) return ''
  const params = generics.params.filter((p) => p.kind && !('lifetime' in p.kind)).map((p) => p.name)
  if (!params.length) return ''
  return `<${params.join(', ')}>`
}

// --- Item rendering ---

function renderFunctionSig(name: string, fn_: FunctionData, generics?: Generics): string {
  const parts: string[] = []
  if (fn_.is_const) parts.push('const')
  if (fn_.is_async) parts.push('async')
  if (fn_.is_unsafe) parts.push('unsafe')
  parts.push('fn')

  const gen = generics ? renderGenerics(generics) : renderGenerics(fn_.generics)
  const inputs = fn_.sig.inputs
    .map(([name, ty]) => {
      if (name === 'self') return renderType(ty)
      return `${name}: ${renderType(ty)}`
    })
    .join(', ')

  const output = fn_.sig.output ? ` -> ${renderType(fn_.sig.output)}` : ''
  return `${parts.join(' ')} ${name}${gen}(${inputs})${output}`
}

function renderItemDecl(item: RustdocItem): string | null {
  const inner = item.inner

  if ('function' in inner) {
    return renderFunctionSig(item.name ?? '?', inner.function as FunctionData)
  }

  if ('struct' in inner) {
    const s = inner.struct as { generics: Generics; kind: Record<string, unknown> }
    return `struct ${item.name}${renderGenerics(s.generics)}`
  }

  if ('enum' in inner) {
    const e = inner.enum as { generics: Generics; variants: number[] }
    return `enum ${item.name}${renderGenerics(e.generics)}`
  }

  if ('trait' in inner) {
    const t = inner.trait as { generics: Generics; is_auto: boolean; is_unsafe: boolean }
    const prefix = t.is_unsafe ? 'unsafe ' : ''
    return `${prefix}trait ${item.name}${renderGenerics(t.generics)}`
  }

  if ('type_alias' in inner) {
    const ta = inner.type_alias as { generics: Generics; type: RustType | null }
    const ty = ta.type ? ` = ${renderType(ta.type)}` : ''
    return `type ${item.name}${renderGenerics(ta.generics)}${ty}`
  }

  if ('macro_def' in inner) {
    return `macro ${item.name}!(...)`
  }

  if ('constant' in inner) {
    const c = inner.constant as { type: RustType; value: string | null }
    return `const ${item.name}: ${renderType(c.type)}${c.value ? ` = ${c.value}` : ''}`
  }

  return null
}

/** Rustdoc `inner` is a single-key object naming the item kind. */
function itemKindFromInner(inner: Record<string, unknown>): string {
  return Object.keys(inner)[0] ?? 'unknown'
}

/** Find an item by name in a module, following `use` re-exports. */
function findItemInModule(mod_: RustdocItem, name: string, index: Record<string, RustdocItem>): RustdocItem | null {
  const modData = mod_.inner?.module as { items: number[] } | undefined
  if (!modData?.items) return null

  for (const id of modData.items) {
    const item = index[String(id)]
    if (!item) continue

    // Direct match
    if (item.name === name) return item

    // Re-export: `pub use some::path::Name`
    if ('use' in item.inner) {
      const use_ = item.inner.use as { name: string; id: number | null }
      if (use_.name === name && use_.id != null) {
        const target = index[String(use_.id)]
        if (target) return target
      }
    }
  }
  return null
}

/** Hard ceiling for decompressed rustdoc JSON: a 50 MB compressed payload can expand far enough to block the
 *  event loop or OOM without a cap. Exceeding it throws (RangeError), which the fetch path turns into `null`. */
const MAX_RUSTDOC_GUNZIP_BYTES = 256 * 1024 * 1024

// --- Main handler ---

export const scrapeDocsRs: Scraper = async (ctx) => {
  const target = parseDocsRsUrl(ctx.url)
  if (!target) return null

  const notes = ['Fetched via docs.rs rustdoc JSON']
  let crate_: RustdocCrate | null

  // The gzip variant decompresses natively
  const jsonUrl = `https://docs.rs/crate/${target.crateName}/${target.version}/json.gz`

  try {
    const response = await ctx.loadBinary(jsonUrl, {
      headers: { 'User-Agent': 'chatluna-plugin-omreader', Accept: 'application/gzip' }
    })
    if (!response.ok) return null

    const jsonStr = (await gunzipAsync(response.bytes, { maxOutputLength: MAX_RUSTDOC_GUNZIP_BYTES })).toString('utf-8')
    crate_ = tryParseJson<RustdocCrate>(jsonStr)
  } catch {
    ctx.signal.throwIfAborted()
    return null
  }
  if (!crate_?.index) return null

  const index = crate_.index

  // Find the target module by walking the module path
  let currentItem = index[String(crate_.root)]
  if (!currentItem) return null

  // Walk into submodules (the first segment is the crate name itself)
  const subPath = target.modulePath.slice(1)
  for (const seg of subPath) {
    const modData = currentItem.inner?.module as { items: number[] } | undefined
    if (!modData?.items) return null

    const child = modData.items
      .map((id) => index[String(id)])
      .find((it) => it?.name === seg && 'module' in (it?.inner ?? {}))
    if (!child) return null
    currentItem = child
  }

  // A specific item page
  if (target.itemName) {
    const found = findItemInModule(currentItem, target.itemName, index)
    if (!found) return null

    return { content: renderSingleItem(found, index, crate_), method: 'docs.rs', notes }
  }

  // Module view
  return { content: renderModule(currentItem, index, crate_, target), method: 'docs.rs', notes }
}

// --- Rendering ---

interface RustdocImplData {
  trait?: { path: string; args?: { angle_bracketed?: { args: unknown[] } } } | null
  items: number[]
  is_synthetic?: boolean
  blanket_impl?: RustType | null
}

function collectInherentMethodLines(implIds: number[], index: Record<string, RustdocItem>): string[] {
  const methods: string[] = []
  for (const implId of implIds) {
    const impl_ = index[String(implId)]
    if (!impl_ || !('impl' in impl_.inner)) continue
    const implData = impl_.inner.impl as RustdocImplData
    if (implData.is_synthetic || implData.trait || implData.blanket_impl) continue
    for (const mId of implData.items ?? []) {
      const method = index[String(mId)]
      if (!method?.name || !('function' in method.inner)) continue
      const fn_ = method.inner.function as FunctionData
      const sig = renderFunctionSig(method.name, fn_)
      methods.push(`- \`${sig}\`${method.docs ? ` — ${firstLine(method.docs)}` : ''}`)
    }
  }
  return methods
}

function collectExplicitTraitImplNames(implIds: number[], index: Record<string, RustdocItem>): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const implId of implIds) {
    const impl_ = index[String(implId)]
    if (!impl_ || !('impl' in impl_.inner)) continue
    const implData = impl_.inner.impl as RustdocImplData
    if (implData.is_synthetic || implData.blanket_impl || !implData.trait) continue
    const name = renderType({ resolved_path: { path: implData.trait.path, args: implData.trait.args } })
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

function renderSingleItem(item: RustdocItem, index: Record<string, RustdocItem>, crate_: RustdocCrate): string {
  let md = ''
  const decl = renderItemDecl(item)
  const kind = itemKindFromInner(item.inner)

  md += `# ${kind} ${item.name}\n\n`
  if (item.deprecation) {
    const note = item.deprecation.note ? `: ${item.deprecation.note}` : ''
    md += `> **Deprecated**${note}\n\n`
  }

  if (decl) md += `\`\`\`rust\n${decl}\n\`\`\`\n\n`
  if (item.docs) md += `${item.docs}\n\n`

  // Structs/enums/traits: methods and associated items
  if ('struct' in item.inner || 'enum' in item.inner || 'trait' in item.inner || 'union' in item.inner) {
    // Rustdoc JSON shape: struct/enum/union carry `impls`, traits carry `items`
    const kindData = item.inner[kind] as { impls?: number[]; items?: number[] } | undefined
    const impls = kindData?.impls ?? []
    const traitItems = kindData?.items ?? []

    // Direct trait items (for traits)
    if (traitItems.length > 0) {
      const required: string[] = []
      const provided: string[] = []

      for (const id of traitItems) {
        const child = index[String(id)]
        if (!child) continue
        if ('function' in child.inner) {
          const fn_ = child.inner.function as FunctionData
          const sig = renderFunctionSig(child.name ?? '?', fn_)
          const line = `- \`${sig}\`${child.docs ? ` — ${firstLine(child.docs)}` : ''}`
          if (fn_.has_body) provided.push(line)
          else required.push(line)
        } else if ('assoc_type' in child.inner) {
          const line = `- \`type ${child.name}\`${child.docs ? ` — ${firstLine(child.docs)}` : ''}`
          required.push(line)
        }
      }

      if (required.length) md += `## Required Methods\n\n${required.join('\n')}\n\n`
      if (provided.length) md += `## Provided Methods\n\n${provided.join('\n')}\n\n`
    }

    const methods = collectInherentMethodLines(impls, index)
    if (methods.length) {
      md += `## Methods\n\n${methods.join('\n')}\n\n`
    }

    const traitImpls = collectExplicitTraitImplNames(impls, index)
    if (traitImpls.length) {
      md += `## Trait Implementations\n\n${traitImpls.map((t) => `- ${t}`).join('\n')}\n\n`
    }
  }

  // Enum variants
  if ('enum' in item.inner) {
    const enumData = item.inner.enum as { variants?: number[] }
    const variants = enumData.variants ?? []
    const lines: string[] = []
    for (const vId of variants) {
      const v = index[String(vId)]
      if (!v?.name) continue
      lines.push(`- \`${v.name}\`${v.docs ? ` — ${firstLine(v.docs)}` : ''}`)
    }
    if (lines.length) md += `## Variants\n\n${lines.join('\n')}\n\n`
  }

  if (crate_.crate_version) md += `---\n*${crate_.crate_version}*\n`
  return md
}

const KIND_ORDER = ['module', 'macro_def', 'struct', 'enum', 'trait', 'function', 'type_alias', 'constant', 'static']
const KIND_LABELS: Record<string, string> = {
  module: 'Modules',
  macro_def: 'Macros',
  struct: 'Structs',
  enum: 'Enums',
  trait: 'Traits',
  function: 'Functions',
  type_alias: 'Type Aliases',
  constant: 'Constants',
  static: 'Statics',
  union: 'Unions'
}

function renderModule(
  mod_: RustdocItem,
  index: Record<string, RustdocItem>,
  crate_: RustdocCrate,
  target: DocsRsTarget
): string {
  let md = `# ${target.modulePath.join('::')}\n\n`

  if (mod_.docs) md += `${mod_.docs}\n\n`

  const modData = mod_.inner?.module as { items: number[] } | undefined
  if (!modData?.items) return md

  // Group items by kind, resolving re-exports
  const groups: Record<string, { name: string; docs: string; decl: string | null }[]> = {}
  for (const id of modData.items) {
    let item = index[String(id)]
    if (!item) continue

    // Resolve re-exports
    let displayName = item.name
    if ('use' in item.inner) {
      const use_ = item.inner.use as { name: string; id: number | null }
      displayName = use_.name
      if (use_.id == null) continue
      const resolved = index[String(use_.id)]
      if (!resolved) continue
      item = resolved
    }

    if (!displayName) continue
    // Skip private/hidden items
    if (item.visibility === 'crate' || (typeof item.visibility === 'object' && 'restricted' in item.visibility))
      continue

    const kind = itemKindFromInner(item.inner)
    ;(groups[kind] ??= []).push({
      name: displayName,
      docs: firstLine(item.docs ?? ''),
      decl: renderItemDecl(item)
    })
  }

  for (const kind of KIND_ORDER) {
    const items = groups[kind]
    if (!items?.length) continue
    md += `## ${KIND_LABELS[kind] ?? kind}\n\n`
    for (const item of items) {
      if (item.decl && kind === 'function') {
        md += `- \`${item.decl}\`${item.docs ? ` — ${item.docs}` : ''}\n`
      } else {
        md += `- **${item.name}**${item.docs ? ` — ${item.docs}` : ''}\n`
      }
    }
    md += '\n'
  }

  if (crate_.crate_version) md += `---\n*${crate_.crate_version}*\n`
  return md
}

function firstLine(s: string): string {
  const line = s.split('\n')[0]!.trim()
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}
