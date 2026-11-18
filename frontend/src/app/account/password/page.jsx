import { ChangePasswordPage } from "@/components/account/ChangePasswordPage";
import { ToSettings } from "@/components/account/ToSettings";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";

export const metadata = { title: "Change password" };

/**
 * Changing the signed-in account's password, at its old address. It is Settings → Account now,
 * and someone with a workspace is sent there; an account with no workspace yet changes it on this
 * page, outside the workspace shell. A core page: it wins over a deployment's `accountPages` entry
 * at the same path.
 */
export default function ChangePassword() {
  return (
    <ProtectedRoute allowOnboarding>
      <ToSettings section="account">
        <ChangePasswordPage />
      </ToSettings>
    </ProtectedRoute>
  );
}
