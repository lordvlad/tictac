import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

let errors = 0
let warnings = 0

console.info('[lint:docs] Starting documentation validation...')

// 1. Validate JSON Schemas using Bun.file
const schemaDir = path.resolve(process.cwd(), 'docs/schemas')
try {
  const schemaDirStat = await stat(schemaDir)
  if (schemaDirStat.isDirectory()) {
    const dirEntries = await readdir(schemaDir)
    const schemaFiles = dirEntries.filter((f) => f.endsWith('.json'))
    for (const sf of schemaFiles) {
      const fullPath = path.join(schemaDir, sf)
      try {
        const file = Bun.file(fullPath)
        await file.json()
        console.info(`  ✓ Valid JSON schema: docs/schemas/${sf}`)
      } catch (err) {
        console.error(`  ✗ Invalid JSON schema in docs/schemas/${sf}:`, err)
        errors++
      }
    }
  }
} catch {
  // schema directory not found
}

// 2. Discover all Markdown files asynchronously
async function getMarkdownFiles(dir: string): Promise<string[]> {
  let results: string[] = []
  try {
    const list = await readdir(dir)
    for (const file of list) {
      if (file === 'node_modules' || file === '.git' || file === 'dist') continue
      const filePath = path.join(dir, file)
      const fileStat = await stat(filePath)
      if (fileStat.isDirectory()) {
        const subFiles = await getMarkdownFiles(filePath)
        results = results.concat(subFiles)
      } else if (file.endsWith('.md')) {
        results.push(filePath)
      }
    }
  } catch {
    // ignore inaccessible dirs
  }
  return results
}

const docFiles = await getMarkdownFiles(path.resolve(process.cwd(), 'docs'))
const potentialRootFiles = ['README.md', 'AGENTS.md', 'vite-to-bun-migration-guide.md'].map((f) =>
  path.resolve(process.cwd(), f)
)

const rootFiles: string[] = []
for (const rf of potentialRootFiles) {
  if (await Bun.file(rf).exists()) {
    rootFiles.push(rf)
  }
}

const allMdFiles = [...rootFiles, ...docFiles]
console.info(`  ℹ Checking ${allMdFiles.length} markdown documents for link and metadata validity...`)

// 3. Link resolution & frontmatter verification
const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
const requiredFrontmatterFields = ['title', 'id', 'type', 'status', 'lastReviewed']

for (const filePath of allMdFiles) {
  const relPath = path.relative(process.cwd(), filePath)
  const file = Bun.file(filePath)
  const content = await file.text()

  // Check frontmatter on documents inside docs/ (excluding top-level README and schemas)
  if (
    relPath.startsWith('docs/') &&
    !relPath.endsWith('README.md') &&
    !relPath.startsWith('docs/schemas/') &&
    !relPath.endsWith('PLAN.md')
  ) {
    if (content.startsWith('---')) {
      const endIndex = content.indexOf('---', 3)
      if (endIndex === -1) {
        console.error(`  ✗ Unclosed frontmatter block in ${relPath}`)
        errors++
      } else {
        const frontmatterBlock = content.slice(3, endIndex)
        for (const field of requiredFrontmatterFields) {
          const fieldRegex = new RegExp(`^${field}:`, 'm')
          if (!fieldRegex.test(frontmatterBlock)) {
            console.error(`  ✗ Missing required frontmatter field '${field}' in ${relPath}`)
            errors++
          }
        }
      }
    } else {
      console.warn(`  ⚠ Warning: Missing frontmatter header in ${relPath}`)
      warnings++
    }
  }

  // Check relative Markdown links
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(content)) !== null) {
    const rawTarget = match[2].trim()

    // Skip external URLs, mailto, and pure in-page anchors
    if (
      rawTarget.startsWith('http://') ||
      rawTarget.startsWith('https://') ||
      rawTarget.startsWith('mailto:') ||
      rawTarget.startsWith('#')
    ) {
      continue
    }

    const [targetPath] = rawTarget.split('#')
    if (!targetPath) continue

    const resolvedTarget = path.resolve(path.dirname(filePath), targetPath)
    const targetFile = Bun.file(resolvedTarget)
    const exists = await targetFile.exists()

    if (!exists) {
      // Check if it might be a directory
      let isDir = false
      try {
        const targetStat = await stat(resolvedTarget)
        isDir = targetStat.isDirectory()
      } catch {
        isDir = false
      }

      if (!isDir) {
        console.error(
          `  ✗ Broken link in ${relPath}: [${match[1]}](${rawTarget}) -> resolved to non-existent path: ${path.relative(process.cwd(), resolvedTarget)}`
        )
        errors++
      }
    }
  }
}

console.info(`[lint:docs] Finished with ${errors} error(s) and ${warnings} warning(s).`)

if (errors > 0) {
  process.exit(1)
} else {
  process.exit(0)
}
