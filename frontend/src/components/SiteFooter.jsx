import { legalPath, navigate } from '../router.js'

// On every page. The short form of the disclaimer page (LegalPage.jsx);
// sensitive sections add their own notice beside the figures as well.
export default function SiteFooter({ snapshot }) {
  const legal = legalPath()
  return (
    <footer className="site-footer" role="contentinfo">
      <p>
        <strong>For informational purposes only.</strong> Open Disclosure is independent and not
        affiliated with the SEC, FINRA or any firm or person shown. All data is public information
        published by the U.S. government, chiefly the SEC
        {snapshot ? <> (latest firm snapshot {snapshot})</> : null}, and is republished as is: it may be incomplete, out of date or wrong, and it is not
        investment, legal or tax advice or a recommendation of any firm or person. You are
        responsible for how you interpret and use it. A disclosure is not a finding of wrongdoing.
        This site is not a consumer reporting agency; don’t use it for employment, credit,
        insurance or other FCRA decisions. Verify everything on the official{' '}
        <a href="https://adviserinfo.sec.gov/" target="_blank" rel="noreferrer">
          SEC
        </a>{' '}
        and{' '}
        <a href="https://brokercheck.finra.org/" target="_blank" rel="noreferrer">
          FINRA
        </a>{' '}
        records.
      </p>
      <p>
        <a href={legal} onClick={(e) => navigate(e, legal)}>
          Full disclaimer and terms of use
        </a>
      </p>
    </footer>
  )
}
