"use client"
import { CalendarIcon } from "lucide-react"
import { format } from "date-fns"
import type { DateRange } from "react-day-picker"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface DatePickerWithRangeProps {
  date: DateRange | undefined
  onDateChange: (date: DateRange | undefined) => void
  className?: string
}

export function DatePickerWithRange({ date, onDateChange, className }: DatePickerWithRangeProps) {
  // Handle date selection with 7-day max range enforcement
  const handleDateSelect = (range: DateRange | undefined) => {
    if (range?.from && range?.to) {
      const diffDays = Math.ceil((range.to.getTime() - range.from.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays > 7) {
        // Auto-adjust to 7 days max from start date
        range.to = new Date(range.from.getTime() + 6 * 24 * 60 * 60 * 1000);
      }
    }
    onDateChange(range);
  };

  // Disable future dates
  const disabledDays = { after: new Date() };

  return (
    <div className={cn("grid gap-2", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id="date"
            variant={"outline"}
            className={cn("w-[300px] justify-start text-left font-normal", !date && "text-muted-foreground")}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {date?.from ? (
              date.to ? (
                <>
                  {format(date.from, "LLL dd, y")} - {format(date.to, "LLL dd, y")}
                </>
              ) : (
                format(date.from, "LLL dd, y")
              )
            ) : (
              <span>Pick a date range</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            initialFocus
            mode="range"
            defaultMonth={date?.from || new Date()}
            selected={date}
            onSelect={handleDateSelect}
            numberOfMonths={1}
            disabled={disabledDays}
            endMonth={new Date()}
          />
          <div className="p-2 text-xs text-muted-foreground border-t">
            Max 7 days range
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
