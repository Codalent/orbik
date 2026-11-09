import { AuthFrame } from "@/components/auth/AuthFrame";
import { LoginForm } from "@/components/auth/LoginForm";
import { GuestOnlyRoute } from "@/lib/auth/GuestOnlyRoute";

export const metadata = { title: "Sign in" };

/** Public sign-in route for pre-provisioned users; someone already signed in is sent on. */
export default function LoginPage() {
  return <AuthFrame><GuestOnlyRoute><LoginForm /></GuestOnlyRoute></AuthFrame>;
}
