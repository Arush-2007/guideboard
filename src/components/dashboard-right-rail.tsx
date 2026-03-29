import Link from "next/link";
import { ActivityIcon, Clock3Icon, SparklesIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const DashboardRightRail = () => {
  return (
    <aside className="sticky top-20 hidden h-fit w-[300px] shrink-0 space-y-4 xl:block">
      <Card className="border-border/70 bg-card/90 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <SparklesIcon className="size-4 text-primary" />
            Guideboard Tips
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>Create reusable credentials once, then attach them to multiple nodes.</p>
          <p>Run workflows from the editor and inspect each execution in the history page.</p>
        </CardContent>
      </Card>

      <Card className="border-border/70 bg-card/90 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Quick Access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Link href="/workflows" className="block rounded-lg px-2.5 py-2 transition-colors hover:bg-accent/70">
            Workflows
          </Link>
          <Link href="/credentials" className="block rounded-lg px-2.5 py-2 transition-colors hover:bg-accent/70">
            Credentials
          </Link>
          <Link href="/executions" className="block rounded-lg px-2.5 py-2 transition-colors hover:bg-accent/70">
            Executions
          </Link>
        </CardContent>
      </Card>

      <Card className="border-border/70 bg-card/90 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2">
            <ActivityIcon className="size-3.5 text-primary" />
            All services operational
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2">
            <Clock3Icon className="size-3.5 text-primary" />
            Realtime updates enabled
          </div>
        </CardContent>
      </Card>
    </aside>
  );
};
