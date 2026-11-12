import AccountPageView from "./view";

export const metadata = { title: "Account" };

/**
 * A page a deployment's extension adds about the signed-in account rather than one workspace — a
 * plan, an invoice list — from `accountPages` in `@orbik/web-extensions`. In this repository the
 * slot is empty and every address here is not found.
 */
export default function AccountPage() {
  return <AccountPageView />;
}
