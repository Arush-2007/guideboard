import Image from "next/image";
import Link from "next/link";

export const AuthLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,color-mix(in_oklch,var(--primary)_8%,transparent)_0,transparent_36%),radial-gradient(circle_at_100%_0%,color-mix(in_oklch,var(--primary)_6%,transparent)_0,transparent_34%)]" />
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link
          href="/"
          className="relative flex items-center gap-2 self-center rounded-full border border-border/70 bg-card/75 px-4 py-2 text-base font-semibold tracking-tight shadow-sm backdrop-blur"
        >
          <Image
            src="/logos/logo.svg"
            alt="Guideboard"
            width={30}
            height={30}
            unoptimized
          />
          Guideboard
        </Link>
        <div className="relative">{children}</div>
      </div>
    </div>
  );
};
