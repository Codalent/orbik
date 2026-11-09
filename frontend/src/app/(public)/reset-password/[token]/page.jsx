import { AuthFrame } from "@/components/auth/AuthFrame";
import { NewPasswordForm } from "@/components/auth/NewPasswordForm";

/** The token is in the address, so nothing this page loads may carry it on as a referrer. */
export const metadata = { title: "Choose a new password", referrer: "no-referrer" };

/**
 * Where a password reset link lands. Not guest-only: someone signed in on this browser may still
 * be resetting the password of the account they forgot, and using the link signs this browser in
 * as that account.
 */
export default function ResetPasswordPage() {
  return <AuthFrame><NewPasswordForm kind="reset" /></AuthFrame>;
}
