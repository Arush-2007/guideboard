"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { EditableNodeTitle } from "@/components/editable-node-title";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildCron,
  COMMON_TIMEZONES,
  cronToPreset,
  WEEKDAYS,
} from "@/lib/schedule-presets";
import { useTRPC } from "@/trpc/client";

export type ScheduleTriggerFormValues = {
  cron: string;
  timezone: string;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentNodeId: string;
  onSubmit: (values: ScheduleTriggerFormValues) => void;
  defaultValues?: Partial<ScheduleTriggerFormValues>;
}

type PresetKind = "hourly" | "daily" | "weekly" | "custom";

const resolveBrowserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const formatInZone = (iso: string, timezone: string): string => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(iso).toUTCString();
  }
};

export const ScheduleTriggerDialog = ({
  open,
  onOpenChange,
  currentNodeId,
  onSubmit,
  defaultValues = {},
}: Props) => {
  const trpc = useTRPC();

  const [kind, setKind] = useState<PresetKind>("daily");
  const [minute, setMinute] = useState(0);
  const [hour, setHour] = useState(9);
  const [weekday, setWeekday] = useState(1);
  const [customCron, setCustomCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(resolveBrowserTimezone());

  // Hydrate the form from saved node data each time the dialog opens, mapping a
  // saved cron back onto the matching preset (or "custom").
  useEffect(() => {
    if (!open) return;
    setTimezone(defaultValues.timezone || resolveBrowserTimezone());
    if (defaultValues.cron) {
      const preset = cronToPreset(defaultValues.cron);
      setKind(preset.kind);
      if (preset.kind === "hourly") setMinute(preset.minute);
      if (preset.kind === "daily") {
        setHour(preset.hour);
        setMinute(preset.minute);
      }
      if (preset.kind === "weekly") {
        setWeekday(preset.weekday);
        setHour(preset.hour);
        setMinute(preset.minute);
      }
      setCustomCron(defaultValues.cron);
    }
  }, [open, defaultValues.cron, defaultValues.timezone]);

  const cron = useMemo(() => {
    switch (kind) {
      case "hourly":
        return buildCron({ kind: "hourly", minute });
      case "daily":
        return buildCron({ kind: "daily", hour, minute });
      case "weekly":
        return buildCron({ kind: "weekly", weekday, hour, minute });
      case "custom":
        return customCron.trim();
    }
  }, [kind, minute, hour, weekday, customCron]);

  const preview = useQuery(
    trpc.schedule.preview.queryOptions(
      { cron, timezone },
      { enabled: open && cron.length > 0 },
    ),
  );

  const handleSave = () => {
    if (!preview.data?.valid) return;
    onSubmit({ cron, timezone });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <EditableNodeTitle nodeId={currentNodeId} />
          <DialogDescription>
            Run this workflow automatically on a recurring schedule.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          <RadioGroup
            value={kind}
            onValueChange={(v) => setKind(v as PresetKind)}
            className="gap-2"
          >
            <Label className="flex items-center gap-2 font-normal">
              <RadioGroupItem value="hourly" /> Every hour
            </Label>
            <Label className="flex items-center gap-2 font-normal">
              <RadioGroupItem value="daily" /> Every day
            </Label>
            <Label className="flex items-center gap-2 font-normal">
              <RadioGroupItem value="weekly" /> Every week
            </Label>
            <Label className="flex items-center gap-2 font-normal">
              <RadioGroupItem value="custom" /> Advanced (cron)
            </Label>
          </RadioGroup>

          {kind === "hourly" && (
            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="sched-minute">At minute</Label>
                <Input
                  id="sched-minute"
                  type="number"
                  min={0}
                  max={59}
                  className="w-24"
                  value={minute}
                  onChange={(e) =>
                    setMinute(Number.parseInt(e.target.value, 10) || 0)
                  }
                />
              </div>
              <p className="text-sm text-muted-foreground pb-2">
                past every hour
              </p>
            </div>
          )}

          {(kind === "daily" || kind === "weekly") && (
            <div className="flex flex-wrap items-end gap-2">
              {kind === "weekly" && (
                <div className="space-y-1">
                  <Label>Day</Label>
                  <Select
                    value={String(weekday)}
                    onValueChange={(v) => setWeekday(Number(v))}
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((day, i) => (
                        <SelectItem key={day} value={String(i)}>
                          {day}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="sched-hour">Hour</Label>
                <Input
                  id="sched-hour"
                  type="number"
                  min={0}
                  max={23}
                  className="w-20"
                  value={hour}
                  onChange={(e) =>
                    setHour(Number.parseInt(e.target.value, 10) || 0)
                  }
                />
              </div>
              <span className="pb-2 text-lg">:</span>
              <div className="space-y-1">
                <Label htmlFor="sched-minute-2">Minute</Label>
                <Input
                  id="sched-minute-2"
                  type="number"
                  min={0}
                  max={59}
                  className="w-20"
                  value={minute}
                  onChange={(e) =>
                    setMinute(Number.parseInt(e.target.value, 10) || 0)
                  }
                />
              </div>
            </div>
          )}

          {kind === "custom" && (
            <div className="space-y-1">
              <Label htmlFor="sched-cron">Cron expression</Label>
              <Input
                id="sched-cron"
                placeholder="*/15 9-17 * * 1-5"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Standard 5-field cron (minute hour day-of-month month
                day-of-week).
              </p>
            </div>
          )}

          <div className="space-y-1">
            <Label>Timezone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Ensure the saved/browser zone is selectable even if it's not
                    in the curated list. */}
                {Array.from(new Set([timezone, ...COMMON_TIMEZONES])).map(
                  (tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            {cron.length === 0 ? (
              <span className="text-muted-foreground">
                Enter a schedule above.
              </span>
            ) : preview.isLoading ? (
              <span className="text-muted-foreground">Resolving next run…</span>
            ) : preview.data?.valid ? (
              <div className="space-y-1">
                <p>
                  <span className="text-muted-foreground">Next run: </span>
                  {formatInZone(preview.data.next, timezone)}
                </p>
                <p className="text-xs text-muted-foreground font-mono">
                  {cron}
                </p>
                {preview.data.underFires ? (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    This deployment checks for due schedules every{" "}
                    {preview.data.underFires.pollMinutes} minutes, so a schedule
                    that repeats every {preview.data.underFires.scheduleMinutes}{" "}
                    minutes will only run about every{" "}
                    {preview.data.underFires.pollMinutes} minutes — the slots in
                    between are skipped, not queued. Either widen the schedule
                    or lower POLL_CRON.
                  </p>
                ) : null}
              </div>
            ) : (
              <span className="text-destructive">
                That schedule isn’t valid. Check the cron expression and
                timezone.
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSave} disabled={!preview.data?.valid}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
