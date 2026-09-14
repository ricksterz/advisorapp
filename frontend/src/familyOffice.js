// Firms whose own filed name says "family office" — a name-pattern proxy,
// not a legal classification. Form ADV has no family-office checkbox, so
// this is the only signal available in public filing data.
//
// It structurally can't find most true family offices. A single-family
// office serving only its own family is exempt from registering as an
// investment adviser at all under Advisers Act §202(a)(11)(G), so the
// majority of what a firm like FINTRX tracks through private research never
// files Form ADV and is invisible here by design, not by gap. What shows up
// is the minority that registered anyway — mostly multi-family offices
// serving outside clients, plus single-family offices that fell outside the
// exemption's terms.
const PATTERN = /\bfamily\s+offices?\b/i

export function isFamilyOffice(firm) {
  return PATTERN.test(firm.legal_name || '') || PATTERN.test(firm.business_name || '')
}
