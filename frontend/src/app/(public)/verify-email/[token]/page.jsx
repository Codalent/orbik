import { AuthFrame } from "@/components/auth/AuthFrame";
import { VerifyEmailForm } from "@/components/auth/VerifyEmailForm";

export const metadata = { title: "Confirm your email", referrer: "no-referrer" };

/**
 * The link a signup's confirmation email carries (`ORBIK_SIGNUP_VERIFY_EMAIL`). Its address holds
 * the one-time token, so it never hands that address to another site as a referrer.
 */
export default function VerifyEmailPage() {
  return <AuthFrame><VerifyEmailForm /></AuthFrame>;
}
