// Notebooks as editable text: cells as `# %% [type] cell:N` blocks.

const CELL_TYPES: Record<string, true> = { code: true, markdown: true, raw: true }
const ESCAPABLE_MARKER = /^# %%+ \[(?:code|markdown|raw)\](?: cell:\d+)?$/
const UTF8_DECODER = new TextDecoder()

/** Source lines that look like cell markers gain one `%`, so the projection stays unambiguous. */
function escapeMarkerLikeLines(source: string) {
  if (!source.includes('# %%')) return source
  return source
    .split('\n')
    .map((line) => (ESCAPABLE_MARKER.test(line) ? line.replace('# %', '# %%') : line))
    .join('\n')
}

function sourceText(source: unknown) {
  if (typeof source === 'string') return source
  if (Array.isArray(source)) return source.filter((line) => typeof line === 'string').join('')
  return ''
}

/** Notebook JSON bytes as editable cell-marker text; throws model-facing errors on invalid notebooks. */
export function renderNotebook(bytes: Uint8Array, display: string) {
  const json = UTF8_DECODER.decode(bytes).replace(/^\uFEFF/, '')
  let notebook: unknown
  try {
    notebook = JSON.parse(json)
  } catch {
    throw new Error(`Invalid JSON in notebook: ${display}`)
  }
  if (typeof notebook !== 'object' || notebook === null || Array.isArray(notebook)) {
    throw new Error(`Invalid notebook structure (expected object): ${display}`)
  }
  const cells = 'cells' in notebook ? notebook.cells : undefined
  if (!Array.isArray(cells)) throw new Error(`Invalid notebook structure (missing cells array): ${display}`)

  const blocks: string[] = []
  for (const [index, cell] of cells.entries()) {
    const cellType =
      typeof cell === 'object' && cell !== null && !Array.isArray(cell) && 'cell_type' in cell
        ? cell.cell_type
        : undefined
    if (typeof cellType !== 'string' || CELL_TYPES[cellType] !== true) {
      throw new Error(`Invalid notebook cell ${index} in ${display}`)
    }
    const source = escapeMarkerLikeLines(sourceText('source' in cell ? cell.source : undefined))
    const marker = `# %% [${cellType}] cell:${index}`
    blocks.push(source === '' ? marker : `${marker}\n${source}`)
  }
  return blocks.join('\n')
}
