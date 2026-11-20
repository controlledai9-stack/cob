import React, { useEffect, useState } from "react";
import {
  Bot,
  FolderKanban,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ShieldCheck,
  Trash2,
  UserPlus,
} from "lucide-react";
import type { ProjectSummary } from "../shared/types";
import { PROJECT_STATUS_LABEL } from "../core/team/projects";
import {
  Sidebar,
  SidebarBody,
  SidebarLink,
  useSidebar,
} from "./components/ui/sidebar";
import { ProfileDropdown } from "./components/ui/profile-dropdown";
import { initials } from "./components/ui/utils";

export type SidebarTab =
  | "Agents"
  | "Home"
  | "Chats"
  | "Teams"
  | "Invites"
  | "Profile";

export interface AppSidebarProps {
  projects: ProjectSummary[];
  activeTeamId: string | null;
  tab: string;
  pendingInvites: boolean;
  profile: { name: string; avatar?: string; availability?: string };
  plannerLabel?: string;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onSelectProject: (teamId: string) => void;
  onNewProject: () => void;
  onDeleteProject?: () => void;
  onTab: (tab: SidebarTab) => void;
}

/** Cobble's left sidebar: projects, the active project's pages, profile. */
export function AppSidebar(props: AppSidebarProps) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("cobble-sidebar-open") !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("cobble-sidebar-open", String(open));
    } catch {
      /* Remembering the sidebar is a convenience only. */
    }
  }, [open]);
  return (
    <Sidebar open={open} setOpen={setOpen} hoverToOpen={false}>
      <SidebarBody className="sidebar">
        <SidebarContent {...props} />
      </SidebarBody>
    </Sidebar>
  );
}

function SidebarContent(props: AppSidebarProps) {
  const { open, setOpen } = useSidebar();
  const page = (tab: SidebarTab, label: string, icon: React.ReactNode) => (
    <SidebarLink
      key={tab}
      link={{
        label,
        icon,
        selected: props.tab === tab,
        className: "nav-button",
        onClick: () => props.onTab(tab),
        badge:
          tab === "Invites" && props.pendingInvites ? (
            <b className="dot" aria-label="Pending requests" />
          ) : undefined,
      }}
    />
  );
  return (
    <>
      <div className="ui-sidebar-scroll">
        <div className="ui-sidebar-logo">
          {open && (
            <>
              <span className="ui-logo-mark" aria-hidden="true" />
              <span className="ui-sidebar-label wordmark">
                cobble<span>●</span>
              </span>
            </>
          )}
          <button
            type="button"
            className="ui-sidebar-toggle"
            aria-label={open ? "Close sidebar" : "Open sidebar"}
            aria-expanded={open}
            title={open ? "Close sidebar" : "Open sidebar"}
            onClick={() => setOpen(!open)}
          >
            {open ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
        </div>
        <SidebarLink
          link={{
            label: "New project",
            icon: <Plus size={18} />,
            className: "project-new",
            onClick: props.onNewProject,
          }}
        />
        <div className="ui-sidebar-section" aria-label="Projects">
          {open && <p className="ui-sidebar-heading">Projects</p>}
          {props.projects.map((project) => {
            const active = project.teamId === props.activeTeamId;
            const status = PROJECT_STATUS_LABEL[project.status];
            return (
              <React.Fragment key={project.teamId}>
                <SidebarLink
                  link={{
                    label: project.name,
                    title: `${project.name} · ${status}`,
                    selected: active && props.tab === "Agents",
                    className: active
                      ? "project-item is-active"
                      : "project-item",
                    icon: (
                      <span className="ui-project-icon" aria-hidden="true">
                        {initials(project.name)}
                        <i
                          className={`status-dot status-${project.status}`}
                          title={status}
                        />
                      </span>
                    ),
                    onClick: () => props.onSelectProject(project.teamId),
                  }}
                />
                {active && (
                  <div className="ui-sidebar-sub project-secondary">
                    {page("Home", "Plan Guard", <ShieldCheck size={16} />)}
                    {page("Chats", "Discussions", <MessagesSquare size={16} />)}
                    {page("Teams", "Workspace & Plan", <FolderKanban size={16} />)}
                    {props.onDeleteProject && (
                      <SidebarLink
                        link={{
                          label: "Delete project",
                          icon: <Trash2 size={16} />,
                          className: "ui-sidebar-danger",
                          onClick: props.onDeleteProject,
                        }}
                      />
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
          {props.projects.length === 0 && open && (
            <p className="projects-empty">No projects yet</p>
          )}
        </div>
        <div className="ui-sidebar-section">
          {page("Agents", "Agent Team", <Bot size={18} />)}
          {page("Invites", "Join Requests", <UserPlus size={18} />)}
        </div>
      </div>
      <div className="sidebar-bottom">
        <ProfileDropdown
          compact={!open}
          theme={props.theme}
          data={{
            name: props.profile.name,
            avatar: props.profile.avatar,
            status: props.profile.availability,
            model: props.plannerLabel,
          }}
          onProfile={() => props.onTab("Profile")}
          onSettings={() => props.onTab("Profile")}
          onToggleTheme={props.onToggleTheme}
        />
      </div>
    </>
  );
}
