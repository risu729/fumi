/** Server-resolved mailbox grant; request arguments and mail cannot grant access. */
export interface MailPrincipal {
  id: string;
  scopes: readonly string[];
  fromAddresses: readonly string[];
  fromDomains?: readonly string[];
}

export const MAIL_SCOPES = [
  "mail:read",
  "mail:draft",
  "mail:send",
  "mail:events",
  "mail:import",
  "mail:routing",
] as const;

export function hasScope(principal: MailPrincipal, scope: string): boolean {
  return principal.scopes.includes(scope);
}
