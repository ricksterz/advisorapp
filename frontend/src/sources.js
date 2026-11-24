// Primary-source links and the Form ADV items each figure comes from. One
// place, so every report, questionnaire and export cites the same documents
// the same way.

export const iapdUrl = (crd) => `https://adviserinfo.sec.gov/firm/summary/${crd}`
export const advPdfUrl = (crd) => `https://reports.adviserinfo.sec.gov/reports/ADV/${crd}/PDF/${crd}.pdf`
export const crsUrl = (crd) => `https://reports.adviserinfo.sec.gov/crs/crs_${crd}.pdf`
export const brochureUrl = (id) =>
  `https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=${id}`
export const firmApiUrl = (crd) => `https://api.adviserinfo.sec.gov/search/firm/${crd}`
export const brokerCheckUrl = (crd) => `https://brokercheck.finra.org/firm/summary/${crd}`

// Where in Form ADV each kind of figure is reported. Shown beside figures so
// a reader can find the same answer in the filing itself.
export const ITEMS = {
  aum: 'Form ADV Part 1A, Item 5.F',
  staff: 'Form ADV Part 1A, Item 5.A–5.B',
  accounts: 'Form ADV Part 1A, Item 5.F',
  clients: 'Form ADV Part 1A, Item 5.D',
  fees: 'Form ADV Part 1A, Item 5.E',
  feeSchedule: 'Form ADV Part 2A (brochure), Item 5',
  otherActivities: 'Form ADV Part 1A, Item 6',
  affiliations: 'Form ADV Part 1A, Item 7.A',
  privateFunds: 'Form ADV Schedule D, Section 7.B.1',
  disclosures: 'Form ADV Part 1A, Item 11 and Disclosure Reporting Pages',
  owners: 'Form ADV Schedules A and B',
  brochure: 'Form ADV Part 2A brochure',
  supplement: 'Form ADV Part 2B brochure supplement',
  crs: 'Form CRS (client relationship summary)',
  holdings: 'SEC Form 13F (EDGAR)',
  history: 'SEC registered-adviser reports and Form ADV quarterly snapshots',
}

/** The standard source list for one firm: [{ label, href, note }]. */
export function firmSources(crd, { brochures = [], crs = null, advPdf = null } = {}) {
  const out = [
    { label: 'SEC Investment Adviser Public Disclosure (IAPD) profile', href: iapdUrl(crd), note: 'Official record; check it before relying on anything here' },
  ]
  if (advPdf) out.push({ label: 'Form ADV, full filing (PDF)', href: advPdf, note: 'Parts 1A and Schedules, as last filed' })
  if (crs) out.push({ label: 'Form CRS relationship summary (PDF)', href: crs, note: 'Fees, services and conflicts in plain language' })
  for (const b of brochures) {
    out.push({ label: `Brochure: ${b.name}`, href: brochureUrl(b.id), note: b.date ? `Submitted ${b.date}` : 'Form ADV Part 2A' })
  }
  out.push({ label: 'FINRA BrokerCheck', href: brokerCheckUrl(crd), note: 'Broker-dealer registrations and individual records' })
  return out
}
