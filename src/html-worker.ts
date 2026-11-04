import { parentPort } from 'node:worker_threads'
import {
  convert,
  WasmConversionOptions,
  WasmPreprocessingOptions,
  WasmPreprocessingPreset,
  WasmTierStrategy
} from '@xberg-io/html-to-markdown-wasm'

// HTML-to-Markdown conversion through the WASM build of the Rust converter.
// The conversion is synchronous, so it runs here where the caller can terminate it.
const port = parentPort
if (!port) throw new Error('html-worker must run inside worker_threads')
port.on('message', (html: string) => {
  try {
    const options = WasmConversionOptions.default()
    options.preprocessing = new WasmPreprocessingOptions(true, WasmPreprocessingPreset.Aggressive, true, true)
    options.tierStrategy = WasmTierStrategy.Tier2
    options.maxDepth = 64
    // convert() consumes options (including preprocessing); handed-over values must not be freed again.
    const result = convert(html, options)
    const warnings = result.warnings
    try {
      const depthWarning = warnings.find((warning) => /depth.*limit/i.test(warning.kind))
      if (depthWarning) throw new Error(depthWarning.message)
      port.postMessage({ content: result.content ?? '' })
    } finally {
      for (const warning of warnings) warning.free()
      result.free()
    }
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
})
