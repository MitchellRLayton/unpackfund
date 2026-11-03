"use client";

/**
 * `/c/` — the companies directory, and the company detail it opens over itself.
 *
 * One client surface, because the two halves share four things:
 *
 * - `companies/index.json` (1.19 MB): the list, and the name a detail view can
 *   print before its own shard has arrived. Loading it here and passing rows down
 *   is what keeps opening a company from re-fetching the whole directory.
 * - `companies/countries.json`: the domicile column.
 * - The workspace — one instance, because it holds the look-through ledger, and two
 *   `useWorkspace()` calls would compute it twice. It also carries the fragment's
 *   company id, which is the only place the open company lives.
 * - The company's own shard, read by the dialog when it opens.
 *
 * The open company is `#c_<company_id>` set through `writeCompany`, so opening a
 * company never costs the reader their portfolio: the fragment is one string with
 * parts, and writing a company composes it into `#c_<id>~v3.<portfolio>` rather
 * than replacing it. That is also why a row's click is handled here rather than
 * left to the browser's default jump — a bare `#c_<id>` would drop the portfolio
 * and with it the "you hold" line.
 */

import { useMemo } from "react";

import { useCompanyIndex, useCountries } from "@/lib/use-release";
import { useWorkspace } from "@/lib/use-workspace";

import { CompaniesDirectory } from "./CompaniesDirectory";
import { CompanyDetail } from "./CompanyDetail";
import { toCompanyRows } from "./company-rows";

export function CompaniesSurface() {
  const workspace = useWorkspace();
  const release = workspace.release;
  const releaseData = release.status === "ready" ? release.data : null;

  const index = useCompanyIndex(releaseData);
  const countries = useCountries(releaseData);

  // Rows exist as soon as the index does; the country is filled in when the map
  // arrives, so the list is never held back by a column that can be blank.
  const rows = useMemo(
    () => toCompanyRows(index.data, countries.data),
    [index, countries],
  );

  const failure =
    release.status === "error"
      ? { message: release.error.message, detail: release.error.detail }
      : index.status === "error"
        ? { message: index.error.message, detail: index.error.detail }
        : null;

  return (
    <>
      <CompaniesDirectory
        rows={rows}
        status={failure ? "error" : index.status === "ready" ? "ready" : "loading"}
        error={failure}
        release={releaseData}
        onOpen={workspace.openCompany}
      />
      <CompanyDetail
        rows={rows}
        release={releaseData}
        companyId={workspace.companyId}
        ledger={workspace.ledger}
        countryOf={workspace.countryOf}
        openCompany={workspace.openCompany}
      />
    </>
  );
}
