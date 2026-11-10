import { describe, expect, it } from "vitest";

import { OG_IMAGE, pageMetadata, SITE_NAME, SITE_URL } from "./metadata";

describe("pageMetadata", () => {
  const meta = pageMetadata({
    title: "UnpackFund — fund directory",
    description: "Every fund in the published release.",
    path: "/funds/",
  });

  it("keeps the page's own title and description, so the card cannot promise more than the page", () => {
    expect(meta.title).toBe("UnpackFund — fund directory");
    expect(meta.description).toBe("Every fund in the published release.");
    expect(meta.openGraph?.title).toBe("UnpackFund — fund directory");
    expect(meta.openGraph?.description).toBe("Every fund in the published release.");
    expect(meta.twitter?.title).toBe("UnpackFund — fund directory");
    expect(meta.twitter?.description).toBe("Every fund in the published release.");
  });

  it("names the page's own absolute URL, not the site root", () => {
    expect(meta.openGraph?.url).toBe("https://unpackfund.com/funds/");
  });

  it("resolves the root route to the origin with a trailing slash", () => {
    const home = pageMetadata({ title: "t", description: "d", path: "/" });
    expect(home.openGraph?.url).toBe("https://unpackfund.com/");
  });

  it("declares the card image with its dimensions and alt text", () => {
    expect(meta.openGraph?.images).toEqual([
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "UnpackFund — see the companies behind your funds",
      },
    ]);
    expect(meta.twitter?.images).toEqual(["/og.png"]);
  });

  it("asks for the large card, which is the only one that shows the image", () => {
    // `toMatchObject` rather than property access: Next types `twitter` as a union of
    // card shapes, and only some of them carry `card`.
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("names the site on the card", () => {
    expect(meta.openGraph).toMatchObject({ siteName: SITE_NAME, type: "website" });
  });

  it("keeps the image path and size in one place", () => {
    expect(OG_IMAGE.path).toBe("/og.png");
    expect(OG_IMAGE.width).toBe(1200);
    expect(OG_IMAGE.height).toBe(630);
    expect(SITE_URL).toBe("https://unpackfund.com");
  });
});
