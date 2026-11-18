import { AdminPage } from "@/components/admin/AdminPage";
import { ToSettings } from "@/components/account/ToSettings";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";

export const metadata = { title: "Admin" };

/**
 * The install's Admin page's old address. It is Settings → Admin now, and an admin with a workspace
 * is sent there; one with no workspace of their own yet still administers the install, on this
 * page outside the workspace shell. Behind sign-in, and the API serves it only to the install's
 * admins.
 */
export default function Admin() {
  return (
    <ProtectedRoute allowOnboarding>
      <ToSettings section="admin">
        <AdminPage />
      </ToSettings>
    </ProtectedRoute>
  );
}
