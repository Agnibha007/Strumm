import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Report a Bug",
  description: "Report a bug or issue with Strumm.",
};

export default function ReportBugPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-4 md:px-0 soft-enter">
      <span className="text-[10px] tracking-widest uppercase font-semibold text-primary block mb-2">Support</span>
      <h1 className="text-4xl font-editorial text-text font-bold tracking-tight mb-2">Report a Bug</h1>
      <p className="text-sm text-muted mb-8">Found something broken? Let us know so we can fix it.</p>
      <div className="bg-surface/40 border border-border/60 rounded-xl p-6 space-y-5">
        <div>
          <p className="text-sm text-muted leading-relaxed">Please include the following information in your report:</p>
          <ul className="list-disc pl-6 mt-3 space-y-1.5 text-xs text-muted">
            <li>Description of the issue</li>
            <li>Steps to reproduce</li>
            <li>Expected vs actual behavior</li>
            <li>Browser and operating system</li>
            <li>Any error messages or screenshots</li>
          </ul>
        </div>
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 text-center">
          <p className="text-xs text-muted mb-1">Send bug reports to:</p>
          <a href="mailto:support@strumm.me" className="text-sm text-primary hover:underline font-semibold">support@strumm.me</a>
        </div>
        <p className="text-xs text-muted leading-relaxed">For security vulnerabilities, please use our <a href="/security" className="text-primary hover:underline">Security page</a> instead.</p>
      </div>
    </div>
  );
}
