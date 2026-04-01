"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useQueryState, parseAsString } from "nuqs";

// Executions has no search param — intentionally excluded
const SEARCHABLE_ROUTES = ["/workflows", "/credentials"];

export function useGlobalSearch() {
  const pathname = usePathname();
  const isSearchable = SEARCHABLE_ROUTES.some((r) => pathname.startsWith(r));

  // Matches the exact parser the list pages use so the param is compatible
  const [search, setSearch] = useQueryState(
    "search",
    parseAsString
      .withDefault("")
      .withOptions({ clearOnDefault: true, shallow: false }),
  );

  // Clear search when the user navigates to a different route
  const prevPathname = useRef(pathname);
  useEffect(() => {
    if (prevPathname.current !== pathname) {
      prevPathname.current = pathname;
      void setSearch(null);
    }
  }, [pathname, setSearch]);

  const segment = pathname.split("/")[1];

  return {
    value: search ?? "",
    onChange: (val: string) => setSearch(val || null),
    isSearchable,
    placeholder: isSearchable ? `Search ${segment}...` : "Search...",
  };
}
