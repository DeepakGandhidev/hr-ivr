export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

export function defaultInterviewInviteVars(args: {
  candidateName: string;
  jobTitle: string;
  companyName: string;
  pratibhaNumber: string;
  referenceCode: string;
}): Record<string, string> {
  return {
    candidateName: args.candidateName,
    jobTitle: args.jobTitle,
    companyName: args.companyName,
    pratibhaNumber: args.pratibhaNumber,
    referenceCode: args.referenceCode,
  };
}
