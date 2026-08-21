"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** A dropdown filter with a built-in "<placeholder>: All" reset option.
 *  Shared between Scale Sentinel and Network Pulse's filter bars — moved
 *  here once a second page needed the exact same control. */
export function FilterSelect({
    value,
    onChange,
    placeholder,
    options,
}: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    options: [string, string][];
}) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className="w-44">
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="all">{placeholder}: All</SelectItem>
                {options.map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                        {label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
