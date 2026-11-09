import { AuthFrame } from "@/components/auth/AuthFrame";
import { SignupForm } from "@/components/auth/SignupForm";
import { GuestOnlyRoute } from "@/lib/auth/GuestOnlyRoute";

export const metadata = { title: "Create an account" };

/**
 * Self-service signup when this install allows it (`ORBIK_SIGNUP=open`); how to join otherwise.
 * Someone already signed in is sent on.
 */
export default function SignupPage() {
  return <AuthFrame><GuestOnlyRoute><SignupForm /></GuestOnlyRoute></AuthFrame>;
}
