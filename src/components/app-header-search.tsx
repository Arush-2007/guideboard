"use client";

import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useGlobalSearch } from "@/hooks/use-global-search";

export const AppHeaderSearch = () => {
  const { value, onChange, isSearchable, placeholder } = useGlobalSearch();

  return (
    <div className="relative ml-1 hidden w-full max-w-sm md:block">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={!isSearchable}
        aria-label="Search"
        className="h-10 rounded-full border-border/80 bg-card/80 pl-9"
      />
    </div>
  );
};
