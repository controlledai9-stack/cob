import React, { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bot, Moon, Settings, Sun, User } from "lucide-react";
import { cn, initials } from "./utils";

/**
 * Profile button with a menu (adapted from Kokonut UI's profile dropdown:
 * letter avatar instead of a photo, and Cobble's own menu items).
 */
export interface ProfileData {
  name: string;
  /** Shown under the name, e.g. "Available". */
  status?: string;
  avatar?: string;
  /** e.g. "Planner: Codex". */
  model?: string;
}

export interface ProfileMenuItem {
  label: string;
  value?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

export function ProfileDropdown({
  data,
  compact = false,
  theme,
  onProfile,
  onSettings,
  onToggleTheme,
  extraItems = [],
  className,
}: {
  data: ProfileData;
  /** Only the avatar (collapsed sidebar). */
  compact?: boolean;
  theme?: "light" | "dark";
  onProfile: () => void;
  onSettings?: () => void;
  onToggleTheme?: () => void;
  extraItems?: ProfileMenuItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const items: ProfileMenuItem[] = [
    { label: "Profile", icon: <User size={16} />, onSelect: onProfile },
    ...(data.model
      ? [
          {
            label: "Planner",
            value: data.model,
            icon: <Bot size={16} />,
            onSelect: onSettings ?? onProfile,
          },
        ]
      : []),
    ...extraItems,
    ...(onToggleTheme
      ? [
          {
            label: theme === "dark" ? "Light mode" : "Dark mode",
            icon: theme === "dark" ? <Sun size={16} /> : <Moon size={16} />,
            onSelect: onToggleTheme,
          },
        ]
      : []),
    ...(onSettings
      ? [
          {
            label: "Settings",
            icon: <Settings size={16} />,
            onSelect: onSettings,
          },
        ]
      : []),
  ];
  return (
    <div className={cn("ui-profile", className)}>
      <DropdownMenu.Root onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={cn("ui-profile-trigger", open && "is-open")}
            aria-label="Profile and Settings"
          >
            <span className="ui-avatar ui-avatar-ring" aria-hidden="true">
              <span>{data.avatar || initials(data.name)}</span>
            </span>
            {!compact && (
              <span className="ui-profile-text">
                <span className="ui-profile-name">{data.name}</span>
                {data.status && (
                  <span className="ui-profile-status">
                    <i className="ui-dot is-on" /> {data.status}
                  </span>
                )}
              </span>
            )}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="start"
            sideOffset={8}
            className="ui-menu"
          >
            {items.map((item) => (
              <DropdownMenu.Item
                key={item.label}
                className="ui-menu-item"
                onSelect={item.onSelect}
              >
                {item.icon}
                <span className="ui-menu-label">{item.label}</span>
                {item.value && (
                  <span className="ui-menu-value">{item.value}</span>
                )}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
