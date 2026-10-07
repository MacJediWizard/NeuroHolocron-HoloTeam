import { GITHUB_URL, SITE_NAME, SITE_URL } from "./site";

const OPERATOR_NAME = "MacJediWizard";
const SUPPORT_EMAIL = "hello@legiara.com";

export type HomeStructuredDataInput = {
  pageUrl: string;
  title: string;
  description: string;
  siteDescription: string;
  inLanguage: string;
  defaultInLanguage: string;
  availableLanguages: string[];
};

export function homeStructuredData(input: HomeStructuredDataInput) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: OPERATOR_NAME,
        alternateName: SITE_NAME,
        url: `${SITE_URL}/`,
        logo: `${SITE_URL}/brand/mark.png`,
        email: SUPPORT_EMAIL,
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: SUPPORT_EMAIL,
          url: `${SITE_URL}/support/`,
          availableLanguage: input.availableLanguages,
        },
        sameAs: [GITHUB_URL],
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: `${SITE_URL}/`,
        name: SITE_NAME,
        description: input.siteDescription,
        inLanguage: input.defaultInLanguage,
        publisher: { "@id": `${SITE_URL}/#organization` },
      },
      {
        "@type": "WebPage",
        "@id": `${input.pageUrl}#webpage`,
        url: input.pageUrl,
        name: input.title,
        description: input.description,
        inLanguage: input.inLanguage,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        about: { "@id": `${SITE_URL}/#software` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/#software`,
        name: SITE_NAME,
        url: `${SITE_URL}/`,
        description: input.siteDescription,
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "AI agent platform",
        operatingSystem: "Web, macOS, Linux, iOS, Android",
        isAccessibleForFree: true,
        codeRepository: GITHUB_URL,
        license: `${GITHUB_URL}/blob/main/LICENSE`,
        provider: { "@id": `${SITE_URL}/#organization` },
        inLanguage: input.availableLanguages,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
      },
    ],
  };
}
