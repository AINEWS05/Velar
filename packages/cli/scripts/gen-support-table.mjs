#!/usr/bin/env node
// Regenerates the SUPPORT-TABLE block in packages/cli/README.md from the
// Adapter Capability Manifest. Run after editing packages/shared/src/capability-manifest.ts.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { applySupportTableToReadme } from '../dist/docs/support-table.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const readmePath = path.join(__dirname, '..', 'README.md')

const current = readFileSync(readmePath, 'utf8')
const next = applySupportTableToReadme(current)
writeFileSync(readmePath, next)

console.log(next === current ? 'README support table already up to date.' : 'README support table regenerated.')
