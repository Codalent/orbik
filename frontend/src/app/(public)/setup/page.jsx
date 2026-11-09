import { AuthFrame } from "@/components/auth/AuthFrame";
import { SetupForm } from "@/components/auth/SetupForm";

export const metadata = { title: "Set up Orbik" };

/** A new install's first page: claim it with the setup code and create its first account. */
export default function SetupPage() {
  return <AuthFrame><SetupForm /></AuthFrame>;
}
