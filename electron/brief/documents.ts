import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { createLogger } from '../lib/log'
import { getPaths } from '../lib/paths'

const log = createLogger('documents')

/**
 * Text extraction for pre-meeting brief attachments.
 *
 * Only local files are read, and the extracted text is stored in SQLite so the
 * brief still works after the original file is moved or deleted.
 */

/** Extensions we can read as plain text. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.rtf', '.sql', '.ini', '.toml'
])

/** Hard ceiling on extracted characters, to keep prompts within context. */
const MAX_CHARS = 20_000

export interface ExtractedDocument {
  path: string
  name: string
  text: string
  /** True when the file could not be read or parsed. */
  failed: boolean
  note: string | null
}

function stripMarkup(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extracts text from a PDF using pdf.js.
 *
 * pdfjs-dist is imported dynamically so a packaging problem with it can never
 * prevent the app from starting.
 */
async function extractPdf(path: string): Promise<string> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (options: Record<string, unknown>) => {
      promise: Promise<{
        numPages: number
        getPage: (index: number) => Promise<{
          getTextContent: () => Promise<{ items: Array<{ str?: string }> }>
        }>
      }>
    }
  }

  const data = new Uint8Array(readFileSync(path))
  const document = await pdfjs.getDocument({
    data,
    // Node has no DOM or web worker; these keep pdf.js in pure-JS mode.
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true
  }).promise

  const pages: string[] = []
  const pageCount = Math.min(document.numPages, 40)

  for (let index = 1; index <= pageCount; index++) {
    const page = await document.getPage(index)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => item.str ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > 0) pages.push(text)
  }

  const joined = pages.join('\n\n')
  return pageCount < document.numPages
    ? `${joined}\n\n(Only the first ${pageCount} of ${document.numPages} pages were read.)`
    : joined
}

export async function extractDocument(path: string): Promise<ExtractedDocument> {
  const name = basename(path)
  const extension = extname(path).toLowerCase()

  if (!existsSync(path)) {
    return { path, name, text: '', failed: true, note: 'File not found.' }
  }

  try {
    const size = statSync(path).size
    if (size > 40 * 1024 * 1024) {
      return { path, name, text: '', failed: true, note: 'File is larger than 40 MB.' }
    }

    let text: string

    if (extension === '.pdf') {
      text = await extractPdf(path)
      if (text.trim().length === 0) {
        // Scanned PDFs have no text layer; OCR is out of scope.
        return {
          path,
          name,
          text: '',
          failed: true,
          note: 'This PDF has no selectable text (it looks like a scan), so nothing could be read.'
        }
      }
    } else if (TEXT_EXTENSIONS.has(extension)) {
      const raw = readFileSync(path, 'utf8')
      text = extension === '.html' || extension === '.htm' ? stripMarkup(raw) : raw.trim()
    } else {
      return {
        path,
        name,
        text: '',
        failed: true,
        note: `Unsupported file type "${extension || 'unknown'}". Attach a PDF or a text file.`
      }
    }

    if (text.length > MAX_CHARS) {
      text = `${text.slice(0, MAX_CHARS)}\n\n(Truncated to the first ${MAX_CHARS.toLocaleString()} characters.)`
    }

    return { path, name, text, failed: false, note: null }
  } catch (error) {
    log.warn(`could not extract ${path}`, error)
    return {
      path,
      name,
      text: '',
      failed: true,
      note: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function extractDocuments(paths: string[]): Promise<ExtractedDocument[]> {
  const results: ExtractedDocument[] = []
  for (const path of paths) {
    results.push(await extractDocument(path))
  }
  return results
}

/**
 * Copies an attachment into the app's own data directory.
 *
 * We copy rather than reference so a brief keeps working if the user moves or
 * deletes the original file.
 */
export function importBriefDocument(sourcePath: string): string {
  const { briefDocsDir } = getPaths()
  if (!existsSync(briefDocsDir)) mkdirSync(briefDocsDir, { recursive: true })

  const name = basename(sourcePath)
  const target = join(briefDocsDir, name)
  copyFileSync(sourcePath, target)
  return target
}

/** Formats extracted documents as prompt context. */
export function documentsToContext(documents: ExtractedDocument[]): string {
  return documents
    .filter((document) => !document.failed && document.text.trim().length > 0)
    .map((document) => `### ${document.name}\n${document.text}`)
    .join('\n\n')
}
