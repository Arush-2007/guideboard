"use client";

import {
  FolderOpenIcon,
  HistoryIcon,
  KeyIcon,
  LayoutGridIcon,
  LogOutIcon,
  SettingsIcon,
  UserRoundIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useNavGuard } from "@/features/editor/hooks/use-nav-guard";
import { UserAvatar } from "@/features/profile/components/user-avatar";
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
        title: "Settings",
        icon: SettingsIcon,
        url: "/settings",
      },
      {
        title: "Executions",
        icon: HistoryIcon,
        url: "/executions",
      },
    ],
  },
];

type SidebarUser = { name: string; email: string; image?: string | null };

export const AppSidebar = ({ user: initialUser }: { user: SidebarUser }) => {
  const router = useRouter();
  const pathname = usePathname();
  const guardNav = useNavGuard();
  // Client-side session so the footer card reflects a rename or a new avatar
  // without waiting out the server session's cookie cache. Falls back to the
  // server-seeded user so the first render matches SSR (see layout) rather than
  // flashing a placeholder — a client/server mismatch that broke hydration.
  const { data: session } = authClient.useSession();
  const user = session?.user ?? initialUser;

  // The workflow editor (/workflows/<id>) renders a heavy React Flow canvas in
  // the content area. Animating the rail width resizes that canvas every frame
  // and stutters, so collapse instantly there; other pages keep the slide.
  const isEditor = pathname.startsWith("/workflows/");

  return (
    <Sidebar
      collapsible="icon"
      noAnimation={isEditor}
      className="border-r border-sidebar-border/70 bg-sidebar"
    >
      <SidebarHeader className="gap-y-4 border-b border-sidebar-border/70 p-4 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            className="h-11 gap-x-3 rounded-2xl px-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:!h-11 group-data-[collapsible=icon]:!w-8 group-data-[collapsible=icon]:!p-0.5"
          >
            <Link href="/" prefetch onClick={guardNav("/")}>
              <Image
                src="/logos/logo.svg"
                alt="Guideboard"
                width={28}
                height={28}
                unoptimized
                className="shrink-0"
              />
              <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
                Guideboard
              </span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <div className="rounded-2xl border border-sidebar-border/70 bg-sidebar-accent/45 p-3.5 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:px-0.5">
          <div className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0">
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <LayoutGridIcon className="size-4" />
            </span>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Current Space
              </p>
              <p className="truncate text-sm font-semibold">Automation Hub</p>
            </div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="px-2 py-4 group-data-[collapsible=icon]:px-0">
        {menuItems.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel className="px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/90 group-data-[collapsible=icon]:mt-0">
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
                      className="h-10 gap-x-3 rounded-xl px-3 text-[13px] font-semibold transition-all duration-200 data-[active=true]:bg-primary data-[active=true]:text-primary-foreground data-[active=true]:shadow-sm hover:bg-sidebar-accent/80 group-data-[collapsible=icon]:!h-10 group-data-[collapsible=icon]:!w-8"
                    >
                      <Link
                        href={item.url}
                        prefetch
                        onClick={guardNav(item.url)}
                      >
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  tooltip={user.name}
                  className="h-12 gap-x-3 rounded-xl px-2 transition-all duration-200 hover:bg-sidebar-accent/80 group-data-[collapsible=icon]:!h-10 group-data-[collapsible=icon]:!w-8 group-data-[collapsible=icon]:!p-0.5"
                >
                  <UserAvatar
                    name={user.name}
                    email={user.email}
                    image={user.image}
                    className="size-8"
                    fallbackClassName="text-xs"
                  />
                  <div className="min-w-0 text-left group-data-[collapsible=icon]:hidden">
                    <p className="truncate text-[13px] font-semibold leading-tight">
                      {user.name}
                    </p>
                    <p className="truncate text-[11px] leading-tight text-muted-foreground">
                      {user.email}
                    </p>
                  </div>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-52">
                <DropdownMenuItem asChild>
                  <Link href="/profile" prefetch onClick={guardNav("/profile")}>
                    <UserRoundIcon className="size-4" />
                    Profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() =>
                    authClient.signOut({
                      fetchOptions: {
                        onSuccess: () => {
                          router.push("/login");
                        },
                      },
                    })
                  }
                >
                  <LogOutIcon className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
};
