/**
 * One definition of what a link to this site looks like when it is pasted somewhere.
 *
 * Before this module the site shipped no `og:` or `twitter:` tags at all, so a link
 * to unpackfund.com unfurled as a bare URL with no title, no description and no
 * image — the worst possible preview for a product whose whole argument is a number
 * on a page. Every route now builds its metadata here, so the card cannot drift from
 * the page: the title and description a search engine reads are the same strings the
 * card shows.
 *
 * `metadataBase` lives in the layout and resolves the relative image path below to an
 * absolute URL, which is what the crawlers require.
 */

import type { Metadata } from "next";

/** The canonical origin. The fund pages' generator holds the same value (`pipeline.fund_pages.SITE`). */
export const SITE_URL = "https://unpackfund.com";

export const SITE_NAME = "UnpackFund";

/**
 * The card image, 1200×630.
 *
 * That ratio is what X's `summary_large_image`, Slack, iMessage, LinkedIn and Discord
 * all crop from without letterboxing; a square or a 16:9 image is cropped by at least
 * one of them. The file is `web/public/og.png`, generated from the site's own palette
 * and typefaces so the card and the page it opens look like the same product.
 */
export const OG_IMAGE = {
  path: "/og.png",
  width: 1200,
  height: 630,
  alt: "UnpackFund — see the companies behind your funds",
} as const;

/**
 * The metadata for one route: the page's own title and description, plus the card
 * that shows them.
 *
 * `path` is the route as a visitor sees it (`/x/`, `/funds/`), and it becomes both
 * `og:url` and the card's identity — a card that names the wrong URL is how a share
 * of one page ends up pointing at another.
 */
export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  const url = new URL(path, SITE_URL).toString();

  return {
    title,
    description,
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title,
      description,
      url,
      images: [
        {
          url: OG_IMAGE.path,
          width: OG_IMAGE.width,
          height: OG_IMAGE.height,
          alt: OG_IMAGE.alt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [OG_IMAGE.path],
    },
  };
}
