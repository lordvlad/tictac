import fs from 'node:fs'
import path from 'node:path'

let errors = 0
let warnings = 0

console.info('[lint:docs] Starting documentation validation...')

// 1. Validate JSON Schemas
const schemaDir = path.resolve(process.cwd(), 'docs/schemas')
if (fs.existsSync(schemaDir)) {
  const schemaFiles = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.json'))
  for (const sf of schemaFiles) {
    const fullPath = path.join(schemaDir, sf)
    try {
      const content = fs.readFileSync(fullPath, 'utf-8')
      JSON.parse(content)
      console.info(`  ✓ Valid JSON schema: docs/schemas/${sf}`)
    } catch (err) {
      console.error(`  ✗ Invalid JSON schema in docs/schemas/${sf}:`, err)
      errors++
    }
  }
}

// 2. Discover all Markdown files
function getMarkdownFiles(dir: string): string[] {
  let results: string[] = []
  if (!fs.existsSync(dir)) return results
  const list = fs.readdirSync(dir)
  for (const file of list) {
    if (file === 'node_modules' || file === '.git' || file === 'dist') continue
    const filePath = path.join(dir, file)
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      results = results.concat(getMarkdownFiles(filePath))
    } else if (file.endsWith('.md')) {
      results.push(filePath)
    }
  }
  return results
}

const docFiles = getMarkdownFiles(path.resolve(process.cwd(), 'docs'))
const rootFiles = ['README.md', 'TODO.md', 'vite-to-bun-migration-guide.md']
  .map((f) => path.resolve(process.cwd(), f))
  .filter((f) => fs.existsSync(f))

const allMdFiles = [...rootFiles, ...docFiles]
console.info(`  ℹ Checking ${allMdFiles.length} markdown documents for link and metadata validity...`)

// 3. Link resolution & frontmatter verification
const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
const requiredFrontmatterFields = ['title', 'id', 'type', 'status', 'lastReviewed']

for (const filePath of allMdFiles) {
  const relPath = path.relative(process.cwd(), filePath)
  const content = fs.readFileSync(filePath, 'utf-8')

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
    if (!fs.existsSync(resolvedTarget)) {
      console.error(
        `  ✗ Broken link in ${relPath}: [${match[1]}](${rawTarget}) -> resolved to non-existent path: ${path.relative(process.cwd(), resolvedTarget)}`
      )
      errors++
    }
  }
}

console.info(`[lint:docs] Finished with ${errors} error(s) and ${warnings} warning(s).`)

if (errors > 0) {
  process.exit(1)
} else {
  process.exit(0)
}
