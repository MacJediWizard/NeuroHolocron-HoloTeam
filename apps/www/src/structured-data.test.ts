import { describe, expect, it } from "vitest";
import { homeStructuredData } from "./structured-data";

const data = homeStructuredData({
  pageUrl: "https://legiara.com/",
  title: "Legiara",
  description: "Page description",
  siteDescription: "Site description",
  inLanguage: "en",
  defaultInLanguage: "en",
  availableLanguages: ["English"],
});

type JsonNode = {
  "@type": string;
  name?: string;
  legalName?: string;
  alternateName?: string;
  codeRepository?: string;
  operatingSystem?: string;
  isAccessibleForFree?: boolean;
  offers?: { price?: string; priceCurrency?: string };
};

describe("homepage structured data", () => {
  const graph = data["@graph"] as readonly JsonNode[];
  const organization = graph.find((node) => node["@type"] === "Organization");
  const website = graph.find((node) => node["@type"] === "WebSite");
  const software = graph.find((node) => node["@type"] === "SoftwareApplication");

  it("names the operator as the organization and the website Legiara", () => {
    expect(organization?.name).toBe("MacJediWizard");
    expect(organization?.alternateName).toBe("Legiara");
    expect(organization).not.toHaveProperty("legalName");
    expect(website?.name).toBe("Legiara");
  });

  it("describes Legiara as the free multi-platform application", () => {
    expect(software).toMatchObject({
      name: "Legiara",
      codeRepository: "https://github.com/MacJediWizard/NeuroHolocron-Legiara",
      operatingSystem: "Web, macOS, Linux, iOS, Android",
      isAccessibleForFree: true,
      offers: { price: "0", priceCurrency: "USD" },
    });
  });
});
