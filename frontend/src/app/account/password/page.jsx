import { ChangePasswordPage } from "@/components/account/ChangePasswordPage";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";

export const metadata = { title: "Change password" };

/**
 * Changing the signed-in account's password, from the account menu. Outside any workspace, as the
 * Admin page is, and open to an account with no workspace yet. A core page: it wins over a
 * deployment's `accountPages` entry at the same path.
 */
export default function ChangePassword() {
  return (
    <ProtectedRoute allowOnboarding>
      <ChangePasswordPage />
    </ProtectedRoute>
  );
}
