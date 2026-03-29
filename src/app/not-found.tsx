import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <div className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The page you are looking for does not exist or was moved.
        </p>
      </div>
      <Button asChild>
        <Link href="/workflows">Back to workflows</Link>
      </Button>
    </div>
  );
}
