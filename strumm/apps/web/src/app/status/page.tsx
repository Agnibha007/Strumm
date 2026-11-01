import { Metadata } from "next";
import BreadcrumbJsonLd from "web/components/BreadcrumbJsonLd";
import StatusClient from "./StatusClient";
import JsonLd from "web/components/JsonLd";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: "Status",
  description:
    "Live health checks for the Strumm API and database, plus the current monitoring coverage for third-party integrations.",
  openGraph: {
    title: "Status | Strumm",
    description:
      "Live health checks for the Strumm API and database, and honest coverage notes for integrations that are not independently monitored.",
    url: "/status",
  },
  alternates: {
    canonical: `${appUrl}/status`,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default async function StatusPage() {
  return (
    <>
      <BreadcrumbJsonLd
        items={[
          { name: "Home", href: "/" },
          { name: "Status", href: "/status" },
        ]}
      />

      {/* WebPage structured data */}
      <JsonLd
        schema={{
          "@context": "https://schema.org",
          "@type": "WebPage",
          "@id": `${appUrl}/status#webpage`,
          name: "Strumm Service Status",
          description:
            "Live health checks for the Strumm API and database, with clearly labelled coverage for third-party integrations.",
          url: `${appUrl}/status`,
          isPartOf: { "@id": `${appUrl}#website` },
        }}
      />

      <StatusClient />
    </>
  );
}
