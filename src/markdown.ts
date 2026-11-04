import { Worker } from 'node:worker_threads'

// Built output keeps both bundles in lib/; `chatluna dev` runs src/*.ts, whose worker loads through the
// inherited --import hooks.
const WORKER_URL = new URL(import.meta.url.endsWith('.ts') ? './html-worker.ts' : './html-worker.js', import.meta.url)

/** HTML → Markdown in a throwaway worker, terminated as soon as the caller aborts. */
export async function htmlToMarkdown(html: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const worker = new Worker(WORKER_URL)
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const onAbort = () => reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  worker.on('message', (data: { content?: string; error?: string }) => {
    if (typeof data.content === 'string') resolve(data.content)
    else reject(new Error(data.error ?? 'HTML conversion returned no content'))
  })
  worker.on('error', reject)
  worker.on('exit', (code) => reject(new Error(`HTML converter worker exited with code ${code}`)))
  try {
    worker.postMessage(html)
    return await promise
  } finally {
    signal.removeEventListener('abort', onAbort)
    void worker.terminate()
  }
}
