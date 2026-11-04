// cheat.sh / cht.sh cheatsheets as plain text (`?T` strips ANSI colors).
import type { Scraper } from './types'

export const scrapeCheatSh: Scraper = async (ctx) => {
  try {
    const parsed = ctx.url
    if (parsed.hostname !== 'cheat.sh' && parsed.hostname !== 'cht.sh') return null

    // Topic: everything after the leading slash (commands, or language/topic like python/list)
    const topic = parsed.pathname.slice(1)
    if (!topic || topic === '/') return null

    const apiUrl = `https://cheat.sh/${encodeURIComponent(topic)}?T`
    const result = await ctx.loadPage(apiUrl, { headers: { Accept: 'text/plain' } })

    if (!result.ok || !result.content.trim()) return null

    const decodedTopic = decodeURIComponent(topic)
    let md = `# cheat.sh/${decodedTopic}\n\n`

    // Plain text: fence it, tagging a language when it looks like code
    const content = result.content.trim()
    const lines = content.split('\n')
    const hasCodeIndicators = lines.some(
      (line) =>
        line.startsWith('$') ||
        line.startsWith('#') ||
        line.includes('()') ||
        line.includes('=>') ||
        /^\s*(if|for|while|def|func|fn|let|const|var)\b/.test(line)
    )

    if (hasCodeIndicators || decodedTopic.includes('/')) {
      // Language from the topic's first segment
      const lang = decodedTopic.split('/')[0] || 'bash'
      md += `\`\`\`${lang}\n${content}\n\`\`\`\n`
    } else {
      md += `\`\`\`\n${content}\n\`\`\`\n`
    }

    return { content: md, method: 'cheat.sh', notes: ['Fetched via cheat.sh'] }
  } catch {
    // Fall through to the generic path.
  }

  return null
}
