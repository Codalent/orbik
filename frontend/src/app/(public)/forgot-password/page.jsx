import { AuthFrame } from "@/components/auth/AuthFrame";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { GuestOnlyRoute } from "@/lib/auth/GuestOnlyRoute";

export const metadata = { title: "Forgot password" };

/** Asking for a password reset link; someone already signed in is sent on. */
export default function ForgotPasswordPage() {
  return <AuthFrame><GuestOnlyRoute><ForgotPasswordForm /></GuestOnlyRoute></AuthFrame>;
}
