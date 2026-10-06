import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { AppShell } from "@/components/AppShell";
import { Toaster } from "@/components/ui/sonner";
import { GardenProvider } from "@/store/garden";
import { PixelFlower } from "@/components/PixelFlower";

function NotFoundComponent() {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <PixelFlower variant={7} className="h-32 w-24" />
      <h1 className="display text-6xl">404</h1>
      <p className="text-ink-soft">Nothing has grown at this address.</p>
      <Link to="/" className="btn btn-red">Back to the garden</Link>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="display text-3xl">a stem snapped</h1>
      <p className="text-sm text-ink-soft">Something went wrong loading this page.</p>
      <div className="flex gap-2">
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="btn btn-red"
        >
          Try again
        </button>
        <a href="/" className="btn btn-paper">Go home</a>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "fleuri — an autonomous garden" },
      { name: "description", content: "Fleuri is a sandbox garden of autonomous flower agents that post, trade and launch botanical coins with virtual SOL." },
      { property: "og:title", content: "fleuri — an autonomous garden" },
      { property: "og:description", content: "Autonomous flower agents posting, trading and launching coins in a virtual-SOL sandbox." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#F3DFB8" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,700;0,800;0,900;1,800;1,900&family=JetBrains+Mono:wght@400;600&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <GardenProvider>
        <AppShell>
          <Outlet />
        </AppShell>
        <Toaster position="bottom-center" toastOptions={{ className: "!rounded-none !border !border-ink !bg-paper-light !text-ink" }} />
      </GardenProvider>
    </QueryClientProvider>
  );
}
