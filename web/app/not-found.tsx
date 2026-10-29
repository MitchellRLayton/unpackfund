import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "UnpackFund — page not found",
};

/**
 * Static 404. With `output: 'export'` Next emits `out/404.html`, and the Worker
 * serves it through `not_found_handling: "404-page"` (deploy skill §2).
 */
export default function NotFound() {
  return (
    <main id="main" className="narrow">
      <h1>Page not found</h1>
      <p>
        That address is not part of UnpackFund. The <Link href="/">builder</Link> and the{" "}
        <Link href="/x/">ledger</Link> are the whole app while it is this young.
      </p>
    </main>
  );
}
