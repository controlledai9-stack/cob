import React, { createContext, useContext, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import { cn } from "./utils";

/**
 * Collapsible sidebar (adapted from Aceternity's sidebar for Electron: links
 * are buttons, no Next.js). On wide windows it is a slim icon rail that
 * opens on hover; on narrow windows it becomes a menu button and a drawer.
 */
export interface SidebarLinkItem {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  selected?: boolean;
  /** Small marker after the label, e.g. an unread dot. */
  badge?: React.ReactNode;
  className?: string;
  title?: string;
}

interface SidebarContextProps {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  animate: boolean;
  /** Open while the pointer is over it (off: a toggle button opens it). */
  hoverToOpen: boolean;
}

const SidebarContext = createContext<SidebarContextProps | undefined>(
  undefined,
);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context)
    throw new Error("useSidebar must be used within a SidebarProvider");
  return context;
};

export function SidebarProvider({
  children,
  open: openProp,
  setOpen: setOpenProp,
  animate = true,
  hoverToOpen = true,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
  hoverToOpen?: boolean;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = setOpenProp ?? setOpenState;
  return (
    <SidebarContext.Provider value={{ open, setOpen, animate, hoverToOpen }}>
      {children}
    </SidebarContext.Provider>
  );
}

export const Sidebar = SidebarProvider;

export function SidebarBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <DesktopSidebar className={className}>{children}</DesktopSidebar>
      <MobileSidebar className={className}>{children}</MobileSidebar>
    </>
  );
}

export function DesktopSidebar({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { open, setOpen, animate, hoverToOpen } = useSidebar();
  return (
    <motion.aside
      className={cn(
        "ui-sidebar",
        open && "is-open",
        hoverToOpen && "is-hover",
        className,
      )}
      initial={false}
      animate={{ width: animate ? (open ? 264 : 64) : 264 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      {...(hoverToOpen
        ? {
            onMouseEnter: () => setOpen(true),
            onMouseLeave: () => setOpen(false),
            onFocus: () => setOpen(true),
            onBlur: (event: React.FocusEvent<HTMLElement>) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              )
                setOpen(false);
            },
          }
        : {})}
    >
      {children}
    </motion.aside>
  );
}

export function MobileSidebar({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { open, setOpen } = useSidebar();
  return (
    <div className="ui-sidebar-mobile-bar">
      <button
        type="button"
        className="ui-icon-button"
        aria-label="Open menu"
        onClick={() => setOpen(!open)}
      >
        <Menu size={20} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: "-100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "-100%", opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className={cn("ui-sidebar-drawer is-open", className)}
          >
            <button
              type="button"
              className="ui-icon-button ui-sidebar-close"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
            >
              <X size={20} />
            </button>
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function SidebarLink({ link }: { link: SidebarLinkItem }) {
  const { open, animate } = useSidebar();
  const shown = !animate || open;
  return (
    <button
      type="button"
      className={cn(
        "ui-sidebar-link",
        link.selected && "selected",
        link.className,
      )}
      aria-current={link.selected ? "page" : undefined}
      title={shown ? link.title : (link.title ?? link.label)}
      onClick={link.onClick}
    >
      <span className="ui-sidebar-icon">{link.icon}</span>
      <motion.span
        className="ui-sidebar-label"
        initial={false}
        animate={{ opacity: shown ? 1 : 0 }}
        transition={{ duration: 0.12 }}
      >
        {link.label}
      </motion.span>
      {link.badge}
    </button>
  );
}
