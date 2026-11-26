import { track } from './analytics.js'

// CSV export for the watchlist, comparisons, benchmarks and questionnaires.
//
// Cells are RFC 4180-quoted, and any cell a spreadsheet would read as a
// formula (=, +, -, @, tab, CR) is prefixed with an apostrophe. Firm names
// come from the firms' own filings and notes from the person typing them, so
// neither is trusted not to start with "=HYPERLINK(...)" — and negative
// numbers are written by this code as numbers, never as strings, so they
// keep their sign.

const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value) {
  if (value == null) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  let s = String(value)
  if (FORMULA_START.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** rows: array of arrays; the first row is usually the header. */
export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/** A filesystem-safe name: "Open Disclosure watchlist 2026-11-23.csv". */
export function csvFileName(label, date = new Date()) {
  const day = date.toISOString().slice(0, 10)
  const safe = String(label).replace(/[^\w\- ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return `${safe || 'export'} ${day}.csv`
}

/** Hand the CSV to the browser as a download. Browser-only. */
export function downloadCsv(rows, label, contentType = 'other') {
  track('export_csv', { content_type: contentType })
  // BOM so Excel opens UTF-8 names (accents, curly quotes) correctly.
  const blob = new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = csvFileName(label)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
