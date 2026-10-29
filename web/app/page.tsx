export default function Home() {
  return (
    <main>
      <h1>UnpackFund</h1>
      <p>
        A free, no-login tool that shows the companies you actually own through your ETFs
        and mutual funds — every number traceable to a public SEC filing.
      </p>

      <hr />

      <p>
        <strong>Status: scaffold.</strong> This build serves the application shell only.
        No fund, holding, or metric data is published yet, so nothing on this page is a
        portfolio number.
      </p>

      <ul>
        <li>Holdings will come from SEC Form N-PORT filings.</li>
        <li>Fundamentals will come from SEC XBRL data.</li>
        <li>
          Every figure will carry an as-of date, a source link, and a coverage label.
        </li>
      </ul>

      <footer>
        <p className="muted">
          UnpackFund is not an investment adviser and does not provide investment advice.
          Data is published from SEC EDGAR, which lags the market; verify anything
          material against the fund&rsquo;s own documents.
        </p>
      </footer>
    </main>
  );
}
