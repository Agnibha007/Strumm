/**
 * BreadcrumbJsonLd — Renders a BreadcrumbList JSON-LD script tag.
 *
 * Usage (in server components):
 *   <BreadcrumbJsonLd items={[
 *     { name: "Home", href: "/" },
 *     { name: "About", href: "/about" },
 *   ]} />
 *
 * The component is a server component with zero runtime overhead —
 * it renders a static <script> tag during SSR.
 */
interface BreadcrumbItem {
  name: string;
  href: string;
}

const baseUrl =
  process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export default function BreadcrumbJsonLd({
  items,
}: {
  items: BreadcrumbItem[];
}) {
  if (!items || items.length < 2) return null;

  const itemListElement = items.map((item, index) => ({
    "@type": "ListItem" as const,
    position: index + 1,
    name: item.name,
    item: `${baseUrl}${item.href}`,
  }));

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement,
        }),
      }}
    />
  );
}
