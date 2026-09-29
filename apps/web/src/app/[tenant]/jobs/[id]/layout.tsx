import { JobSummaryProvider } from "@/components/JobShell";

/**
 * Holds one job's summary — publish state and live tab counts — across its
 * tabs, so switching tabs does not blank the header while it refetches.
 * Renders nothing of its own; each tab draws its header and tab bar.
 */
export default function JobLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { tenant: string; id: string };
}) {
  return (
    <JobSummaryProvider tenant={params.tenant} jobId={params.id}>
      {children}
    </JobSummaryProvider>
  );
}
