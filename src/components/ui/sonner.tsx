"use client"

import { CircleAlertIcon, CircleCheckIcon, InfoIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useResolvedTheme } from "@/hooks/use-theme"
import { colorSchemeOf } from "@/lib/client/theme"

/** 16 px above whatever fixed bar sits at the bottom of the page (`--toast-lift`, set by globals.css on the workspace). */
const LIFTED = "calc(16px + var(--toast-lift, 0px))"

/**
 * The single sonner Toaster (root layout). It follows the resolved theme; tokens style the toasts; status icons
 * carry the status colour, text stays --foreground (§8.2). Call `toast()` from "sonner" anywhere.
 */
function Toaster(props: ToasterProps) {
  // Sonner knows light and dark only; Rosa is a dark scheme and its tokens restyle the toasts.
  const theme = colorSchemeOf(useResolvedTheme())
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      className="rm-toaster"
      visibleToasts={4}
      gap={8}
      offset={{ top: 16, right: 16, left: 16, bottom: LIFTED }}
      mobileOffset={{ top: 16, right: 16, left: 16, bottom: LIFTED }}
      containerAriaLabel="Notificaciones"
      icons={{
        success: <CircleCheckIcon className="size-4 text-ok" />,
        info: <InfoIcon className="size-4 text-brand" />,
        warning: <TriangleAlertIcon className="size-4 text-warn" />,
        error: <CircleAlertIcon className="size-4 text-danger" />,
        loading: <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />,
      }}
      toastOptions={{
        classNames: {
          toast: "!rounded-lg !border !border-border !bg-popover !text-foreground !shadow-overlay !font-sans !text-body !gap-2.5 !px-3.5 !py-3",
          title: "!font-medium",
          description: "!text-meta !text-muted-foreground",
          actionButton: "!h-7 !rounded-md !bg-primary !px-2.5 !text-meta !font-medium !text-primary-foreground",
          cancelButton: "!h-7 !rounded-md !bg-secondary !px-2.5 !text-meta !text-foreground",
          closeButton: "!border-border !bg-popover !text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
