"use client";

import {
  FolderOpenIcon,
  HistoryIcon,
  KeyIcon,
  LayoutGridIcon,
  LogOutIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";

const menuItems = [
  {
    title: "Workspace",
    items: [
      {
        title: "Workflows",
        icon: FolderOpenIcon,
        url: "/workflows",
      },
      {
        title: "Credentials",
        icon: KeyIcon,
        url: "/credentials",
      },
      {
        title: "Executions",
        icon: HistoryIcon,
        url: "/executions",
      },
    ],
  }
];

export const AppSidebar = () => {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border/70 bg-sidebar">
      <SidebarHeader className="gap-y-4 border-b border-sidebar-border/70 p-4">
        <SidebarMenuItem>
          <SidebarMenuButton asChild className="h-11 gap-x-3 rounded-2xl px-3">
            <Link href="/" prefetch>
              <Image src="/logos/logo.svg" alt="Guideboard" width={28} height={28} />
              <span className="text-sm font-semibold tracking-tight">Guideboard</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <div className="rounded-2xl border border-sidebar-border/70 bg-sidebar-accent/45 p-3.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <LayoutGridIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Current Space</p>
              <p className="truncate text-sm font-semibold">Automation Hub</p>
            </div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="px-2 py-4">
        {menuItems.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel className="px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/90">
              {group.title}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-y-1.5">
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      tooltip={item.title}
                      isActive={
                        item.url === "/"
                          ? pathname === "/"
                          : pathname.startsWith(item.url)
                      }
                      asChild
                      className="h-10 gap-x-3 rounded-xl px-3 text-[13px] font-semibold transition-all duration-200 data-[active=true]:bg-primary data-[active=true]:text-primary-foreground data-[active=true]:shadow-sm hover:bg-sidebar-accent/80"
                    >
                      <Link href={item.url} prefetch>
                        <item.icon className="size-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border/70 px-2 py-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sign out"
              className="h-10 gap-x-3 rounded-xl px-3 text-[13px] font-semibold transition-all duration-200 hover:bg-destructive/10 hover:text-destructive"
              onClick={() => authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    router.push("/login");
                  },
                },
              })}
            >
              <LogOutIcon className="h-4 w-4" />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
};
