import { legalPath, navigate } from '../router.js'

// On every page. The short form of the disclaimer page (LegalPage.jsx);
// sensitive sections add their own notice beside the figures as well.
export default function SiteFooter({ snapshot }) {
  const legal = legalPath()
  return (
    <footer className="site-footer" role="contentinfo">
      <p>
        <strong>For informational purposes only.</strong> Open Disclosure is an independent
        resource and is not affiliated with the SEC, FINRA or any firm or individual referenced on
        this site. All information is derived from public records published by the U.S. government,
        principally the SEC{snapshot ? <> (latest firm data: {snapshot})</> : null}, and is provided
        as is, without warranty as to its accuracy, completeness or timeliness. It does not
        constitute investment, legal or tax advice, or a recommendation of any firm or individual.
        A disclosure is not a finding of wrongdoing. Open Disclosure is not a consumer reporting
        agency, and the information may not be used for employment, credit, insurance or other
        purposes governed by the FCRA. Users are solely responsible for their interpretation and use
        of the information and should verify it against the official records of the{' '}
        <a href="https://adviserinfo.sec.gov/" target="_blank" rel="noreferrer">
          SEC
        </a>{' '}
        and{' '}
        <a href="https://brokercheck.finra.org/" target="_blank" rel="noreferrer">
          FINRA
        </a>
        .
      </p>
      <p>
        <a href={legal} onClick={(e) => navigate(e, legal)}>
          Full disclaimer and terms of use
        </a>
      </p>
    </footer>
  )
}
