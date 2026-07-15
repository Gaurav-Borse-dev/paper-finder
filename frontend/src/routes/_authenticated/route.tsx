import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getToken } from "@/services/api";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ location }) => {
    const token = getToken();
    if (!token) {
      throw redirect({
        to: "/auth",
        search: { redirect: location.href, mode: "signin" as const },
      });
    }
  },
  component: () => <Outlet />,
});
