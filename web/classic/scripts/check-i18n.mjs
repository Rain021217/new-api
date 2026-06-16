/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

/*
 * i18n completeness validator (classic theme).
 *
 * Extracts every literal key passed to t('...') / t("...") / t(`...`) in the
 * theme source, then verifies each used key exists in EVERY locale file.
 * Exits non-zero if any used key is missing from any locale so CI fails.
 *
 * Source keys for the classic theme are the CHINESE strings; the base locale
 * is zh.json. The check is intentionally MISSING-KEY only — it does NOT flag
 * value===key "untranslated" entries (too many legitimate brand/cognate cases
 * such as OAuth, Passkey, 名称, etc.).
 *
 * Run from web/classic/:  node scripts/check-i18n.mjs   (or: bun run i18n:check)
 */
import fs from 'node:fs/promises'
import path from 'node:path'

// This script is executed from the theme package root (see package.json script).
const LOCALES_DIR = path.resolve('src/i18n/locales')
const SRC_DIR = path.resolve('src')

// Directories under SRC_DIR that never contain component t() calls.
const SKIP_DIRS = new Set(['node_modules', '.git', 'locales', '_reports', '_extras'])

// Source file extensions to scan.
const SRC_FILE_RE = /\.(tsx?|jsx?|mts|cts)$/

// i18next plural / ordinal suffixes. A t('base') call is satisfied when the
// locale stores the base key OR any plural variant (base_one, base_other, ...).
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other']

// Matches the first string argument of a t() call where that argument is a
// single-quoted, double-quoted, or back-ticked string literal with no
// interpolation. \bt\( ensures we match the t() function and not the trailing
// letter of put(/get(/post(/format( etc. Template literals containing ${...}
// are deliberately excluded (dynamic keys cannot be statically resolved).
const T_CALL_RE = /\bt\(\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g

async function walkDir(dir) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...(await walkDir(full)))
    } else if (SRC_FILE_RE.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function isInterpolated(key) {
  // Template-literal interpolation or leftover placeholder syntax => dynamic.
  return key.includes('${')
}

function unescape(raw) {
  // Best-effort un-escaping of common JS string escapes so the extracted key
  // matches the literal text stored in the JSON locale files.
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\(['"`\\])/g, '$1')
}

// Collect every distinct usage key and the files it appears in.
async function collectUsedKeys(files) {
  const used = new Map() // key -> Set<relPath>
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8')
    const rel = path.relative(SRC_DIR, file)
    T_CALL_RE.lastIndex = 0
    let m
    while ((m = T_CALL_RE.exec(content)) !== null) {
      const raw = m[2]
      if (isInterpolated(raw)) continue
      const key = unescape(raw)
      if (key.length === 0) continue
      if (!used.has(key)) used.set(key, new Set())
      used.get(key).add(rel)
    }
  }
  return used
}

async function loadLocales() {
  const entries = await fs.readdir(LOCALES_DIR, { withFileTypes: true })
  const localeFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))

  const locales = {} // localeName -> Set<key>
  for (const filename of localeFiles) {
    const locale = filename.replace(/\.json$/i, '')
    const raw = await fs.readFile(path.join(LOCALES_DIR, filename), 'utf8')
    let json
    try {
      json = JSON.parse(raw)
    } catch (err) {
      throw new Error(`Failed to parse ${filename}: ${err.message}`)
    }
    const trans = json && typeof json.translation === 'object' && json.translation !== null ? json.translation : {}
    locales[locale] = new Set(Object.keys(trans))
  }
  return locales
}

// A key is present in a locale if the exact key exists, or any plural variant
// (key_one, key_other, ...) exists.
function hasKey(localeKeys, key) {
  if (localeKeys.has(key)) return true
  for (const suffix of PLURAL_SUFFIXES) {
    if (localeKeys.has(`${key}_${suffix}`)) return true
  }
  return false
}

async function main() {
  const files = await walkDir(SRC_DIR)
  const used = await collectUsedKeys(files)
  const locales = await loadLocales()
  const localeNames = Object.keys(locales)

  if (localeNames.length === 0) {
    console.error(`No locale files found in ${LOCALES_DIR}`)
    process.exitCode = 1
    return
  }

  // missingByLocale: locale -> Map<key, Set<file>>
  const missingByLocale = new Map()
  let totalMissingPairs = 0

  for (const [key, fileSet] of used) {
    for (const locale of localeNames) {
      if (!hasKey(locales[locale], key)) {
        if (!missingByLocale.has(locale)) missingByLocale.set(locale, new Map())
        missingByLocale.get(locale).set(key, fileSet)
        totalMissingPairs++
      }
    }
  }

  // Summary header.
  console.log('i18n completeness check (classic theme)')
  console.log(`  source dir : ${path.relative(process.cwd(), SRC_DIR)}`)
  console.log(`  source files scanned : ${files.length}`)
  console.log(`  literal t() keys used : ${used.size}`)
  console.log(`  locales : ${localeNames.join(', ')}`)
  console.log('')

  if (missingByLocale.size === 0) {
    console.log(`PASS: all ${used.size} used keys exist in every locale.`)
    return
  }

  // Distinct keys missing from at least one locale.
  const distinctMissing = new Set()
  for (const map of missingByLocale.values()) {
    for (const k of map.keys()) distinctMissing.add(k)
  }

  console.log('FAIL: missing translation keys detected.')
  console.log('')
  for (const locale of localeNames) {
    const map = missingByLocale.get(locale)
    if (!map || map.size === 0) continue
    console.log(`  [${locale}] missing ${map.size} key(s):`)
    const sortedKeys = [...map.keys()].sort((a, b) => a.localeCompare(b))
    for (const key of sortedKeys) {
      const fileList = [...map.get(key)].sort((a, b) => a.localeCompare(b))
      console.log(`    "${key}"`)
      for (const f of fileList) console.log(`        used in: ${f}`)
    }
    console.log('')
  }

  console.log(
    `Summary: ${distinctMissing.size} distinct key(s) missing across ` +
      `${missingByLocale.size} locale(s) (${totalMissingPairs} key/locale gaps).`,
  )
  console.log(
    'Note: dynamically-built keys — t(`...${x}...`) and computed strings — are ' +
      'not statically extracted and therefore not validated.',
  )
  process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
