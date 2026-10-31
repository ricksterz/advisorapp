import { useEffect } from 'react'

import { BASE, navigate } from '../router.js'

// The site's full disclaimer and terms of use. Every page's footer links here,
// and the short notices placed beside sensitive figures (disclosure flags,
// outlier list, advisor search) summarize it. Keep LAST_UPDATED current when
// the text changes. Mirrored for crawlers by etl/gen_static_pages.py.
export const LAST_UPDATED = 'October 30, 2026'

const IAPD = 'https://adviserinfo.sec.gov/'
const BROKERCHECK = 'https://brokercheck.finra.org/'

function Section({ id, title, children }) {
  return (
    <section id={id} className="legal-section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

export default function LegalPage() {
  useEffect(() => {
    const previous = document.title
    document.title = 'Disclaimer and terms of use · Open Disclosure'
    return () => {
      document.title = previous
    }
  }, [])

  return (
    <article className="legal-page">
      <div className="page-head">
        <h1>Disclaimer and terms of use</h1>
        <p className="page-tagline">Read this before relying on anything on this site.</p>
        <p>Last updated {LAST_UPDATED}. By using Open Disclosure you accept these terms.</p>
      </div>

      <Section id="summary" title="In short">
        <ul>
          <li>
            Everything on this site is <strong>for informational purposes only</strong>. How you
            interpret and use it is up to you: Open Disclosure is{' '}
            <strong>not responsible for any interpretation or misinterpretation</strong> of the
            information, or for any decision made on the basis of it.
          </li>
          <li>
            All of the underlying data is <strong>public information published by the U.S.
            government</strong>, chiefly the Securities and Exchange Commission. Nothing here is
            proprietary or non-public: anyone can obtain the same records from the same sources.
          </li>
          <li>
            Open Disclosure republishes and analyzes <strong>public regulatory filings</strong>. It
            is independent and is not affiliated with, endorsed by or acting for the SEC, FINRA, any
            state regulator, or any firm or person shown here.
          </li>
          <li>
            The information may be <strong>incomplete, out of date or wrong</strong>, whether in the
            filings themselves or in how this site processes them. It is provided “as is”, with no
            warranty.
          </li>
          <li>
            Nothing here is <strong>investment, legal, tax or other professional advice</strong>, or
            a recommendation, rating or endorsement of any firm or person.
          </li>
          <li>
            A <strong>disclosure is not a finding of wrongdoing</strong>. It can be an allegation, a
            pending or dismissed matter, or a settlement without admission.
          </li>
          <li>
            This site is <strong>not a consumer reporting agency</strong>. Do not use it to decide
            anyone’s eligibility for employment, credit, insurance, housing or any other purpose
            covered by the Fair Credit Reporting Act.
          </li>
          <li>
            Always <strong>check the official record</strong> on the SEC’s{' '}
            <a href={IAPD} target="_blank" rel="noreferrer">
              Investment Adviser Public Disclosure
            </a>{' '}
            site and FINRA’s{' '}
            <a href={BROKERCHECK} target="_blank" rel="noreferrer">
              BrokerCheck
            </a>{' '}
            before making any decision.
          </li>
        </ul>
      </Section>

      <Section id="independence" title="Independence">
        <p>
          Open Disclosure is an independent research project. It is not affiliated with, sponsored
          by, licensed by or endorsed by the U.S. Securities and Exchange Commission, the Financial
          Industry Regulatory Authority, the North American Securities Administrators Association,
          any state securities regulator, or any investment adviser, broker-dealer, fund or person
          that appears on the site. It receives no payment from any firm shown, and no firm can pay
          to change how it appears. Open Disclosure is not a registered investment adviser or
          broker-dealer.
        </p>
      </Section>

      <Section id="sources" title="Where the data comes from">
        <p>
          All of the data on this site is publicly available. It comes from records the U.S.
          Securities and Exchange Commission publishes for anyone to download, and Open Disclosure
          uses no proprietary, licensed or non-public data. The site organizes, combines and
          summarizes those public records; its counts, percentiles, segments, scores and growth
          figures are calculations that anyone could reproduce from the same sources. The only
          material not from a government source is each firm’s website address and logo, which are
          found automatically on the public web.
        </p>
        <p>
          The site is built from public data published by U.S. regulators, chiefly: Form ADV filed
          by investment advisers (including Schedules A, B and D, Part 2 brochures and Disclosure
          Reporting Pages) and the SEC’s bulk feeds of registered advisers and individual
          representatives; Form 13F holdings reports; and Form D notices of exempt offerings. Firm
          websites and logos are located automatically and may be wrong. Each page and section
          states its source and the period it covers.
        </p>
        <p>
          Filings are completed by the firms themselves. Regulators do not verify most of their
          contents, and Open Disclosure does not either. Figures can be stale between a firm’s
          amendments, and some sections cover only filings made within a stated period. Regulatory
          assets under management (AUM) is a figure defined by SEC rules; it is not the same as
          assets a firm may describe elsewhere, and it is not a measure of performance or of client
          wealth.
        </p>
      </Section>

      <Section id="accuracy" title="No warranty">
        <p>
          The information is provided “as is” and “as available”, without warranties of any kind,
          express or implied, including warranties of accuracy, completeness, timeliness,
          merchantability, fitness for a particular purpose and non-infringement. Errors can arise
          in the original filings, in the regulators’ bulk data, and in the way this site collects,
          matches, combines, deduplicates, summarizes or labels it. Matches between data sets (for
          example a firm’s 13F filing, its website, or an individual’s employer) are made
          automatically and can be wrong. Counts, percentiles, segments, scores and growth figures
          are derived by this site, not reported by regulators.
        </p>
      </Section>

      <Section id="informational" title="For informational purposes only">
        <p>
          The site and everything on it are provided for general informational purposes only. You
          are solely responsible for how you interpret, evaluate and use the information. Open
          Disclosure is not responsible for any interpretation or misinterpretation of the
          information by you or anyone else, for any conclusions drawn from it, or for any action
          taken or not taken in reliance on it.
        </p>
      </Section>

      <Section id="not-advice" title="Not advice, not a recommendation">
        <p>
          Nothing on this site is investment, financial, legal, tax, accounting or other
          professional advice, an offer or solicitation to buy or sell any security, or a
          recommendation to engage, retain or avoid any firm or person. Rankings, standing scores,
          “disclosure outliers”, growth leaderboards, peer comparisons, business-model segments and
          tags are informational screens built from public data under a published, adjustable
          methodology. They are not ratings, credit or due-diligence opinions, endorsements or
          warnings, and they leave out most of what matters when choosing an adviser, such as
          services, fees actually charged, investment results, conflicts in practice and fit with
          your needs. Consult a qualified professional and do your own research before making any
          financial decision.
        </p>
      </Section>

      <Section id="disclosures" title="Disclosures and disciplinary history">
        <p>
          Disclosure information comes from what firms and individuals report to regulators. A
          disclosure may describe an allegation, an investigation, a matter that is pending,
          dismissed, settled without admitting or denying the allegations, overturned on appeal,
          or resolved in the person’s or firm’s favor. Form ADV Item 11 asks about the firm{' '}
          <em>and all of its advisory affiliates</em>, so a large firm can report matters that
          concern other companies in its group. The bulk data for individuals shows only whether a
          category of disclosure exists, without dates or details. A disclosure, a flag, a count or
          a place on any list is therefore <strong>not a finding or suggestion of wrongdoing</strong>{' '}
          by any firm or person, and must not be read as one. The complete and authoritative record
          is on the SEC’s{' '}
          <a href={IAPD} target="_blank" rel="noreferrer">
            IAPD
          </a>{' '}
          site and FINRA’s{' '}
          <a href={BROKERCHECK} target="_blank" rel="noreferrer">
            BrokerCheck
          </a>
          .
        </p>
      </Section>

      <Section id="fcra" title="Not a consumer reporting agency">
        <p>
          Open Disclosure is not a consumer reporting agency, and the information on this site is
          not a consumer report as defined by the Fair Credit Reporting Act (FCRA). You may not use
          it, in whole or in part, as a factor in deciding any person’s eligibility for employment,
          credit, insurance, housing, a license or any other purpose covered by the FCRA or similar
          state laws. Employers and others with a permissible purpose should use FINRA’s and the
          SEC’s official records or a consumer reporting agency that complies with the FCRA.
        </p>
      </Section>

      <Section id="individuals" title="Information about individuals">
        <p>
          Names, employers, registration history, branch locations, professional designations and
          disclosure categories of individual representatives are republished from regulators’
          public records, which exist so the public can check who they deal with. They may be out
          of date: a person may have changed firms, retired or had a matter resolved since the data
          was published. Use this information only to research a financial professional, not to
          contact, harass, profile or make decisions about anyone.
        </p>
      </Section>

      <Section id="corrections" title="Corrections">
        <p>
          The site reflects regulatory filings as published. A firm or individual who believes a
          record is wrong should correct it at the source: firms by amending Form ADV, individuals
          through their firm or through FINRA’s dispute process for BrokerCheck information. The
          change will appear here after the next data refresh. Errors in how this site processes or
          presents the data can be reported through the project’s public repository on GitHub.
        </p>
      </Section>

      <Section id="third-parties" title="Third-party names, trademarks and links">
        <p>
          Firm names, fund names, logos and other marks belong to their owners and are used only to
          identify the subject of public filings; their use does not imply any affiliation or
          endorsement. Logos are fetched automatically from public icon services and may be
          incorrect. References to other publications, rankings or data providers describe
          comparable methodologies and do not imply affiliation. Links to other websites are
          provided for convenience; Open Disclosure is not responsible for their content.
        </p>
      </Section>

      <Section id="liability" title="Limitation of liability">
        <p>
          To the fullest extent permitted by law, Open Disclosure and its contributors are not
          liable for any loss or damage of any kind, direct, indirect, incidental, consequential or
          otherwise, arising from use of or reliance on this site or its information, including
          decisions made or actions taken on that basis, and from any interpretation or
          misinterpretation of the information. Your use of the site is at your own risk.
        </p>
      </Section>

      <Section id="changes" title="Changes">
        <p>
          These terms and the site’s methodology may change at any time; the date at the top shows
          the latest revision. Continued use of the site means you accept the current version.
        </p>
      </Section>

      <p className="detail-note">
        <a href={BASE} onClick={(e) => navigate(e, BASE)}>
          Back to Open Disclosure
        </a>
      </p>
    </article>
  )
}
