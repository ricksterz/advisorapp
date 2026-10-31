import { useEffect } from 'react'

import { BASE, navigate } from '../router.js'

// The site's full disclaimer and terms of use. Every page's footer links here,
// and the short notices placed beside sensitive figures (disclosure flags,
// outlier list, advisor search) summarize it. Keep LAST_UPDATED current when
// the text changes. Mirrored for crawlers by etl/gen_static_pages.py.
export const LAST_UPDATED = 'October 30, 2026'

const IAPD = 'https://adviserinfo.sec.gov/'
const BROKERCHECK = 'https://brokercheck.finra.org/'

function Section({ id, n, title, children }) {
  return (
    <section id={id} className="legal-section">
      <h2>
        {n}. {title}
      </h2>
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
        <p className="page-tagline">Important information regarding the use of this website</p>
        <p>
          Last updated {LAST_UPDATED}. Access to and use of Open Disclosure (the “Site”) are subject
          to the terms set out below. By accessing or using the Site, you acknowledge that you have
          read, understood and agree to be bound by these terms. If you do not agree, you should not
          use the Site.
        </p>
      </div>

      <section id="summary" className="legal-section legal-summary">
        <h2>Summary</h2>
        <ul>
          <li>
            The Site and all information on it (the “Information”) are provided{' '}
            <strong>for informational purposes only</strong>.
          </li>
          <li>
            The Information is derived exclusively from <strong>public records published by the
            U.S. government</strong>, principally the Securities and Exchange Commission. The Site
            contains no proprietary or non-public data.
          </li>
          <li>
            The Information is provided <strong>“as is”, without warranty</strong>, and may be
            incomplete, inaccurate or out of date.
          </li>
          <li>
            The Information does not constitute <strong>investment, legal, tax or other
            professional advice</strong>, or a recommendation, rating or endorsement of any firm or
            individual.
          </li>
          <li>
            A disclosure or disciplinary record <strong>is not a finding of wrongdoing</strong>.
          </li>
          <li>
            Open Disclosure is <strong>not a consumer reporting agency</strong>, and the Information
            may not be used for any purpose governed by the Fair Credit Reporting Act.
          </li>
          <li>
            Users are <strong>solely responsible for their interpretation and use</strong> of the
            Information, and should verify it against the official records maintained by the{' '}
            <a href={IAPD} target="_blank" rel="noreferrer">
              SEC
            </a>{' '}
            and{' '}
            <a href={BROKERCHECK} target="_blank" rel="noreferrer">
              FINRA
            </a>
            .
          </li>
        </ul>
      </section>

      <Section id="informational" n={1} title="Informational purposes only">
        <p>
          The Site and the Information are provided solely for general informational purposes. Users
          are solely responsible for how they interpret, evaluate and use the Information. Open
          Disclosure accepts no responsibility for any interpretation or misinterpretation of the
          Information by any person, for any conclusion drawn from it, or for any action taken or
          omitted in reliance on it.
        </p>
      </Section>

      <Section id="independence" n={2} title="Independence">
        <p>
          Open Disclosure is an independent research resource. It is not affiliated with, sponsored
          by, licensed by or endorsed by the U.S. Securities and Exchange Commission (SEC), the
          Financial Industry Regulatory Authority (FINRA), the North American Securities
          Administrators Association, any state securities regulator, or any investment adviser,
          broker-dealer, fund or individual referenced on the Site. Open Disclosure receives no
          compensation from any firm or individual referenced on the Site, and no firm or individual
          may pay to influence its presentation. Open Disclosure is not a registered investment
          adviser or broker-dealer.
        </p>
      </Section>

      <Section id="sources" n={3} title="Sources of information">
        <p>
          All data presented on the Site is publicly available. It is obtained from records that the
          SEC publishes for unrestricted public access, including Form ADV filed by investment
          advisers (with its schedules, Part 2 brochures and Disclosure Reporting Pages), the SEC’s
          bulk data on registered advisers and their representatives, Form 13F holdings reports and
          Form D notices of exempt offerings. Open Disclosure does not use proprietary, licensed or
          non-public data. The Site organizes, combines and summarizes these public records; any
          counts, percentiles, segments, scores and growth figures it presents are calculations that
          may be reproduced by any person from the same public sources. The sole exception is the
          website address and logo associated with each firm, which are identified automatically
          from the public internet and may be incorrect.
        </p>
        <p>
          Regulatory filings are prepared by the filing firms and individuals. Their contents are
          generally not verified by regulators, and they are not independently verified by Open
          Disclosure. Information may be out of date between filings, and certain sections cover
          only filings made within a stated period. Regulatory assets under management is a measure
          defined by SEC rules; it is not a measure of investment performance or of client wealth,
          and it may differ from figures a firm presents elsewhere.
        </p>
      </Section>

      <Section id="warranty" n={4} title="No warranty">
        <p>
          The Site and the Information are provided on an “as is” and “as available” basis, without
          representations or warranties of any kind, whether express or implied, including without
          limitation warranties of accuracy, completeness, timeliness, merchantability, fitness for a
          particular purpose and non-infringement. Errors may arise in the original filings, in the
          regulators’ published data, or in the collection, matching, combination,
          de-duplication, summarization or labeling of that data by the Site. Associations between
          data sets, such as a firm’s 13F filing, website or an individual’s employer, are made
          automatically and may be inaccurate.
        </p>
      </Section>

      <Section id="not-advice" n={5} title="No advice or recommendation">
        <p>
          Nothing on the Site constitutes investment, financial, legal, tax, accounting or other
          professional advice; an offer or solicitation to buy or sell any security; or a
          recommendation to engage, retain or avoid any firm or individual. Rankings, standing
          scores, disclosure outlier lists, growth leaderboards, peer comparisons, business-model
          segments and related tags are informational screens derived from public data under a
          published and adjustable methodology. They are not ratings, credit or due-diligence
          opinions, endorsements or warnings, and they omit many factors relevant to the selection
          of an adviser, including the services provided, fees actually charged, investment results
          and suitability. Users should consult a qualified professional and conduct their own
          research before making any financial decision.
        </p>
      </Section>

      <Section id="disclosures" n={6} title="Disclosures and disciplinary history">
        <p>
          Disclosure information reflects matters reported by firms and individuals to regulators.
          A reported matter may be an allegation, an investigation, or a proceeding that is pending,
          dismissed, settled without admission or denial of the allegations, overturned on appeal,
          or resolved in favor of the firm or individual. Form ADV Item 11 requires a firm to report
          matters concerning the firm <em>and each of its advisory affiliates</em>; accordingly, a
          firm may report matters relating to other entities within its corporate group. Bulk data
          concerning individuals indicates only whether a category of disclosure exists, without
          dates or details. The presence of a disclosure, flag or count, or the inclusion of a firm
          or individual in any list, <strong>does not constitute or imply a finding of
          wrongdoing</strong> and should not be construed as such. Complete and authoritative records
          are available from the SEC’s{' '}
          <a href={IAPD} target="_blank" rel="noreferrer">
            Investment Adviser Public Disclosure
          </a>{' '}
          website and FINRA’s{' '}
          <a href={BROKERCHECK} target="_blank" rel="noreferrer">
            BrokerCheck
          </a>
          .
        </p>
      </Section>

      <Section id="fcra" n={7} title="Not a consumer reporting agency">
        <p>
          Open Disclosure is not a consumer reporting agency, and the Information is not a consumer
          report, as those terms are defined in the Fair Credit Reporting Act (FCRA). The Information
          may not be used, in whole or in part, as a factor in determining any individual’s
          eligibility for employment, credit, insurance, housing, licensing or any other purpose
          covered by the FCRA or comparable state law. Persons with a permissible purpose should rely
          on the official records of the SEC and FINRA or on a consumer reporting agency that
          complies with the FCRA.
        </p>
      </Section>

      <Section id="individuals" n={8} title="Information concerning individuals">
        <p>
          Names, employers, registration history, branch locations, professional designations and
          disclosure categories of individual representatives are republished from public regulatory
          records maintained to enable investors to research financial professionals. Such
          information may be out of date; an individual may have changed firms or retired, or a
          matter may have been resolved, since the data was published. The Information may be used
          only to research financial professionals and may not be used to contact, harass or profile
          any individual or to make any determination concerning an individual.
        </p>
      </Section>

      <Section id="corrections" n={9} title="Corrections">
        <p>
          The Site reflects regulatory records as published. A firm or individual who believes a
          record is inaccurate should seek correction at the source: firms by amending Form ADV, and
          individuals through their firm or through FINRA’s dispute process for BrokerCheck
          information. Corrections will be reflected on the Site following the next data refresh.
          Errors in the Site’s processing or presentation of the data may be reported through the
          project’s public repository on GitHub.
        </p>
      </Section>

      <Section id="third-parties" n={10} title="Third-party names, trademarks and links">
        <p>
          Firm names, fund names, logos and other marks are the property of their respective owners
          and are used solely to identify the subjects of public filings. Their use does not imply
          any affiliation with or endorsement by those owners. Logos are retrieved automatically
          from public icon services and may be inaccurate. References to other publications,
          rankings or data providers are made solely to describe comparable methodologies and do
          not imply affiliation. Links to third-party websites are provided for convenience only,
          and Open Disclosure is not responsible for their content.
        </p>
      </Section>

      <Section id="liability" n={11} title="Limitation of liability">
        <p>
          To the fullest extent permitted by applicable law, Open Disclosure and its contributors
          shall not be liable for any loss or damage of any kind, whether direct, indirect,
          incidental, special, consequential or otherwise, arising out of or in connection with the
          use of, inability to use, or reliance on the Site or the Information, including any
          interpretation or misinterpretation of the Information and any decision made or action
          taken on the basis of it. Use of the Site is at the user’s sole risk.
        </p>
      </Section>

      <Section id="changes" n={12} title="Changes to these terms">
        <p>
          Open Disclosure may amend these terms and the Site’s methodology at any time. The date
          shown at the top of this page indicates the most recent revision. Continued use of the
          Site following any amendment constitutes acceptance of the revised terms.
        </p>
      </Section>

      <p className="detail-note">
        <a href={BASE} onClick={(e) => navigate(e, BASE)}>
          Return to Open Disclosure
        </a>
      </p>
    </article>
  )
}
