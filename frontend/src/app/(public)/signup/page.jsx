import { AuthFrame } from "@/components/auth/AuthFrame";
import { SignupPage } from "@/components/auth/SignupPage";
import { GuestOnlyRoute } from "@/lib/auth/GuestOnlyRoute";

export const metadata = { title: "Join" };

/**
 * Asking the install's admins for access, or, where a deployment's extension adds one, its own way
 * to make an account. Someone already signed in is sent on.
 */
export default function SignupRoute() {
  return <AuthFrame><GuestOnlyRoute><SignupPage /></GuestOnlyRoute></AuthFrame>;
}
