import { AlertTriangleIcon, Loader2Icon, MoreVerticalIcon, PackageOpenIcon, PlusIcon, SearchIcon, TrashIcon } from "lucide-react";
import { Button } from "./ui/button";
import Link from "next/link";
import { Input } from "./ui/input";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "./ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type EntityHeaderProps = {
  title: string;
  description?: string;
  newButtonLabel?: string;
  disabled?: boolean;
  isCreating?: boolean;
} & (
  | { onNew: () => void; newButtonHref?: never }
  | { newButtonHref: string; onNew?: never }
  | { onNew?: never; newButtonHref?: never }
);

export const EntityHeader = ({
  title,
  description,
  onNew,
  newButtonHref,
  newButtonLabel,
  disabled,
  isCreating,
}: EntityHeaderProps) => {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-3xl border border-border/70 bg-card/90 px-6 py-5 shadow-sm">
      <div className="flex min-w-0 flex-col">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {onNew && !newButtonHref && (
        <Button 
          disabled={isCreating || disabled} 
          size="sm"
          className="rounded-full px-5"
          onClick={onNew}
        >
          <PlusIcon className="size-4" />
          {newButtonLabel}
        </Button>
      )}
      {newButtonHref && !onNew && (
        <Button 
          size="sm" 
          className="rounded-full px-5"
          asChild
        >
          <Link href={newButtonHref} prefetch>
            <PlusIcon className="size-4" />
            {newButtonLabel}
          </Link>
        </Button>
      )}
    </div>
  );
};

type EntityContainerProps = {
  children: React.ReactNode;
  header?: React.ReactNode;
  search?: React.ReactNode;
  pagination?: React.ReactNode;
};

export const EntityContainer = ({
  children,
  header,
  search,
  pagination,
}: EntityContainerProps) => {
  return (
    <div className="h-full">
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-y-6">
        {header}
        <div className="flex h-full flex-col gap-y-4">
          {search}
          {children}
        </div>
        {pagination}
      </div>
    </div>
  )
};

interface EntitySearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

export const EntitySearch = ({
  value,
  onChange,
  placeholder = "Search",
}: EntitySearchProps) => {
  return (
    <div className="relative ml-auto w-full max-w-sm">
      <SearchIcon className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input 
        className="h-11 rounded-full border-border/80 bg-card pl-8 shadow-none"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
};

interface EntityPaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
};

export const EntityPagination = ({
  page,
  totalPages,
  onPageChange,
  disabled,
}: EntityPaginationProps) => {
  return (
    <div className="flex w-full items-center justify-between gap-x-2 rounded-3xl border border-border/70 bg-card/85 px-5">
      <div className="flex-1 text-sm text-muted-foreground">
        Page {page} of {totalPages || 1}
      </div>
        <div className="flex items-center justify-end space-x-2 py-3.5">
        <Button
          disabled={page === 1 || disabled}
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          Previous
        </Button>
        <Button
          disabled={page === totalPages || totalPages === 0 || disabled}
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        >
          Next
        </Button>
      </div>
    </div>
  )
};

interface StateViewProps {
  message?: string;
};

export const LoadingView = ({
  message,
}: StateViewProps) => {
  return (
    <div className="flex justify-center items-center h-full flex-1 flex-col gap-y-4">
      <Loader2Icon className="size-6 animate-spin text-primary" />
      {!!message && (
        <p className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
};


export const ErrorView = ({
  message,
}: StateViewProps) => {
  return (
    <div className="flex justify-center items-center h-full flex-1 flex-col gap-y-4">
      <AlertTriangleIcon className="size-6 text-primary" />
      {!!message && (
        <p className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
};

interface EmptyViewProps extends StateViewProps {
  onNew?: () => void;
};

export const EmptyView = ({
  message,
  onNew
}: EmptyViewProps) => {
  return (
    <Empty className="rounded-3xl border border-dashed border-border/80 bg-card/90">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PackageOpenIcon />
        </EmptyMedia>
      </EmptyHeader>
      <EmptyTitle>
        No items
      </EmptyTitle>
      {!!message && (
        <EmptyDescription>
          {message}
        </EmptyDescription>
      )}
      {!!onNew && (
        <EmptyContent>
          <Button onClick={onNew}>
            Add item
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
};

interface EntityListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  getKey?: (item: T, index: number) => string | number;
  emptyView?: React.ReactNode;
  className?: string;
};

export function EntityList<T>({
  items,
  renderItem,
  getKey,
  emptyView,
  className,
}: EntityListProps<T>) {
  if (items.length === 0 && emptyView) {
    return (
      <div className="flex-1 flex justify-center items-center">
        <div className="max-w-sm mx-auto">{emptyView}</div>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex flex-col gap-y-3.5",
      className,
    )}>
      {items.map((item, index) => (
        <div key={getKey ? getKey(item, index) : index}>
          {renderItem(item, index)}
        </div>
      ))}
    </div>
  );
};

interface EntityItemProps {
  href: string;
  title: string;
  subtitle?: React.ReactNode;
  image?: React.ReactNode;
  actions?: React.ReactNode;
  onRemove?: () => void | Promise<void>;
  isRemoving?: boolean;
  className?: string;
};

export const EntityItem = ({
  href,
  title,
  subtitle,
  image,
  actions,
  onRemove,
  isRemoving,
  className,
}: EntityItemProps) => {
  const handleRemove = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isRemoving) {
      return;
    }

    if (onRemove) {
      await onRemove();
    }
  }

  return (
    <Link href={href} prefetch>
      <Card
        className={cn(
          "cursor-pointer rounded-2xl border-border/70 p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent/35 hover:shadow-md",
          isRemoving && "opacity-50 cursor-not-allowed",
          className,
        )}
      >
        <CardContent className="flex flex-row items-center justify-between p-0">
          <div className="flex min-w-0 items-center gap-3">
            {image}
            <div className="min-w-0">
              <CardTitle className="truncate text-base font-medium">
                {title}
              </CardTitle>
              {!!subtitle && (
                <CardDescription className="truncate text-xs">
                  {subtitle}
                </CardDescription>
              )}
            </div>
          </div>
          {(actions || onRemove) && (
            <div className="flex gap-x-4 items-center">
              {actions}
              {onRemove && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="rounded-full"
                      onClick={(e) => e.stopPropagation()} 
                    >
                      <MoreVerticalIcon className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DropdownMenuItem onClick={handleRemove}>
                      <TrashIcon className="size-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  )
};
