import { AuthFrame } from "@/components/auth/AuthFrame";
import { NewPasswordForm } from "@/components/auth/NewPasswordForm";

/** The token is in the address, so nothing this page loads may carry it on as a referrer. */
export const metadata = { title: "Create your account", referrer: "no-referrer" };

/** Where an approved access request's link lands: choose a password, and the account is made. */
export default function JoinPage() {
  return <AuthFrame><NewPasswordForm kind="join" /></AuthFrame>;
}
